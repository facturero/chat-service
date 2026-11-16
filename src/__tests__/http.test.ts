import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { build, ORG, text, user } from './helpers.js';

const headers = (n: number, extra: Record<string, string> = {}) => ({ 'Content-Type': 'application/json', 'X-Organization-Id': ORG, 'X-User-Id': user(n), ...extra });

describe('HTTP', () => {
  it('sin el contexto del gateway: 401', async () => {
    const { app } = build();
    expect((await app.request('/chat/conversations')).status).toBe(401);
  });

  it('crear canal (201), abrir DM (201 y luego 200), enviar y leer', async () => {
    const { app } = build();
    const created = await app.request('/chat/conversations', { method: 'POST', headers: headers(1), body: JSON.stringify({ kind: 'channel', name: 'Ventas', userIds: [user(2)] }) });
    expect(created.status).toBe(201);
    const ch = (await created.json()) as { id: string; name: string; me: { role: string } };
    expect(ch).toMatchObject({ name: 'ventas', me: { role: 'owner' } });

    const dm1 = await app.request('/chat/conversations', { method: 'POST', headers: headers(1), body: JSON.stringify({ kind: 'dm', userIds: [user(2)] }) });
    const dm2 = await app.request('/chat/conversations', { method: 'POST', headers: headers(2), body: JSON.stringify({ kind: 'dm', userIds: [user(1)] }) });
    expect([dm1.status, dm2.status]).toEqual([201, 200]);

    const sent = await app.request(`/chat/conversations/${ch.id}/messages`, { method: 'POST', headers: headers(1), body: JSON.stringify({ clientMsgId: randomUUID(), bodyDoc: text('hola') }) });
    expect(sent.status).toBe(201);
    const page = await (await app.request(`/chat/conversations/${ch.id}/messages`, { headers: headers(2) })).json() as { items: Array<{ bodyText: string; seq: number }>; lastReadSeq: number };
    expect(page.items.map((m) => [m.seq, m.bodyText])).toEqual([[1, 'hola']]);

    const list = await (await app.request('/chat/conversations', { headers: headers(2) })).json() as { items: Array<{ id: string; unreadCount: number }> };
    expect(list.items.find((i) => i.id === ch.id)?.unreadCount).toBe(1);
    const read = await app.request(`/chat/conversations/${ch.id}/read`, { method: 'POST', headers: headers(2), body: JSON.stringify({ seq: 1 }) });
    expect(await read.json()).toMatchObject({ lastReadSeq: 1, unreadCount: 0 });
  });

  it('ids que no son uuid: 404; validación: 422 con detalle', async () => {
    const { app } = build();
    expect((await app.request('/chat/conversations/no-es-uuid', { headers: headers(1) })).status).toBe(404);
    const bad = await app.request('/chat/conversations', { method: 'POST', headers: headers(1), body: JSON.stringify({ kind: 'canal' }) });
    expect(bad.status).toBe(422);
    expect(((await bad.json()) as { details: unknown[] }).details.length).toBeGreaterThan(0);
  });

  it('/internal/*: exige el secreto y la organización', async () => {
    const { app, conversations } = build();
    const { conversation } = await conversations.create({ userId: user(1), organizationId: ORG, permissions: [] }, { kind: 'channel', name: 'x', userIds: [user(2)] });
    const path = `/internal/conversations/${conversation.conversation.id}/members?organizationId=${ORG}`;
    expect((await app.request(path)).status).toBe(401);
    expect((await app.request(path, { headers: { 'X-Internal-Secret': 'otro' } })).status).toBe(401);
    const ok = await app.request(path, { headers: { 'X-Internal-Secret': 'secreto-de-prueba' } });
    expect(((await ok.json()) as { userIds: string[] }).userIds.sort()).toEqual([user(1), user(2)]);
  });
});
