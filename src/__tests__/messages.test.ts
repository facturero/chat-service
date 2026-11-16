import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { actor, build, mentionDoc, text, user } from './helpers.js';

async function channel(b: ReturnType<typeof build>, members: number[] = [2, 3]) {
  return (await b.conversations.create(actor(1), { kind: 'channel', name: `c-${randomUUID().slice(0, 6)}`, userIds: members.map(user) })).conversation.conversation.id;
}

describe('enviar', () => {
  it('30 envíos a la vez salen con seq 1..30, sin huecos ni repetidos', async () => {
    const b = build();
    const id = await channel(b);
    const sent = await Promise.all(Array.from({ length: 30 }, (_, i) => b.messages.send(actor(1 + (i % 3)), id, { clientMsgId: randomUUID(), bodyDoc: text(`m${i}`) })));
    expect(sent.map((s) => s.message.seq).sort((a, b2) => a! - b2!)).toEqual(Array.from({ length: 30 }, (_, i) => i + 1));
    expect((await b.conversations.get(actor(1), id)).conversation.messageSeq).toBe(30);
  });

  it('reenviar con el mismo clientMsgId devuelve el mismo mensaje (un solo mensaje y un solo evento)', async () => {
    const b = build();
    const id = await channel(b);
    const clientMsgId = randomUUID();
    const r = await Promise.all([1, 2, 3].map(() => b.messages.send(actor(1), id, { clientMsgId, bodyDoc: text('hola') })));
    expect(new Set(r.map((x) => x.message.id)).size).toBe(1);
    expect(b.store.events('chat.message.created')).toHaveLength(1);
  });

  it('escribir en un canal público sin ser miembro te une primero', async () => {
    const b = build();
    const id = await channel(b, []);
    const { message } = await b.messages.send(actor(4), id, { clientMsgId: randomUUID(), bodyDoc: text('me sumo') });
    expect(message.seq).toBe(1);
    expect((await b.conversations.get(actor(4), id)).isMember).toBe(true);
  });

  it('vacío o con elementos no permitidos: 422', async () => {
    const b = build();
    const id = await channel(b);
    await expect(b.messages.send(actor(1), id, { clientMsgId: randomUUID(), bodyDoc: { type: 'doc', content: [{ type: 'paragraph' }] } })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(b.messages.send(actor(1), id, { clientMsgId: randomUUID(), bodyDoc: { type: 'doc', content: [{ type: 'script' }] } })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('DM con alguien desactivado: solo lectura (409)', async () => {
    const b = build();
    const dm = (await b.conversations.create(actor(1), { kind: 'dm', userIds: [user(2)] })).conversation.conversation.id;
    await b.conversations.onUserDisabled(b.store.state.conversations.get(dm)!.organizationId, user(2));
    await expect(b.messages.send(actor(1), dm, { clientMsgId: randomUUID(), bodyDoc: text('¿sigues?') })).rejects.toMatchObject({ code: 'USER_INACTIVE' });
  });

  it('más de N mensajes por minuto: 429 (el reintento del mismo mensaje no gasta cupo)', async () => {
    const b = build({ rate: 2 });
    const id = await channel(b);
    const same = randomUUID();
    await b.messages.send(actor(1), id, { clientMsgId: same, bodyDoc: text('1') });
    await b.messages.send(actor(1), id, { clientMsgId: same, bodyDoc: text('1') });
    await b.messages.send(actor(1), id, { clientMsgId: randomUUID(), bodyDoc: text('2') });
    await expect(b.messages.send(actor(1), id, { clientMsgId: randomUUID(), bodyDoc: text('3') })).rejects.toMatchObject({ code: 'RATE_LIMITED' });
  });
});

describe('eventos (regla 10: nunca el texto)', () => {
  it('chat.message.created lleva ids y destinatarios, pero ni el texto ni el documento', async () => {
    const b = build();
    const id = await channel(b);
    await b.messages.send(actor(1), id, { clientMsgId: randomUUID(), bodyDoc: text('secreto de la empresa') });
    const [e] = b.store.events('chat.message.created');
    const raw = JSON.stringify(e.payload);
    expect(raw).not.toContain('secreto');
    expect(e.payload).not.toHaveProperty('bodyDoc');
    expect(e.payload).not.toHaveProperty('bodyText');
    expect(e.payload).toMatchObject({ conversationId: id, seq: 1, senderId: user(1), memberUserIds: [user(2), user(3)] });
    expect(e.payload.organizationId).toBeTruthy();
  });

  it('mención directa: navegador y campana para el mencionado; el resto del canal solo socket', async () => {
    const b = build();
    const id = await channel(b);
    await b.messages.send(actor(1), id, { clientMsgId: randomUUID(), bodyDoc: mentionDoc(user(2), 'Ana') });
    const [e] = b.store.events('chat.message.created');
    expect(e.payload).toMatchObject({ notifyUserIds: [user(2)], userIds: [user(2)], mentionUserIds: [user(2)] });
    expect((await b.conversations.get(actor(2), id)).mentionCount).toBe(1);
    expect((await b.conversations.get(actor(3), id)).mentionCount).toBe(0);
  });

  it('mencionar a alguien que no está en el canal no le avisa (no puede verlo)', async () => {
    const b = build();
    const id = await channel(b, [2]);
    await b.messages.send(actor(1), id, { clientMsgId: randomUUID(), bodyDoc: mentionDoc(user(5)) });
    expect(b.store.events('chat.message.created')[0].payload).toMatchObject({ userIds: [], mentionUserIds: [] });
  });

  it('DM: campana y navegador para la otra persona', async () => {
    const b = build();
    const dm = (await b.conversations.create(actor(1), { kind: 'dm', userIds: [user(2)] })).conversation.conversation.id;
    await b.messages.send(actor(1), dm, { clientMsgId: randomUUID(), bodyDoc: text('hola') });
    expect(b.store.events('chat.message.created')[0].payload).toMatchObject({ userIds: [user(2)], notifyUserIds: [user(2)], conversationName: null });
  });
});

describe('leer', () => {
  it('paginación por seq: últimos, antes, después y alrededor de un mensaje', async () => {
    const b = build();
    const id = await channel(b);
    const ids: string[] = [];
    for (let i = 1; i <= 10; i += 1) ids.push((await b.messages.send(actor(1), id, { clientMsgId: randomUUID(), bodyDoc: text(`m${i}`) })).message.id);
    const last = await b.messages.list(actor(2), id, { limit: 4 });
    expect(last.items.map((m) => m.seq)).toEqual([7, 8, 9, 10]);
    expect(last).toMatchObject({ hasOlder: true, hasNewer: false, lastReadSeq: 0 });
    expect((await b.messages.list(actor(2), id, { before: 7, limit: 3 })).items.map((m) => m.seq)).toEqual([4, 5, 6]);
    expect((await b.messages.list(actor(2), id, { after: 8, limit: 5 })).items.map((m) => m.seq)).toEqual([9, 10]);
    expect((await b.messages.list(actor(2), id, { around: ids[4], limit: 4 })).items.map((m) => m.seq)).toEqual([3, 4, 5, 6, 7]);
  });

  it('un mensaje de un canal privado ajeno es 404', async () => {
    const b = build();
    const id = (await b.conversations.create(actor(1), { kind: 'channel', name: 'privado', visibility: 'private' })).conversation.conversation.id;
    const { message } = await b.messages.send(actor(1), id, { clientMsgId: randomUUID(), bodyDoc: text('x') });
    await expect(b.messages.get(actor(2), message.id)).rejects.toMatchObject({ code: 'MESSAGE_NOT_FOUND' });
    await expect(b.messages.list(actor(2), id, { limit: 10 })).rejects.toMatchObject({ code: 'CONVERSATION_NOT_FOUND' });
  });
});
