import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { actor, build, OTHER_ORG, text, user } from './helpers.js';
import { normalizeEmojiName } from '../domain/emojis.js';
import { parseRichText } from '../domain/richtext.js';

const doc = () => randomUUID();

describe('emojis personalizados', () => {
  it('agrega con el nombre normalizado; el nombre es único por organización (no entre organizaciones)', async () => {
    const b = build();
    const e = await b.emojis.create(actor(1), { name: ':Fiesta Ñandú:', documentId: doc() });
    expect(e.name).toBe('fiesta_nandu');
    await expect(b.emojis.create(actor(2), { name: 'fiesta_nandu', documentId: doc() })).rejects.toMatchObject({ httpStatus: 409 });
    const other = await b.emojis.create(actor(90, { org: OTHER_ORG }), { name: 'fiesta_nandu', documentId: doc() });
    expect(other.organizationId).toBe(OTHER_ORG);
    expect((await b.emojis.list(actor(3))).map((x) => x.name)).toEqual(['fiesta_nandu']);
  });

  it('rechaza nombres vacíos o cortos y una imagen que no es un id', async () => {
    const b = build();
    await expect(b.emojis.create(actor(1), { name: '!!', documentId: doc() })).rejects.toMatchObject({ httpStatus: 422 });
    await expect(b.emojis.create(actor(1), { name: 'a', documentId: doc() })).rejects.toMatchObject({ httpStatus: 422 });
    await expect(b.emojis.create(actor(1), { name: 'ok', documentId: 'no-es-un-id' })).rejects.toMatchObject({ httpStatus: 422 });
    expect(normalizeEmojiName('  Café con  leche ')).toBe('cafe_con_leche');
  });

  it('lo quita quien lo subió o chat:admin; nadie más', async () => {
    const b = build();
    const e = await b.emojis.create(actor(1), { name: 'listo', documentId: doc() });
    await expect(b.emojis.remove(actor(2), e.id)).rejects.toMatchObject({ httpStatus: 403 });
    await b.emojis.remove(actor(3, { admin: true }), e.id);
    expect(await b.emojis.list(actor(1))).toHaveLength(0);
    await expect(b.emojis.remove(actor(1), e.id)).rejects.toMatchObject({ httpStatus: 404 });
  });

  it('en los mensajes: nodo `emoji` con su nombre, y `:nombre:` en el texto plano', () => {
    const parsed = parseRichText({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'listo ' }, { type: 'emoji', attrs: { name: 'fiesta' } }] }] });
    expect(parsed.text).toBe('listo :fiesta:');
    expect(() => parseRichText({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'emoji', attrs: { name: 'Mal Nombre' } }] }] })).toThrow();
  });

  it('reacciones: `:nombre:` si existe en la organización; quitar una reacción vieja funciona aunque lo hayan borrado', async () => {
    const b = build();
    const id = (await b.conversations.create(actor(1), { kind: 'channel', name: 'emo', userIds: [user(2)] })).conversation.conversation.id;
    const m = (await b.messages.send(actor(1), id, { clientMsgId: randomUUID(), bodyDoc: text('¡salió!') })).message;
    await expect(b.messages.react(actor(2), m.id, ':fiesta:', true)).rejects.toMatchObject({ httpStatus: 422 });
    const e = await b.emojis.create(actor(1), { name: 'fiesta', documentId: doc() });
    expect((await b.messages.react(actor(2), m.id, ':fiesta:', true)).map((g) => g.emoji)).toEqual([':fiesta:']);
    await b.emojis.remove(actor(1), e.id);
    expect(await b.messages.react(actor(2), m.id, ':fiesta:', false)).toEqual([]);
  });
});
