#!/usr/bin/env node
// Verificación contra MySQL y el servicio REAL (Docker local): lo que las pruebas en memoria no pueden ver (bloqueos, UNIQUE, JSON).
//
//     node scripts/verify-chat.mjs
//
// Variables (con valores del docker-compose local por defecto):
//   CHAT_URL=http://localhost:3021   MYSQL_HOST=127.0.0.1  MYSQL_PORT=3307  MYSQL_USER=root  MYSQL_PASSWORD=root123
//
// Llama al servicio directo con las cabeceras que pondría el gateway (X-Organization-Id, X-User-Id). Elige una organización local con
// al menos 4 miembros activos en auth_db (así el directorio de auth la conoce). Todo lo que crea lleva un prefijo `verify-` y su id
// queda en la salida; no borra nada.
import { randomUUID } from 'node:crypto';
import mysql from 'mysql2/promise';

const CHAT = process.env.CHAT_URL ?? 'http://localhost:3021';
const db = await mysql.createConnection({
  host: process.env.MYSQL_HOST ?? '127.0.0.1',
  port: Number(process.env.MYSQL_PORT ?? 3307),
  user: process.env.MYSQL_USER ?? 'root',
  password: process.env.MYSQL_PASSWORD ?? 'root123',
});

let failures = 0;
const check = (ok, msg) => {
  console.log(`${ok ? 'OK  ' : 'FALLA'} ${msg}`);
  if (!ok) failures += 1;
};

// Organización con 4+ miembros activos (auth_db).
const [orgs] = await db.query(
  `SELECT m.organization_id AS org, GROUP_CONCAT(m.user_id ORDER BY m.user_id) AS users
     FROM auth_db.organization_memberships m JOIN auth_db.users u ON u.id = m.user_id
    WHERE m.status = 'active' AND u.status = 'active'
    GROUP BY m.organization_id HAVING COUNT(*) >= 4 ORDER BY COUNT(*) LIMIT 1`,
);
if (!orgs.length) {
  console.error('No hay una organización local con 4 miembros activos.');
  process.exit(1);
}
const ORG = orgs[0].org.toLowerCase();
const [A, B, C, D] = orgs[0].users.split(',').map((u) => u.toLowerCase());
console.log(`Organización ${ORG}; personas ${[A, B, C, D].map((u) => u.slice(0, 8)).join(', ')}`);

