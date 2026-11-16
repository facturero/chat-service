import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { actor, build, mentionDoc, text, user } from './helpers.js';

/** Canal con Lucía (1) dueña y 2, 3 y 4; Lucía escribe la raíz. */
async function setup(opts: { visibility?: 'public' | 'private' } = {}) {
  const b = build();
  const id = (await b.conversations.create(actor(1), { kind: 'channel', name: `h-${randomUUID().slice(0, 6)}`, visibility: opts.visibility, userIds: [user(2), user(3), user(4)] })).conversation.conversation.id;
  const root = (await b.messages.send(actor(1), id, { clientMsgId: randomUUID(), bodyDoc: text('¿Quién cierra la caja?') })).message;
  const reply = (who: number, doc: unknown = text(`respuesta de ${who}`)) => b.messages.send(actor(who), id, { clientMsgId: randomUUID(), bodyDoc: doc, threadRootId: root.id });
  return { ...b, id, root, reply };
}
const view = (b: ReturnType<typeof build>, who: number) => b.messages.threads(actor(who), { limit: 20 });
const totals = async (b: ReturnType<typeof build>, who: number) => (await b.conversations.unread(actor(who))).threads;

describe('vista «Hilos»', () => {
  it('lista los hilos que sigo (autor de la raíz, quien respondió, mencionado), no los ajenos', async () => {
    const b = await setup();
    await b.reply(2);
    await b.reply(3, mentionDoc(user(4), 'Eva', ' ¿lo ves?'));
    expect((await view(b, 1)).items.map((x) => x.root.id)).toEqual([b.root.id]);
    expect((await view(b, 2)).items).toHaveLength(1);
    expect((await view(b, 4)).items).toHaveLength(1); // mencionada
    const outsider = build();
    expect((await outsider.messages.threads(actor(5), { limit: 20 })).items).toHaveLength(0);
    const item = (await view(b, 1)).items[0];
    expect(item.latestReplies.map((m) => m.threadSeq)).toEqual([1, 2]);
  });

  it('cuenta respuestas nuevas y menciones; lo mío no cuenta y responder avanza mi cursor', async () => {
    const b = await setup();
    await b.reply(2);
    await b.reply(3, mentionDoc(user(1), 'Lucía', ' mira'));
    let lucia = (await view(b, 1)).items[0];
    expect([lucia.unreadCount, lucia.mentionCount]).toEqual([2, 1]);
    expect(await totals(b, 1)).toEqual({ unread: 1, mentions: 1 });
    await b.reply(1, text('yo la cierro'));
    lucia = (await view(b, 1)).items[0];
    expect([lucia.unreadCount, lucia.mentionCount, lucia.lastReadThreadSeq]).toEqual([0, 0, 3]);
    expect(await totals(b, 1)).toEqual({ unread: 0, mentions: 0 });
    // Las menciones en hilos no suman al contador del canal (siguen aparte).
    expect((await b.conversations.unread(actor(1))).mentions).toBe(0);
  });

  it('marcar leído: avanza, nunca retrocede ni pasa de la última respuesta; sin seguir el hilo no cambia nada', async () => {
    const b = await setup();
    await b.reply(2);
    await b.reply(3);
    expect(await b.messages.markThreadRead(actor(1), b.root.id, 1)).toEqual({ lastReadThreadSeq: 1, unreadCount: 1, mentionCount: 0 });
    expect((await b.messages.markThreadRead(actor(1), b.root.id, 0)).lastReadThreadSeq).toBe(1);
    expect((await b.messages.markThreadRead(actor(1), b.root.id, 999)).lastReadThreadSeq).toBe(2);
    expect((await b.messages.markThreadRead(actor(4), b.root.id, 2)).lastReadThreadSeq).toBeNull(); // no lo sigue
    await expect(b.messages.markThreadRead(actor(1), (await b.reply(2)).message.id, 1)).rejects.toMatchObject({ httpStatus: 404 }); // no es raíz
  });

  it('silenciado: el hilo no suma a «nuevos», pero una mención sí; quien sale de un privado deja de ver sus hilos', async () => {
    const b = await setup({ visibility: 'private' });
    await b.reply(2);
    await b.conversations.setPreferences(actor(1), b.id, { muted: true });
    expect(await totals(b, 1)).toEqual({ unread: 0, mentions: 0 });
    await b.reply(3, mentionDoc(user(1), 'Lucía', ' urgente'));
    expect(await totals(b, 1)).toEqual({ unread: 0, mentions: 1 });

    await b.conversations.removeMember(actor(2), b.id, user(2)); // 2 sale del privado
    expect((await view(b, 2)).items).toHaveLength(0);
    expect(await totals(b, 2)).toEqual({ unread: 0, mentions: 0 });
  });

  it('pagina por cursor, el de respuesta más reciente primero', async () => {
    const b = build();
    const id = (await b.conversations.create(actor(1), { kind: 'channel', name: 'pag', userIds: [user(2)] })).conversation.conversation.id;
    const roots = [];
    for (let i = 0; i < 3; i++) {
      const r = (await b.messages.send(actor(1), id, { clientMsgId: randomUUID(), bodyDoc: text(`raíz ${i}`) })).message;
      await b.messages.send(actor(2), id, { clientMsgId: randomUUID(), bodyDoc: text('ok'), threadRootId: r.id });
      roots.push(r.id);
    }
    const p1 = await b.messages.threads(actor(1), { limit: 2 });
    expect(p1.items).toHaveLength(2);
    const p2 = await b.messages.threads(actor(1), { limit: 2, cursor: p1.nextCursor! });
    expect(p2.items).toHaveLength(1);
    expect(p2.nextCursor).toBeNull();
    expect(new Set([...p1.items, ...p2.items].map((x) => x.root.id))).toEqual(new Set(roots));
  });
});
