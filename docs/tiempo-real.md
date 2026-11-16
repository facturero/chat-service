# Tiempo real del chat (Socket.IO del gateway)

El chat **no tiene servidor de sockets propio**. Usa el hub que ya existe en `api-gateway-node/src/realtime/hub.ts`:

- Socket.IO en el path **`/ws`**, autenticado con el mismo JWT del API (`handshake.auth.token`).
- Cada socket entra a tres salas: `catalog:<orgId>` (la organización; el prefijo se llama así por historia), `device:<sub>` y
  **`user:<sub>`** (solo la suya: el `sub` sale del token, el cliente no elige sala).
- El hub consume `crm.events` en **una sola cola**, `gateway.catalog.events`. El chat añade `bindQueue(queue, 'crm.events', 'chat.#')`.
- Una réplica, sin Redis: la presencia vive en memoria del hub (límite conocido).

En el frontend hay **un solo socket** (`frontend/src/utils/realtime.ts`, `connectRealtime()`); el chat añade sus `socket.on` ahí y
delega en `stores/chat.ts`.

## Piezas nuevas en el gateway

| Archivo | Qué hace | Prueba |
|---|---|---|
| `src/realtime/chat-routing.ts` | **Puro**: `(routingKey, payload) → Array<{ room, event, data }>`. Decide salas y quita lo que no debe salir | `chat-routing.test.ts` |
| `src/realtime/chat-socket.ts` | Eventos del cliente (`chat:typing`, `chat:presence`, `chat:activity`) y el registro de presencia en memoria | `chat-socket.test.ts` (con un `io` falso) |
| `src/realtime/chat-members.ts` | Miembros de una conversación pedidos a chat-service (`GET /internal/conversations/:id/members`, `X-Internal-Secret`), con caché de 30 s; se invalida con `chat.member.*` | idem |
| `src/realtime/chat-client.ts` | `GET /internal/messages/:id` para entregar los mensajes (el evento no trae texto) | idem |
| `hub.ts` | `bindQueue(... 'chat.#')`, bloque `if (routingKey.startsWith('chat.'))` que emite lo de `chat-routing` y llama a `emitProviderNotifications(…, payload.userIds)`; `registerChatSocket(io, …)` | — |

## Del servidor al cliente

Todos llegan a la sala **`user:<uid>`** de cada destinatario (`memberUserIds` del evento, calculado por chat-service), salvo los avisos de
canales públicos, que van a la organización.

| Evento socket | Origen (RabbitMQ) | Sala | Payload |
|---|---|---|---|
| `chat.message.new` | `chat.message.created` | `user:<uid>` de cada `memberUserIds` | `{ message: Message, conversationId, threadRootId, notify: boolean }` — `message` lo pide el hub a chat-service (`GET /internal/messages/:id`: el evento no trae texto); `notify` = el uid está en `notifyUserIds` (la lista entera no se reenvía) |
| `chat.message.updated` | `chat.message.updated` | ídem | `{ message: Message }` (pedido igual) |
| `chat.message.deleted` | `chat.message.deleted` | ídem | `{ messageId, conversationId, threadRootId }` |
| `chat.reaction.changed` | `chat.reaction.added` / `removed` | ídem | `{ messageId, conversationId, emoji, userId, added: boolean }` |
| `chat.conversation.changed` | `chat.conversation.*`, `chat.member.*` | Público: `catalog:<orgId>` (aviso mínimo `{ event, conversationId }`); privado y DM: `user:<uid>` de los miembros | Aviso mínimo: el cliente vuelve a pedir la conversación por REST (así un canal privado no filtra su nombre) |
| `chat.read` | `chat.conversation.read` | `user:<uid>` del propio lector | `{ conversationId, lastReadSeq }` — sincroniza contadores entre pestañas y equipos |
| `chat.typing` | (socket, no RabbitMQ) | `user:<uid>` de los miembros, sin quien escribe | `{ conversationId, threadRootId, userId }` — el cliente lo muestra 5 s |
| `chat.presence` | (socket) | `catalog:<orgId>` | `{ userId, state: 'online' \| 'away' \| 'offline' }` — solo en las transiciones |
| `notification` | `chat.message.created` con `userIds` | `user:<uid>` | El de siempre de la campana (pasa por el gate de preferencias) |

Reglas:
- **El texto nunca viaja por RabbitMQ** (IMPLEMENTATION.md, regla 10). Para `chat.message.created|updated` el hub hace una llamada a
  `GET /internal/messages/:id?organizationId=` (con `X-Internal-Secret`, directa, sin pasar por el gateway) y reparte el mismo `Message`
  a todos los destinatarios. Si la llamada falla, emite el aviso mínimo `{ messageId, conversationId, threadRootId, notify }` y el cliente
  lo pide por REST (`GET /chat/messages/:id`).
- `@aquí`: el hub pone `notify: true` solo a los miembros que **están conectados** según su registro de presencia (`hereUserIds` del evento).
- Emitir a una sala vacía no da error: registrar en el log cuántos sockets recibieron los eventos de conversación (como `pos_theme`).
- El hub hace `ack` del mensaje de RabbitMQ siempre que pudo decidir; un payload sin `organizationId` se descarta (`nack` sin reencolar).

## Del cliente al servidor

Con la forma de `assistant-socket.ts`: `socket.emit(evento, payload, ack)` y `ack({ ok, data?, message? })`. Payloads validados con zod.

| Evento | Payload | Qué hace el hub |
|---|---|---|
| `chat:typing` | `{ conversationId, threadRootId? }` | Comprueba que el `sub` es miembro (caché de `chat-members`), y emite `chat.typing` al resto. Como mucho uno cada 3 s por socket |
| `chat:presence` | `{ userIds: string[] }` (≤ 200) | Responde en el ack el estado de cada uno, **solo** de usuarios de la misma organización |
| `chat:activity` | `{ state: 'active' \| 'away' }` | El cliente lo manda al conectar (así entra al registro), a los 10 min sin actividad y al volver. Si cambia el estado agregado del usuario (todas sus pestañas), emite `chat.presence` |

Lo que **no** va por socket: enviar, editar, borrar, reaccionar y marcar leído van por REST (`openapi.yaml`). Así chat-service es la única
fuente de verdad y el socket solo avisa.

## Presencia

- Registro en memoria del hub (`PresenceRegistry` en `chat-socket.ts`): `Map<orgId, Map<userId, { sockets: Set<socketId>, away: Set<socketId> }>>`.
- Un socket entra al registro cuando la pestaña se **anuncia** con `chat:activity` (el frontend lo hace al conectar), no al conectar: la
  caja POS abre el mismo socket con su propio `sub` y no debe salir «en línea». El frontend pasa a `away` a los 10 min sin teclado ni
  ratón en esa pestaña; pestaña oculta no es ausente.
- Con varias réplicas del gateway cada una vería solo sus sockets; hoy hay una.
- `online` = al menos un socket activo; `away` = todos sus sockets avisaron `away`; `offline` = sin sockets (con 30 s de gracia antes de
  emitirlo, para que una recarga no parpadee).
- Al reiniciar el gateway todos reconectan y la presencia se rehace sola.

## Reconexión

El cliente ya reconecta solo (`socket.io-client`). Al reconectar, `stores/chat.ts` vuelve a pedir por REST la lista de conversaciones y,
de la abierta, los mensajes `after=<último seq conocido>`: lo que llegó mientras no había socket no se pierde.
