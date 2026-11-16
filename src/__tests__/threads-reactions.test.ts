import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { actor, build, mentionDoc, text, user } from './helpers.js';

async function setup(members: number[] = [2, 3]) {
  const b = build();
  const id = (await b.conversations.create(actor(1), { kind: 'channel', name: `c-${randomUUID().slice(0, 6)}`, userIds: members.map(user) })).conversation.conversation.id;
  const root = (await b.messages.send(actor(1), id, { clientMsgId: randomUUID(), bodyDoc: text('¿Quién revisa el informe?') })).message;
  return { ...b, id, root };
}
const reply = (b: Awaited<ReturnType<typeof setup>>, who: number, t: string) =>
  b.messages.send(actor(who), b.id, { clientMsgId: randomUUID(), bodyDoc: text(t), threadRootId: b.root.id });

describe('hilos', () => {
  it('las respuestas se numeran dentro del hilo y la raíz lleva el contador y las últimas caras', async () => {
    const b = await setup();
    const r = await Promise.all([reply(b, 2, 'yo'), reply(b, 3, 'yo también'), reply(b, 2, 'listo')]);
    expect(r.map((x) => x.message.threadSeq).sort()).toEqual([1, 2, 3]);
    expect(r.every((x) => x.message.seq === null)).toBe(true);
    const page = await b.messages.replies(actor(3), b.root.id, { limit: 50 });
    expect(page.root.replyCount).toBe(3);
    expect(page.root.replyUserIds.length).toBeLessThanOrEqual(3);
    expect(page.items.map((m) => m.threadSeq)).toEqual([1, 2, 3]);
  });

  it('un hilo no deja el canal sin leer ni mueve su último mensaje', async () => {
    const b = await setup();
    await b.conversations.markRead(actor(2), b.id, 1);
    const before = (await b.conversations.get(actor(2), b.id)).conversation;
    await reply(b, 3, 'respuesta');
    const after = await b.conversations.get(actor(2), b.id);
    expect(after.unreadCount).toBe(0);
    expect(after.conversation.messageSeq).toBe(before.messageSeq);
  });

  it('avisa a quien sigue el hilo (el autor de la raíz y quien respondió), no a todo el canal', async () => {
    const b = await setup([2, 3, 4]);
    await reply(b, 2, 'primera');
    await reply(b, 3, 'segunda');
    const events = b.store.events('chat.message.created').filter((e) => e.payload.threadRootId === b.root.id);
    expect(events[0].payload.notifyUserIds).toEqual([user(1)]);
    expect((events[1].payload.notifyUserIds as string[]).sort()).toEqual([user(1), user(2)].sort());
    expect(events[1].payload.memberUserIds).toContain(user(4)); // le llega por socket (contador del hilo), sin aviso
  });

  it('responder a una respuesta o a un mensaje de otra conversación: 422', async () => {
    const b = await setup();
    const { message } = await reply(b, 2, 'x');
    await expect(b.messages.send(actor(2), b.id, { clientMsgId: randomUUID(), bodyDoc: text('y'), threadRootId: message.id })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });
});

describe('editar y borrar', () => {
  it('solo el autor edita; queda editedAt y el evento no lleva el texto', async () => {
    const b = await setup();
    await expect(b.messages.edit(actor(2), b.root.id, text('otra cosa'))).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const m = await b.messages.edit(actor(1), b.root.id, text('¿Quién revisa el informe de noviembre?'));
    expect(m.bodyText).toContain('noviembre');
    expect(m.editedAt).not.toBeNull();
    const [e] = b.store.events('chat.message.updated');
    expect(JSON.stringify(e.payload)).not.toContain('noviembre');
  });

  it('borrar deja la lápida sin texto; chat:admin borra en un canal pero no en un DM', async () => {
    const b = await setup();
    const own = (await reply(b, 2, 'me equivoqué')).message;
    await expect(b.messages.remove(actor(3), own.id)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await b.messages.remove(actor(4, { admin: true }), b.root.id); // no es miembro, pero el canal es público: puede leerlo y borrar
    const root = await b.messages.get(actor(2), b.root.id);
    expect(root.deletedAt).not.toBeNull();
    expect(root.bodyDoc).toBeNull();
    expect(b.store.events('chat.message.deleted')[0].payload).toMatchObject({ byAdmin: true });
    // La respuesta sigue colgando de la lápida.
    expect((await b.messages.replies(actor(2), b.root.id, { limit: 10 })).items).toHaveLength(1);

    const dm = (await b.conversations.create(actor(1), { kind: 'dm', userIds: [user(2)] })).conversation.conversation.id;
    const dmMsg = (await b.messages.send(actor(1), dm, { clientMsgId: randomUUID(), bodyDoc: text('privado') })).message;
    await expect(b.messages.remove(actor(5, { admin: true }), dmMsg.id)).rejects.toMatchObject({ code: 'MESSAGE_NOT_FOUND' });
  });

  it('editar o vaciar: un documento vacío es 422 (para quitarlo se borra)', async () => {
    const b = await setup();
    await expect(b.messages.edit(actor(1), b.root.id, { type: 'doc', content: [{ type: 'paragraph' }] })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });
});

describe('reacciones', () => {
  it('idempotentes: diez «👍» a la vez de la misma persona son uno, con un solo evento', async () => {
    const b = await setup();
    await Promise.all(Array.from({ length: 10 }, () => b.messages.react(actor(2), b.root.id, '👍', true)));
    const groups = await b.messages.react(actor(3), b.root.id, '👍', true);
    expect(groups).toEqual([{ emoji: '👍', userIds: [user(2), user(3)] }]);
    expect(b.store.events('chat.reaction.added')).toHaveLength(2);
    await b.messages.react(actor(2), b.root.id, '👍', false);
    await b.messages.react(actor(2), b.root.id, '👍', false);
    expect(b.store.events('chat.reaction.removed')).toHaveLength(1);
  });

  it('el evento va a los demás miembros (no a quien reacciona: su pestaña ya lo sabe por la respuesta)', async () => {
    const b = await setup();
    await b.messages.react(actor(2), b.root.id, '🎉', true);
    expect(b.store.events('chat.reaction.added')[0].payload.memberUserIds).toEqual([user(1), user(3)]);
  });

  it('texto o espacios no son una reacción; un mensaje borrado no se reacciona', async () => {
    const b = await setup();
    await expect(b.messages.react(actor(2), b.root.id, 'hola', true)).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await b.messages.remove(actor(1), b.root.id);
    await expect(b.messages.react(actor(2), b.root.id, '👍', true)).rejects.toMatchObject({ code: 'MESSAGE_NOT_FOUND' });
  });

  it('mención en un hilo: avisa al mencionado aunque no siga el hilo', async () => {
    const b = await setup([2, 3]);
    await b.messages.send(actor(2), b.id, { clientMsgId: randomUUID(), bodyDoc: mentionDoc(user(3), 'Carla', ' mira esto'), threadRootId: b.root.id });
    const e = b.store.events('chat.message.created').at(-1)!;
    expect(e.payload.userIds).toEqual([user(3)]);
  });
});
