import { describe, expect, it } from 'vitest';
import { actor, build, OTHER_ORG, ORG, text, user } from './helpers.js';

describe('#general', () => {
  it('se crea solo, una vez, con todo el equipo activo, aunque lleguen dos primeras visitas a la vez', async () => {
    const { conversations, store } = build();
    await Promise.all([conversations.list(actor(1)), conversations.list(actor(2))]);
    const generals = [...store.state.conversations.values()].filter((c) => c.isGeneral);
    expect(generals).toHaveLength(1);
    expect(await store.repos.members.count(generals[0].id)).toBe(5);
    expect(store.events('chat.conversation.created')).toHaveLength(1);
  });

  it('quien llegó después de crearse entra al abrir la mensajería', async () => {
    const { conversations, directory, store } = build();
    await conversations.list(actor(1));
    directory.team[ORG].push(user(6));
    const list = await conversations.list(actor(6));
    expect(list.map((v) => v.conversation.name)).toContain('general');
    expect(store.events('chat.member.joined').at(-1)?.payload.reason).toBe('onboarding');
  });

  it('nadie sale de #general ni se archiva', async () => {
    const { conversations } = build();
    const [general] = await conversations.list(actor(1));
    await expect(conversations.removeMember(actor(2), general.conversation.id, user(2))).rejects.toMatchObject({ code: 'GENERAL_IS_MANDATORY' });
    await expect(conversations.setArchived(actor(1), general.conversation.id, true)).rejects.toMatchObject({ code: 'GENERAL_IS_MANDATORY' });
  });
});

