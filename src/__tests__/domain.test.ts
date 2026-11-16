import { describe, expect, it } from 'vitest';
import { channelNameKey, dmKey, normalizeChannelName } from '../domain/names.js';
import { computeRecipients } from '../domain/recipients.js';
import { parseRichText } from '../domain/richtext.js';
import type { Conversation, Member } from '../domain/types.js';
import { user } from './helpers.js';

describe('nombres', () => {
  it('normaliza al estilo Slack y la clave ignora tildes', () => {
    expect(normalizeChannelName('  #Ventas   Quito!! ')).toBe('ventas-quito');
    expect(normalizeChannelName('Diseño_web')).toBe('diseño_web');
    expect(channelNameKey('diseño-web')).toBe('diseno-web');
  });
  it('dm_key no depende del orden ni de mayúsculas', () => {
    expect(dmKey([user(2), user(1)])).toBe(dmKey([user(1).toUpperCase(), user(2)]));
    expect(dmKey([user(1), user(2)])).not.toBe(dmKey([user(1), user(3)]));
  });
});

describe('texto enriquecido del mensaje', () => {
  it('acepta @canal, @aquí y tarjetas del CRM; saca texto y menciones', () => {
    const r = parseRichText({
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'mention', attrs: { id: 'channel' } }, { type: 'text', text: ' revisen' }, { type: 'mention', attrs: { id: user(2), label: 'Ana' } }] },
        { type: 'crmLink', attrs: { entityType: 'invoice', entityId: user(9), label: 'Factura 001-001-000000123' } },
      ],
    });
    expect(r.mentionsChannel).toBe(true);
    expect(r.mentions).toEqual([user(2)]);
    expect(r.crmLinks).toEqual([{ entityType: 'invoice', entityId: user(9), label: 'Factura 001-001-000000123' }]);
    expect(r.text).toContain('@canal revisen@Ana');
    expect(r.isEmpty).toBe(false);
  });
  it('rechaza tarjetas de tipos desconocidos, enlaces javascript: y más de 4000 caracteres', () => {
    expect(() => parseRichText({ type: 'doc', content: [{ type: 'crmLink', attrs: { entityType: 'user', entityId: user(1) } }] })).toThrow();
    expect(() => parseRichText({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'x', marks: [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }] }] }] })).toThrow();
    expect(() => parseRichText({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'a'.repeat(4001) }] }] })).toThrow(/4000/);
  });
  it('una imagen sola no es un mensaje vacío; un párrafo vacío sí', () => {
    expect(parseRichText({ type: 'doc', content: [{ type: 'image', attrs: { documentId: user(7) } }] }).isEmpty).toBe(false);
    expect(parseRichText({ type: 'doc', content: [{ type: 'paragraph' }] }).isEmpty).toBe(true);
  });
});

describe('destinatarios de un mensaje', () => {
  const conv = (kind: Conversation['kind']): Conversation => ({
    id: 'c', organizationId: 'o', kind, visibility: kind === 'channel' ? 'public' : null, name: null, nameKey: null, topic: null, description: null,
    isGeneral: false, dmKey: null, createdBy: user(1), archivedAt: null, messageSeq: 0, lastMessageAt: null, createdAt: new Date(), updatedAt: new Date(),
  });
  const member = (n: number, extra: Partial<Member> = {}): Member => ({ conversationId: 'c', userId: user(n), organizationId: 'o', role: 'member', notify: 'mentions', muted: false, lastReadSeq: 0, joinedAt: new Date(), ...extra });

  it('nunca al autor; mención directa atraviesa el silencio; @canal suena a todos salvo silenciados y «nada»', () => {
    const members = [member(1), member(2, { muted: true }), member(3, { notify: 'none' }), member(4), member(5, { notify: 'all' })];
    const r = computeRecipients({ conversation: conv('channel'), members, senderId: user(1), mentionedUserIds: [user(2)], mentionsChannel: true, mentionsHere: false });
    expect(r.memberUserIds).toEqual([user(2), user(3), user(4), user(5)]);
    expect(r.notifyUserIds).toEqual([user(2), user(4), user(5)]);
    expect(r.userIds).toEqual([user(2), user(4), user(5)]);
    expect(r.mentions.map((m) => m.kind)).toEqual(['user', 'channel', 'channel', 'channel']);
  });

  it('mensaje normal de canal: navegador solo a quien eligió «todo», sin campana; @aquí lo decide el hub', () => {
    const members = [member(1), member(2), member(3, { notify: 'all' })];
    const plain = computeRecipients({ conversation: conv('channel'), members, senderId: user(1), mentionedUserIds: [], mentionsChannel: false, mentionsHere: false });
    expect(plain).toMatchObject({ notifyUserIds: [user(3)], userIds: [], hereUserIds: [] });
    const here = computeRecipients({ conversation: conv('channel'), members, senderId: user(1), mentionedUserIds: [], mentionsChannel: false, mentionsHere: true });
    expect(here.hereUserIds).toEqual([user(2), user(3)]);
    expect(here.userIds).toEqual([]);
  });
});