async function api(method, path, who, body, extraHeaders = {}) {
  const res = await fetch(`${CHAT}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Organization-Id': ORG, 'X-User-Id': who, ...extraHeaders },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}
const doc = (t) => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: t }] }] });
const tag = randomUUID().slice(0, 6);

// 1. Canal y 30 envíos simultáneos → seq 1..30.
const ch = await api('POST', '/chat/conversations', A, { kind: 'channel', name: `verify-${tag}`, userIds: [B, C] });
check(ch.status === 201, `crear canal verify-${tag} (${ch.status})`);
const cid = ch.body.id;
const sends = await Promise.all(Array.from({ length: 30 }, (_, i) => api('POST', `/chat/conversations/${cid}/messages`, [A, B, C][i % 3], { clientMsgId: randomUUID(), bodyDoc: doc(`m${i}`) })));
check(sends.every((s) => s.status === 201), `30 envíos simultáneos aceptados (${sends.map((s) => s.status).filter((s) => s !== 201).join(',') || 'todos 201'})`);
const [seqs] = await db.query('SELECT seq FROM chat_db.messages WHERE conversation_id = ? ORDER BY seq', [cid]);
check(JSON.stringify(seqs.map((r) => Number(r.seq))) === JSON.stringify(Array.from({ length: 30 }, (_, i) => i + 1)), `seq 1..30 sin huecos ni repetidos en MySQL`);
const [[conv]] = await db.query('SELECT message_seq FROM chat_db.conversations WHERE id = ?', [cid]);
check(Number(conv.message_seq) === 30, `message_seq de la conversación = 30 (${conv.message_seq})`);

// 2. Mismo clientMsgId 10 veces a la vez → un mensaje.
const client = randomUUID();
const dup = await Promise.all(Array.from({ length: 10 }, () => api('POST', `/chat/conversations/${cid}/messages`, A, { clientMsgId: client, bodyDoc: doc('una sola vez') })));
const [[{ n: dupCount }]] = await db.query('SELECT COUNT(*) AS n FROM chat_db.messages WHERE conversation_id = ? AND client_msg_id = ?', [cid, client]);
check(Number(dupCount) === 1 && new Set(dup.map((d) => d.body?.id)).size === 1, `mismo clientMsgId x10 → 1 mensaje (${dupCount}); respuestas ${[...new Set(dup.map((d) => d.status))].join('/')}`);

// 3. Abrir el mismo DM 10 veces a la vez → una conversación.
const dms = await Promise.all(Array.from({ length: 10 }, (_, i) => api('POST', '/chat/conversations', i % 2 ? C : D, { kind: 'dm', userIds: [i % 2 ? D : C] })));
const dmIds = new Set(dms.map((d) => d.body?.id));
check(dmIds.size === 1 && dms.every((d) => d.status === 200 || d.status === 201), `abrir DM x10 → 1 conversación (${dmIds.size}); estados ${[...new Set(dms.map((d) => d.status))].join('/')}`);

// 4. 10 «unirse» a la vez → una fila.
const pub = await api('POST', '/chat/conversations', A, { kind: 'channel', name: `verify-join-${tag}` });
await Promise.all(Array.from({ length: 10 }, () => api('POST', `/chat/conversations/${pub.body.id}/join`, D)));
const [[{ n: joins }]] = await db.query('SELECT COUNT(*) AS n FROM chat_db.conversation_members WHERE conversation_id = ? AND user_id = ?', [pub.body.id, D]);
check(Number(joins) === 1, `unirse x10 → 1 fila (${joins})`);

// 5. JSON intacto tras pasar por MySQL; el outbox no lleva el texto (regla 10).
const secret = `secreto-${tag}`;
const one = await api('POST', `/chat/conversations/${cid}/messages`, B, { clientMsgId: randomUUID(), bodyDoc: doc(secret) });
const back = await api('GET', `/chat/messages/${one.body.id}`, C);
check(back.body?.bodyDoc?.content?.[0]?.content?.[0]?.text === secret, 'el documento vuelve igual de MySQL (sin doble JSON.parse)');
const [leak] = await db.query("SELECT COUNT(*) AS n FROM chat_db.outbox_messages WHERE JSON_SEARCH(payload, 'one', ?) IS NOT NULL", [`%${secret}%`]);
check(Number(leak[0].n) === 0, 'ningún evento del outbox contiene el texto del mensaje');
const [[ev]] = await db.query("SELECT payload FROM chat_db.outbox_messages WHERE type = 'chat.message.created' AND aggregate_id = ?", [one.body.id]);
const payload = typeof ev.payload === 'string' ? JSON.parse(ev.payload) : ev.payload;
check(payload.organizationId === ORG && Array.isArray(payload.memberUserIds) && payload.memberUserIds.length === 2, 'evento con organizationId y destinatarios');

// 6. No leídos y leído.
// Escribir marca leído lo anterior (como Slack): el cursor de C es su último mensaje; sin leer = los de otros después de ese.
const [[{ read_cursor: cursor }]] = await db.query('SELECT last_read_seq AS read_cursor FROM chat_db.conversation_members WHERE conversation_id = ? AND user_id = ?', [cid, C]);
const [[{ mine }]] = await db.query('SELECT MAX(seq) AS mine FROM chat_db.messages WHERE conversation_id = ? AND sender_id = ?', [cid, C]);
const [[{ expected, total }]] = await db.query(
  'SELECT SUM(seq > ? AND sender_id <> ?) AS expected, MAX(seq) AS total FROM chat_db.messages WHERE conversation_id = ?',
  [Number(cursor), C, cid],
);
check(Number(cursor) === Number(mine), `el cursor de C quedó en su último mensaje (${cursor} = ${mine})`);
const list = await api('GET', '/chat/conversations', C);
const unread = list.body.items.find((i) => i.id === cid)?.unreadCount;
check(unread === Number(expected), `no leídos de C = mensajes de otros tras su cursor (${unread} = ${expected})`);
const read = await api('POST', `/chat/conversations/${cid}/read`, C, { seq: 9999 });
check(read.body?.unreadCount === 0 && read.body?.lastReadSeq === Number(total), `leer «hasta 9999» se acota al último (${JSON.stringify(read.body)}; total ${total})`);

// 7. Privado ajeno = 404 directo contra el servicio.
const priv = await api('POST', '/chat/conversations', A, { kind: 'channel', name: `verify-priv-${tag}`, visibility: 'private' });
check((await api('GET', `/chat/conversations/${priv.body.id}`, D)).status === 404, 'canal privado ajeno → 404');

// 8. (E2) 20 respuestas simultáneas en un hilo → thread_seq 1..20 y reply_count = 20 en la raíz.
const rootMsg = await api('POST', `/chat/conversations/${cid}/messages`, A, { clientMsgId: randomUUID(), bodyDoc: doc('raíz del hilo') });
const replies = await Promise.all(Array.from({ length: 20 }, (_, i) => api('POST', `/chat/conversations/${cid}/messages`, [B, C][i % 2], { clientMsgId: randomUUID(), bodyDoc: doc(`r${i}`), threadRootId: rootMsg.body.id })));
check(replies.every((r) => r.status === 201), `20 respuestas simultáneas aceptadas (${[...new Set(replies.map((r) => r.status))].join('/')})`);
const [tseq] = await db.query('SELECT thread_seq FROM chat_db.messages WHERE thread_root_id = ? ORDER BY thread_seq', [rootMsg.body.id]);
check(JSON.stringify(tseq.map((r) => Number(r.thread_seq))) === JSON.stringify(Array.from({ length: 20 }, (_, i) => i + 1)), 'thread_seq 1..20 sin huecos ni repetidos');
const [[rootRow]] = await db.query('SELECT reply_count, JSON_LENGTH(reply_user_ids) AS faces FROM chat_db.messages WHERE id = ?', [rootMsg.body.id]);
check(Number(rootRow.reply_count) === 20 && Number(rootRow.faces) <= 3, `raíz: reply_count 20 (${rootRow.reply_count}), caras ≤ 3 (${rootRow.faces})`);
const [[{ followers }]] = await db.query('SELECT COUNT(*) AS followers FROM chat_db.thread_followers WHERE thread_root_id = ?', [rootMsg.body.id]);
check(Number(followers) === 3, `seguidores del hilo: autor + 2 que respondieron (${followers})`);

// 9. (E2) 10 «👍» simultáneos de la misma persona → una fila; quitar dos veces → cero.
await Promise.all(Array.from({ length: 10 }, () => api('POST', `/chat/messages/${rootMsg.body.id}/reactions`, B, { emoji: '👍' })));
const [[{ n: reacts }]] = await db.query("SELECT COUNT(*) AS n FROM chat_db.message_reactions WHERE message_id = ? AND emoji = '👍'", [rootMsg.body.id]);
check(Number(reacts) === 1, `reacción x10 → 1 fila (${reacts})`);
await api('DELETE', `/chat/messages/${rootMsg.body.id}/reactions/${encodeURIComponent('👍')}`, B);
const gone = await api('DELETE', `/chat/messages/${rootMsg.body.id}/reactions/${encodeURIComponent('👍')}`, B);
check(gone.status === 200 && gone.body.count === 0, 'quitar la reacción dos veces → 0, sin error');

// 10. (E2) Borrar: el texto desaparece de MySQL (decisión «privado»), queda la lápida.
await api('DELETE', `/chat/messages/${one.body.id}`, B);
const [[del]] = await db.query('SELECT body_text, body_doc, deleted_at FROM chat_db.messages WHERE id = ?', [one.body.id]);
check(del.body_text === null && del.body_doc === null && del.deleted_at !== null, 'borrar: body_text y body_doc en NULL, deleted_at puesto');

// 11. (E4) Búsqueda con el índice FULLTEXT real: prefijo, y nunca lo que no se puede leer (privado ajeno, ni para un admin).
const word = `zafiro${tag.replace(/-/g, '')}`;
await api('POST', `/chat/conversations/${cid}/messages`, A, { clientMsgId: randomUUID(), bodyDoc: doc(`El ${word} compartido`) });
await api('POST', `/chat/conversations/${priv.body.id}/messages`, A, { clientMsgId: randomUUID(), bodyDoc: doc(`El ${word} privado`) });
const byA = await api('GET', `/chat/search?q=${encodeURIComponent(word.slice(0, 9))}`, A);
check(byA.status === 200 && byA.body.items.length === 2, `A (miembro de ambos) encuentra 2 por prefijo «${word.slice(0, 9)}» (${byA.status}, ${byA.body.items?.length})`);
const byC = await api('GET', `/chat/search?q=${word}`, C);
check(byC.body.items.length === 1 && byC.body.items[0].conversation.id === cid, `C no ve el del canal privado (${byC.body.items?.length})`);
const byD = await api('GET', `/chat/search?q=${word}`, D, undefined, { 'X-Permissions': 'chat:admin' });
// El canal de la prueba es público (lo puede leer cualquiera del equipo); el privado, nunca.
check(byD.body.items.length === 1 && byD.body.items[0].conversation.id === cid, `D (no es miembro, con chat:admin) ve el canal público y no el privado (${byD.body.items?.length})`);
check(byA.body.items[0].snippet.includes(word), 'el resultado trae el trozo con la palabra');

// 12. Vista «Hilos»: cursor por seguidor en MySQL, menciones en hilos y totales de /chat/unread.
const tRoot = await api('POST', `/chat/conversations/${cid}/messages`, A, { clientMsgId: randomUUID(), bodyDoc: doc('raíz para la vista de hilos') });
await api('POST', `/chat/conversations/${cid}/messages`, B, { clientMsgId: randomUUID(), bodyDoc: doc('primera respuesta'), threadRootId: tRoot.body.id });
const mention = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'mention', attrs: { id: A, label: 'A' } }, { type: 'text', text: ' revisa' }] }] };
await api('POST', `/chat/conversations/${cid}/messages`, C, { clientMsgId: randomUUID(), bodyDoc: mention, threadRootId: tRoot.body.id });
const tv = await api('GET', '/chat/threads?limit=50', A);
const tItem = tv.body.items?.find((x) => x.root.id === tRoot.body.id);
check(tv.status === 200 && tItem?.unreadCount === 2 && tItem?.mentionCount === 1 && tItem?.latestReplies?.length === 2, `A ve el hilo con 2 nuevas y 1 mención (${tv.status}, ${tItem?.unreadCount}/${tItem?.mentionCount})`);
const inbox = await api('GET', '/chat/unread', A);
check(inbox.body.threads?.mentions >= 1 && inbox.body.threads?.unread >= 1, `/chat/unread suma hilos y menciones en hilos (${JSON.stringify(inbox.body.threads)})`);
const tRead = await api('POST', `/chat/messages/${tRoot.body.id}/thread/read`, A, { threadSeq: 999 });
const [[fRow]] = await db.query('SELECT last_read_thread_seq AS c FROM chat_db.thread_followers WHERE thread_root_id = ? AND user_id = ?', [tRoot.body.id, A]);
check(tRead.body.lastReadThreadSeq === 2 && Number(fRow.c) === 2 && tRead.body.unreadCount === 0 && tRead.body.mentionCount === 0, `leer «hasta 999» se acota a la última respuesta (cursor ${fRow.c})`);
const back2 = await api('POST', `/chat/messages/${tRoot.body.id}/thread/read`, A, { threadSeq: 0 });
check(back2.body.lastReadThreadSeq === 2, 'el cursor del hilo no retrocede');
const notFollower = await api('POST', `/chat/messages/${tRoot.body.id}/thread/read`, D, { threadSeq: 1 });
check(notFollower.status === 200 && notFollower.body.lastReadThreadSeq === null, 'quien no sigue el hilo: no cambia nada (null)');

// 13. Emojis personalizados: 10 altas simultáneas del mismo nombre → una fila (UNIQUE organización+nombre); reaccionar con él.
const emoName = `verifica${tag.replace(/-/g, '').slice(0, 6)}`;
const emoAdds = await Promise.all(Array.from({ length: 10 }, () => api('POST', '/chat/emojis', [A, B][Math.floor(Math.random() * 2)], { name: emoName, documentId: randomUUID() })));
const [[{ n: emoRows }]] = await db.query('SELECT COUNT(*) AS n FROM chat_db.custom_emojis WHERE organization_id = ? AND name = ?', [ORG, emoName]);
check(Number(emoRows) === 1 && emoAdds.filter((r) => r.status === 201).length === 1 && emoAdds.filter((r) => r.status === 409).length === 9, `emoji x10 a la vez → 1 fila (${emoRows}); 1 creado y 9 «ya existe»`);
const emoReact = await api('POST', `/chat/messages/${tRoot.body.id}/reactions`, C, { emoji: `:${emoName}:` });
check(emoReact.status === 200 && emoReact.body.emoji === `:${emoName}:`, 'reaccionar con el emoji personalizado');

await db.end();
console.log(failures ? `\n${failures} verificación(es) fallaron.` : '\nTodo en verde.');
process.exit(failures ? 1 : 0);