describe('canales', () => {
  it('nombre al estilo Slack y único sin distinguir tildes: «Diseño Web» y «diseno-web» chocan', async () => {
    const { conversations } = build();
    const { conversation } = await conversations.create(actor(1), { kind: 'channel', name: 'Diseño Web' });
    expect(conversation.conversation.name).toBe('diseño-web');
    expect(conversation.me?.role).toBe('owner');
    await expect(conversations.create(actor(2), { kind: 'channel', name: 'diseno-web' })).rejects.toMatchObject({ code: 'NAME_TAKEN' });
    await expect(conversations.create(actor(2), { kind: 'channel', name: 'General' })).rejects.toMatchObject({ code: 'NAME_TAKEN' });
    await expect(conversations.create(actor(2), { kind: 'channel', name: '###' })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('un canal privado es 404 para quien no es miembro, aunque sea chat:admin; no sale en Explorar', async () => {
    const { conversations } = build();
    const { conversation } = await conversations.create(actor(1), { kind: 'channel', name: 'gerencia', visibility: 'private' });
    const id = conversation.conversation.id;
    await expect(conversations.get(actor(2), id)).rejects.toMatchObject({ code: 'CONVERSATION_NOT_FOUND' });
    await expect(conversations.get(actor(3, { admin: true }), id)).rejects.toMatchObject({ code: 'CONVERSATION_NOT_FOUND' });
    await expect(conversations.join(actor(2), id)).rejects.toMatchObject({ code: 'CONVERSATION_NOT_FOUND' });
    expect((await conversations.browse(actor(2), null, false)).map((l) => l.conversation.name)).not.toContain('gerencia');
    expect((await conversations.browse(actor(1), null, false)).map((l) => l.conversation.name)).toContain('gerencia');
  });

  it('un canal público se ve sin ser miembro y unirse es idempotente', async () => {
    const { conversations, store } = build();
    const { conversation } = await conversations.create(actor(1), { kind: 'channel', name: 'ventas' });
    const id = conversation.conversation.id;
    const seen = await conversations.get(actor(2), id);
    expect(seen.isMember).toBe(false);
    expect(seen.me).toBeNull();
    await Promise.all([conversations.join(actor(2), id), conversations.join(actor(2), id), conversations.join(actor(2), id)]);
    expect(await store.repos.members.count(id)).toBe(2);
    expect(store.events('chat.member.joined').filter((e) => e.payload.conversationId === id)).toHaveLength(1);
  });

  it('solo el dueño o chat:admin renombran, archivan o quitan a otros; salir uno mismo siempre se puede', async () => {
    const { conversations } = build();
    const { conversation } = await conversations.create(actor(1), { kind: 'channel', name: 'soporte', userIds: [user(2), user(3)] });
    const id = conversation.conversation.id;
    await expect(conversations.update(actor(2), id, { name: 'otro' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(conversations.removeMember(actor(2), id, user(3))).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect((await conversations.update(actor(4, { admin: true }), id, { topic: 'Pedidos de clientes' })).conversation.topic).toBe('Pedidos de clientes');
    await conversations.removeMember(actor(2), id, user(2));
    await conversations.removeMember(actor(1), id, user(3));
    expect((await conversations.members(actor(1), id)).map((m) => m.userId)).toEqual([user(1)]);
  });

  it('archivado: solo lectura', async () => {
    const { conversations, messages } = build();
    const { conversation } = await conversations.create(actor(1), { kind: 'channel', name: 'viejo' });
    const id = conversation.conversation.id;
    await conversations.setArchived(actor(1), id, true);
    await expect(messages.send(actor(1), id, { clientMsgId: crypto.randomUUID(), bodyDoc: text('hola') })).rejects.toMatchObject({ code: 'CONVERSATION_ARCHIVED' });
    await expect(conversations.join(actor(2), id)).rejects.toMatchObject({ code: 'CONVERSATION_ARCHIVED' });
    expect((await conversations.list(actor(1), false)).map((v) => v.conversation.id)).not.toContain(id);
    expect((await conversations.list(actor(1), true)).map((v) => v.conversation.id)).toContain(id);
  });

  it('solo se suman miembros activos de la organización (un id inventado o de otra empresa no entra)', async () => {
    const { conversations } = build();
    await expect(conversations.create(actor(1), { kind: 'channel', name: 'x', userIds: [user(90)] })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });
});

describe('mensajes directos', () => {
  it('abrir el mismo DM diez veces a la vez da una sola conversación', async () => {
    const { conversations, store } = build();
    const results = await Promise.all(Array.from({ length: 10 }, (_, i) => conversations.create(actor(i % 2 ? 1 : 2), { kind: 'dm', userIds: [user(i % 2 ? 2 : 1)] })));
    expect(new Set(results.map((r) => r.conversation.conversation.id)).size).toBe(1);
    expect(results.filter((r) => !r.existed)).toHaveLength(1);
    expect([...store.state.conversations.values()].filter((c) => c.kind === 'dm')).toHaveLength(1);
  });

  it('un DM es 404 para terceros, incluso chat:admin, y de él no se sale', async () => {
    const { conversations } = build();
    const { conversation } = await conversations.create(actor(1), { kind: 'dm', userIds: [user(2)] });
    const id = conversation.conversation.id;
    await expect(conversations.get(actor(3, { admin: true }), id)).rejects.toMatchObject({ code: 'CONVERSATION_NOT_FOUND' });
    await expect(conversations.removeMember(actor(1), id, user(1))).rejects.toMatchObject({ code: 'NOT_APPLICABLE' });
    expect(conversation.participantUserIds).toEqual([user(2)]);
  });

  it('grupo: 2 a 8 personas además de quien lo abre', async () => {
    const { conversations } = build();
    await expect(conversations.create(actor(1), { kind: 'group_dm', userIds: [user(2)] })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    const g = await conversations.create(actor(1), { kind: 'group_dm', userIds: [user(2), user(3)] });
    expect(g.conversation.participantUserIds.sort()).toEqual([user(2), user(3)]);
  });
});

describe('aislamiento entre organizaciones', () => {
  it('una conversación de otra organización es 404 y no aparece en sus listas', async () => {
    const { conversations } = build();
    const { conversation } = await conversations.create(actor(1), { kind: 'channel', name: 'ventas' });
    await expect(conversations.get(actor(90, { org: OTHER_ORG }), conversation.conversation.id)).rejects.toMatchObject({ code: 'CONVERSATION_NOT_FOUND' });
    expect((await conversations.browse(actor(90, { org: OTHER_ORG }), null, false)).map((l) => l.conversation.name)).toEqual(['general']);
  });
});

describe('leído, no leídos y preferencias', () => {
  it('el cursor solo avanza, no pasa del último mensaje y los contadores bajan al leer', async () => {
    const { conversations, messages, store } = build();
    const { conversation } = await conversations.create(actor(1), { kind: 'channel', name: 'equipo', userIds: [user(2)] });
    const id = conversation.conversation.id;
    for (let i = 0; i < 3; i += 1) await messages.send(actor(1), id, { clientMsgId: crypto.randomUUID(), bodyDoc: text(`m${i}`) });
    expect((await conversations.get(actor(2), id)).unreadCount).toBe(3);
    expect((await conversations.get(actor(1), id)).unreadCount).toBe(0); // los propios no cuentan
    expect(await conversations.markRead(actor(2), id, 2)).toMatchObject({ lastReadSeq: 2, unreadCount: 1 });
    expect(await conversations.markRead(actor(2), id, 1)).toMatchObject({ lastReadSeq: 2 }); // no retrocede
    expect(await conversations.markRead(actor(2), id, 99)).toMatchObject({ lastReadSeq: 3, unreadCount: 0 });
    expect(store.events('chat.conversation.read').map((e) => e.payload.lastReadSeq)).toEqual([2, 3]);
  });

  it('/unread: silenciados fuera del recuento; menciones y DMs suman', async () => {
    const { conversations, messages } = build();
    const ch = (await conversations.create(actor(1), { kind: 'channel', name: 'ruido', userIds: [user(2)] })).conversation.conversation.id;
    const dm = (await conversations.create(actor(1), { kind: 'dm', userIds: [user(2)] })).conversation.conversation.id;
    await messages.send(actor(1), ch, { clientMsgId: crypto.randomUUID(), bodyDoc: text('hola a todos') });
    await messages.send(actor(1), dm, { clientMsgId: crypto.randomUUID(), bodyDoc: text('¿tienes un minuto?') });
    await conversations.setPreferences(actor(2), ch, { muted: true });
    const inbox = await conversations.unread(actor(2));
    expect(inbox.conversations).toBe(1);
    expect(inbox.mentions).toBe(1);
    expect(inbox.latest.map((l) => l.view.conversation.id).sort()).toEqual([ch, dm].sort());
  });
});
