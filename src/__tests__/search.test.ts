import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { actor, build, text, user } from './helpers.js';
import { booleanQuery, searchTerms, shortTerms, snippet } from '../domain/search.js';

const send = (b: ReturnType<typeof build>, who: number, id: string, t: string) =>
  b.messages.send(actor(who), id, { clientMsgId: randomUUID(), bodyDoc: text(t) });

describe('búsqueda: qué se puede leer', () => {
  it('encuentra en mis conversaciones y en canales públicos, nunca en un DM o un privado ajeno (ni siendo chat:admin)', async () => {
    const b = build();
    const pub = (await b.conversations.create(actor(1), { kind: 'channel', name: 'ventas', userIds: [] })).conversation.conversation.id;
    const priv = (await b.conversations.create(actor(1), { kind: 'channel', name: 'gerencia', visibility: 'private', userIds: [user(2)] })).conversation.conversation.id;
    const dm = (await b.conversations.create(actor(1), { kind: 'dm', userIds: [user(2)] })).conversation.conversation.id;
    await send(b, 1, pub, 'La factura de Clínica Vida está lista');
    await send(b, 1, priv, 'Factura confidencial del banco');
    await send(b, 2, dm, 'Te paso la factura por aquí');

    const mine = await b.messages.search(actor(2), { q: 'factura', limit: 20 });
    expect(mine.items).toHaveLength(3);
    const outsider = await b.messages.search(actor(3, { admin: true }), { q: 'factura', limit: 20 });
    expect(outsider.items.map((h) => h.conversation.id)).toEqual([pub]);
  });

  it('prefijo, varias palabras obligatorias, palabras cortas, sin borrados; resultados con trozo del texto', async () => {
    const b = build();
    const id = (await b.conversations.create(actor(1), { kind: 'channel', name: 'ops', userIds: [user(2)] })).conversation.conversation.id;
    await send(b, 1, id, 'Revisar facturas de octubre en el SRI');
    await send(b, 2, id, 'Facturas de noviembre');
    const gone = (await send(b, 2, id, 'facturas de octubre (borrar)')).message;
    await b.messages.remove(actor(2), gone.id);

    expect((await b.messages.search(actor(1), { q: 'factu octubre', limit: 20 })).items.map((h) => h.message.bodyText)).toEqual(['Revisar facturas de octubre en el SRI']);
    expect((await b.messages.search(actor(1), { q: 'en sri', limit: 20 })).items).toHaveLength(1);
    const hit = (await b.messages.search(actor(1), { q: 'noviembre', limit: 20 })).items[0];
    expect(hit.snippet).toBe('Facturas de noviembre');
    expect((await b.messages.search(actor(1), { q: 'facturas', fromUserId: user(2), limit: 20 })).items).toHaveLength(1);
  });

  it('pagina por cursor, más recientes primero', async () => {
    const b = build();
    const id = (await b.conversations.create(actor(1), { kind: 'channel', name: 'log', userIds: [] })).conversation.conversation.id;
    for (let i = 0; i < 5; i++) await send(b, 1, id, `pedido número ${i}`);
    const p1 = await b.messages.search(actor(1), { q: 'pedido', limit: 3 });
    expect(p1.items).toHaveLength(3);
    expect(p1.nextCursor).not.toBeNull();
    const p2 = await b.messages.search(actor(1), { q: 'pedido', limit: 3, cursor: p1.nextCursor! });
    expect(p2.items).toHaveLength(2);
    expect(p2.nextCursor).toBeNull();
    const all = [...p1.items, ...p2.items].map((h) => h.message.id);
    expect(new Set(all).size).toBe(5);
  });

  it('rechaza una búsqueda vacía de letras o un cursor roto (422)', async () => {
    const b = build();
    await expect(b.messages.search(actor(1), { q: '++ **', limit: 20 })).rejects.toMatchObject({ httpStatus: 422 });
    await expect(b.messages.search(actor(1), { q: 'hola', cursor: 'x', limit: 20 })).rejects.toMatchObject({ httpStatus: 422 });
  });
});

describe('búsqueda: funciones puras', () => {
  it('quita los operadores del modo booleano y separa lo que el índice no ve', () => {
    expect(searchTerms('+Factura -"SRI" (oct*) @ana')).toEqual(['factura', 'sri', 'oct', 'ana']);
    expect(booleanQuery(['factura', 'en', 'e-mail'])).toBe('+factura* +mail*');
    expect(shortTerms(['factura', 'en'])).toEqual(['en']);
    expect(booleanQuery(['en'])).toBeNull();
  });

  it('el trozo va alrededor de la coincidencia, sin distinguir tildes', () => {
    const long = `${'x'.repeat(200)} la facturación de octubre ${'y'.repeat(200)}`;
    const s = snippet(long, ['facturacion'], 20);
    expect(s.startsWith('…')).toBe(true);
    expect(s.endsWith('…')).toBe(true);
    expect(s).toContain('facturación');
  });
});
