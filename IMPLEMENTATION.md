# chat-service — Mensajería al estilo Slack

Canales públicos y privados, mensajes directos (1-a-1 y de grupo), hilos, reacciones, archivos y tarjetas del CRM, en tiempo real,
para el **equipo** de una organización. Puerto **3007**, base `chat_db`, repo `facturero/chat-service`, rama **`master`**, módulo
`comm.internal_chat` (**incluido gratis**: plugin del núcleo, siempre activo).

Documentos de este repo (léelos en este orden antes de tocar código):

| Documento | Qué fija |
|---|---|
| `IMPLEMENTATION.md` (este) | Decisiones, reglas de implementación, modelo de datos, entregables y su estado. **Es la memoria del proyecto: actualízalo al cerrar cada pieza.** |
| `openapi.yaml` | Contrato REST (lo que el gateway expone en `/chat/*`) |
| `asyncapi.yaml` | Eventos que publica y consume en RabbitMQ (`crm.events`) |
| `docs/tiempo-real.md` | Contrato de Socket.IO (lo que el hub del gateway emite y recibe) |

Ficha de la bóveda (contexto general del sistema): `~/Documents/sg-obs/crm-proyect/servicios/chat-service.md`.

---

## Estado (2026-11-14)

**E1 a E4 hechos en local (2026-11-16): conversaciones, mensajes, hilos, reacciones, editar/borrar, menciones y avisos, archivos,
tarjetas del CRM, crear tarea, presencia, «escribiendo…», búsqueda y widget; verificados contra MySQL, RabbitMQ y en dos navegadores.**
Nada subido (el dueño sube cuando esté estable). Siguiente: E5 (producción).

En el repo hay un esqueleto anterior (2026-09-16) con otro modelo, **estilo WhatsApp** (`direct`/`group`, recibos «entregado/leído»
por destinatario, historial de ediciones): migración `20260911000000-create-chat-tables.cjs`, 5 casos de uso sin capa HTTP y un
`main.ts` con `/health` y el relay. **Está desplegado en producción** (`chat-service-node`, 1 réplica) y su migración ya corrió contra
`chat_db`, pero nadie lo usa (no hay ruta en el gateway): no hay datos que conservar. Ese modelo se reemplaza (ver «Reglas» → migraciones).

| Entregable | Estado |
|---|---|
| E1 — Núcleo: canales, DMs, mensajes, no leídos, tiempo real básico | **Hecho en local** (backend, gateway, catálogo y frontend; probado en dos navegadores). Sin subir |
| E2 — Hilos, reacciones, editar y borrar, menciones y avisos | **Hecho en local** (probado contra MySQL y en dos navegadores). Sin subir |
| E3 — Archivos e imágenes, tarjetas del CRM, crear tarea desde un mensaje | **Hecho en local** (probado en dos navegadores). Sin subir |
| E4 — Presencia, «escribiendo…», búsqueda, widget de Inicio | **Hecho en local** (probado en dos navegadores). Sin subir |
| E5 — Producción: catálogo, gateway, despliegue y prueba con datos reales | Pendiente |

---

## Decisiones del dueño (2026-11-14)

| Tema | Decisión |
|---|---|
| Alcance v1 | Canales + DMs + hilos; reacciones, editar, borrar; archivos e imágenes; **integración con el CRM** (tarjetas y crear tarea) |
| Quién escribe | **Solo el equipo**: miembros activos de la organización. Sin invitados externos ni clientes |
| Leídos | **Estilo Slack**: cada quien ve sus no leídos (contadores y línea de «nuevos»). Nadie ve si otro leyó. Sin «visto» |
| Control de la empresa | **Privado, sin exportar**. Los admins gestionan canales y pueden borrar mensajes ajenos, pero **no leen DMs ni canales privados ajenos**. Los mensajes **no** van a la bitácora de auditoría; solo crear, renombrar y archivar canales |
| Avisos fuera de la conversación | **Campana del CRM** y **notificación del navegador**. Sin correo ni push al teléfono |
| Precio | **Incluido gratis** (plugin del núcleo) |
| Presencia | Punto verde (en línea / ausente) y «escribiendo…». Sin estados personalizados ni «no molestar» |
| Proyectos | **Solo tarjetas y crear tarea desde un mensaje**. Sin canales ligados a proyectos |
| Texto en eventos | **Nunca**: los eventos llevan ids; el hub pide el mensaje a chat-service. Campana sin vista previa (regla 10) |
| Encabezado | `/messages` **sin `PageHeader`**, a todo el alto (excepción acotada en UI-UX.md) |
| Fuera de alcance | Llamadas de voz/video, invitados externos, exportación, mensajes programados, recordatorios, bots, resumen con IA (todo para después) |

Por defecto (decididos por mí, cámbialos aquí si el dueño dice otra cosa): texto hasta **4000 caracteres** con el editor de Proyectos;
`@canal` y `@aquí` libres en canales de **hasta 20 miembros**, en los más grandes solo el dueño del canal o `chat:admin`; búsqueda por texto
en lo que la persona puede leer; `#general` con todo el equipo, creado solo.

---

## Arquitectura

```mermaid
graph LR
  SPA[Frontend Vue] -- REST /chat/* --> GW[api-gateway-node]
  SPA <-- Socket.IO /ws --> GW
  GW -- proxy, X-User-Id / X-Organization-Id / X-Permissions --> CHAT[chat-service :3007]
  CHAT -- outbox + @facturero/outbox-relay --> MQ[(RabbitMQ crm.events)]
  MQ -- chat.# en gateway.catalog.events --> GW
  MQ -- chat.message.created (userIds) --> NOTIF[notification-service<br/>campana]
  MQ -. chat.conversation.* (sin mensajes) .-> AUDIT[audit-log-service]
  MQ -- identity.user.* --> CHAT
  CHAT -- GET /internal/organizations/:id/contacts --> AUTH[auth-service]
  GW -- GET /internal/messages/:id y /internal/conversations/:id/members --> CHAT
  SPA -- subidas firmadas --> DOC[document-service]
```

- **chat-service persiste y publica**; no abre sockets. El tiempo real lo hace el **hub del gateway** que ya existe
  (`api-gateway-node/src/realtime/hub.ts`, Socket.IO en `/ws`), igual que con Proyectos.
- **RabbitMQ no se toca**: es el proyecto de infraestructura `backend/rabbitmq-basic` que usan todos los servicios. El exchange topic
  `crm.events` lo declaran el relay y los consumidores; aquí no se crean exchanges ni infraestructura propia.
- Los nombres, fotos y correos de las personas **no se guardan aquí**: el frontend los toma de `/users/directory` (auth), como Proyectos.

---

## Reglas de implementación (obligatorias)

### Código y estructura
1. **Misma estructura que `projects-service`** (es el modelo a copiar): `src/domain` (tipos, reglas puras, errores), `src/application`
   (casos de uso con unidad de trabajo), `src/infrastructure` (persistencia Sequelize, mensajería, config, telemetría), `src/interface/http`
   (rutas Hono, validadores zod, serializadores). Copia de projects-service: `inTransaction` con reintento ante *deadlock*, el `rollback`
   que tolera una transacción terminada, `parseBody`, el formato de error `{ code, message, status, details? }` y la telemetría OTel.
2. **Sin `sequelize.sync()`**: la migración (initContainer `chat-migrate`) es la fuente de verdad del esquema.
3. Las rutas del servicio se montan con el **mismo prefijo que el gateway** (`/chat/...`, `stripPrefix: ''`), como `/projects/...`.
4. Comentarios en español, que expliquen **por qué**. Nada de `any` en dominio.

### Migraciones
5. **Nunca editar `20260911000000-create-chat-tables.cjs`**: ya corrió en producción. El modelo nuevo entra con una migración nueva que
   **borra las 5 tablas viejas** (`message_deletions`, `message_versions`, `participant_messages`, `messages`, `conversation_participants`,
   `conversations`, en ese orden por las FK) y crea las del modelo de abajo. Es seguro porque no hay datos (verificarlo con un `SELECT
   COUNT(*)` en producción antes de subir; si hubiera filas, parar y preguntar).
6. Local: `chat_db` / `chat_user` a `docker/mysql/init.sql` **o** `sequelize-cli db:create` en el comando de `chat-migrate` del
   `docker-compose.yml` (ver AGENTS.md; `check-all` lo vigila).

### Eventos (outbox + RabbitMQ)
7. **Solo con `@facturero/outbox-relay`** (`^0.2.3`, como projects-service): la fila de `outbox_messages` se escribe en la misma
   transacción que el cambio y `relay.attachToTransaction(tx)` publica al confirmar. Nunca `channel.publish` directo.
8. Nombres `chat.<entidad>.<acción>` (ver `asyncapi.yaml`). Todo payload lleva `organizationId` y `conversationId`. El relay añade actor,
   IP y `requestId`.
9. Destinatarios **calculados aquí**, en tres listas de ids (nunca nombres ni correos):
   - `memberUserIds`: a quién reenvía el hub el evento por socket (miembros de la conversación, sin el autor).
   - `notifyUserIds`: quién debe recibir **notificación del navegador** (ver «Avisos»).
   - `userIds`: quién recibe **campana** (lo leen notification-service y el gateway, igual que en Proyectos).
10. **Los eventos NUNCA llevan el texto de un mensaje** (decisión del dueño, 2026-11-14). Motivo: `InboxConsumer` guarda el payload
    completo de cada evento en `processed_events` del consumidor aunque el handler lo ignore (`markOutcome`), y audit-log consume `#`:
    el texto quedaría copiado en otras bases. Por eso:
    - `chat.message.created|updated` llevan solo ids (`messageId`, `seq`, `threadRootId`, `senderId`, menciones) y los destinatarios.
      El **hub pide el mensaje** a chat-service (`GET /internal/messages/:id`, `X-Internal-Secret`, una llamada por mensaje) y lo entrega
      por socket. Si esa llamada falla, emite el aviso mínimo `{ messageId, conversationId }` y el cliente lo pide por REST.
    - La campana dice «Nuevo mensaje de Ana en #ventas», **sin vista previa**. `conversationName` sí viaja (es un nombre, no contenido).
    - audit-log-service excluye `chat.message.*`, `chat.reaction.*`, `chat.member.*` y `chat.conversation.read` por **ruido** (la
      bitácora registra solo crear, renombrar y archivar canales): `AUDIT_DENYLIST` acepta prefijos (entradas terminadas en `.`).
11. Consumo con `InboxConsumer` (cola `chat-service.events`, idempotente por `processed_events`): `identity.user.accepted_invite` (entra a
    `#general`), `identity.user.disabled` / `identity.user.enabled` (se marca inactivo: sale de los canales, sus DMs quedan de solo lectura).

### Tiempo real (Socket.IO del gateway — no crear otro)
12. **No hay servidor de sockets en chat-service.** Todo va por el hub del gateway. Se añade, siguiendo el patrón de
    `projects-routing.ts`:
    - `api-gateway-node/src/realtime/chat-routing.ts`: función **pura y probada** que traduce `(routingKey, payload)` a una lista de
      `{ room, event, data }`.
    - En `hub.ts`: `bindQueue(queue, EXCHANGE, 'chat.#')` en la **misma cola** `gateway.catalog.events`, y un bloque `if
      (routingKey.startsWith('chat.'))` que emite lo que diga `chat-routing.ts` y llama a `emitProviderNotifications` con `userIds`.
    - Mensajes a salas **`user:<uid>`** (cada socket ya se une a la suya). Cambios de canales públicos (creado, renombrado, archivado) como
      aviso mínimo a la sala de la organización (`catalog:<orgId>`, el prefijo que usa el hub) — el cliente vuelve a pedir por REST.
    - Eventos del cliente al hub (`chat:typing`, `chat:presence`, `chat:activity`) en un módulo `chat-socket.ts` registrado como
      `registerAssistantSocket` (acks con `{ ok, data?, message? }`).
    - «Escribiendo…» y presencia **no se guardan** ni pasan por RabbitMQ.
    - Detalle en `docs/tiempo-real.md`.
13. El gateway corre en **una réplica, sin Redis**: la presencia vive en memoria del hub. Escalar el gateway exige primero el adaptador de
    Redis de Socket.IO (ver `arquitectura/tiempo-real.md` en la bóveda). Documentado como límite conocido, no se resuelve en la v1.
14. Frontend: **un solo socket**, el de `frontend/src/utils/realtime.ts` (`connectRealtime`). Se añaden `socket.on('chat.*', …)` que
    llaman al store `stores/chat.ts`; nada de abrir conexiones nuevas.

### Concurrencia y MySQL (lecciones de projects-service)
15. **Orden de mensajes**: `seq` por conversación, asignado bajo `SELECT … FOR UPDATE` de la fila de la conversación (`message_seq + 1`).
    Las respuestas de hilo llevan `thread_seq` dentro de su raíz, igual. Nunca ordenar por `created_at` (empata).
16. **Reenvíos del cliente**: `client_msg_id` (uuid que genera el navegador) con `UNIQUE (conversation_id, client_msg_id)` +
    `INSERT IGNORE`: un doble envío por red lenta devuelve el mismo mensaje.
17. **DM idempotente**: `dm_key` = hash de los ids ordenados, `UNIQUE (organization_id, dm_key)`; abrir el mismo DM 10 veces a la vez da
    una sola conversación (`INSERT IGNORE` + lectura con `LOCK.SHARE`, como las etiquetas de Proyectos).
18. **Reacciones**: PK `(message_id, user_id, emoji)` + `INSERT IGNORE`; quitar es idempotente.
19. **Columnas JSON**: mysql2 ya las entrega decodificadas; no volver a `JSON.parse` (bug ya visto en Proyectos).
20. Cada pieza con concurrencia se prueba **contra MySQL real** en `scripts/verify-chat.mjs` (las pruebas en memoria no ven bloqueos).

### Texto, archivos y privacidad
21. **Texto enriquecido = el de Proyectos**: documento TipTap validado por lista blanca. Copiar `projects-service/src/domain/richtext.ts`
    y añadir el nodo `crmLink` (`entityType`, `entityId`, `label`). Imágenes y archivos solo con `documentId` (nunca la URL: caduca).
    Se guarda `body_doc` (JSON) y `body_text` (texto plano para búsqueda, vista previa y campana). Máx. 4000 caracteres de texto.
22. Archivos: el frontend sube a document-service antes de enviar (flujo firmado de siempre) con `resourceType: 'chat_conversation'`,
    `resourceId: <conversationId>`. document-service autoriza por organización; el id del documento es un uuid no adivinable. Aceptado
    para la v1 (mismo criterio que Proyectos); anotado como riesgo. **`GET /files` nunca lista `chat_conversation`** (document-service,
    `isUnlistedResource`): el id de un DM o de un canal privado sale en la bitácora de auditoría y, sin esto, cualquiera de la empresa
    listaría sus archivos. El enlace a cada archivo solo viaja dentro del mensaje.
23. **Borrar = borrar**: `body_doc` y `body_text` a `NULL`, queda la lápida (`deleted_at`, `deleted_by`) para no romper hilos. Editar no
    guarda historial. Es la decisión «privado».
24. **Sin acceso = 404** (no se revela que existe un canal privado o un DM). Escribir en un canal archivado = 409 `CONVERSATION_ARCHIVED`.

### Contratos y verificación
25. `openapi.yaml` y `asyncapi.yaml` se mantienen al día **en el mismo cambio** que el código. Copiar de projects-service
    `scripts/check-openapi-routes.mjs` y `scripts/check-asyncapi-events.mjs` y exponerlos como `npm run verify:openapi` / `verify:asyncapi`.
26. Cada ruta de `openapi.yaml` necesita su entrada en `api-gateway-node/src/config/gateway.config.ts` (`check-all` lo cruza): la cubre
    `ANY /chat/*`. Las rutas documentadas que aún no existen van en `PENDIENTES` de `scripts/check-openapi-routes.mjs` (y los eventos en
    el de `check-asyncapi-events.mjs`); al implementarlas hay que quitarlas de ahí o el verificador falla.
27. `node scripts/check-all.mjs` en verde antes de dar algo por terminado; frontend con `npm run lint:ui` y `npm run build`.

### Frontend
28. `frontend/docs/UI-UX.md` y `REGLAS-FRONT.md` mandan. **Excepción aprobada por el dueño (2026-11-14): `/messages` va sin
    `PageHeader`**, a todo el alto (barra de canales, conversación, hilo); el nombre del canal hace de título. Anotarla en UI-UX.md como
    excepción acotada (igual que el editor del plano del restaurante) y que `lint:ui` la permita solo en esa vista.
29. Reutilizar, no copiar: `RichTextEditor` / `RichTextView` / `RichImage` / visor de imágenes / colores por tipo de archivo de
    `components/projects/` (moverlos a `components/rich/` si hace falta compartirlos, con su prueba). El ícono de sobre de la barra
    superior ya existe sin datos (`components/MessageInbox.vue`): se conecta a la bandeja del chat.
30. Widget de Inicio «Mensajes sin leer» en `frontend/src/widgets/registry.ts` (`plugin: 'comm.internal_chat'`): la regla
    `check-widgets.mjs` lo exige en cuanto el plugin esté construido.
31. i18n en es/en/fr; etiquetas `audit.event.chat_conversation_*` para los eventos que sí van a la bitácora.

### Trabajo
32. **Nunca commit ni push** sin que el dueño lo pida; él sube. Al terminar, dar los comandos con **solo los archivos propios**.
33. Al cerrar cada entregable: actualizar la tabla «Estado», la sección del entregable (qué, dónde, cómo se verificó, bugs encontrados) y
    la memoria (`~/.claude/projects/C--Users-sansh-cmr-proyect/memory/chat-mensajeria.md`).

---

## Modelo de datos (`chat_db`)

| Tabla | Columnas clave | Notas |
|---|---|---|
| `conversations` | `id`, `organization_id`, `kind` (`channel`·`dm`·`group_dm`), `visibility` (`public`·`private`, solo canales), `name` (canal, ≤ 80), `name_key` (minúsculas sin tildes), `topic` (≤ 250), `description` (≤ 1000), `is_general`, `dm_key` (dm/grupo), `created_by`, `archived_at`, `message_seq` BIGINT, `last_message_at`, `created_at`, `updated_at` | `UNIQUE (organization_id, name_key)` para canales; `UNIQUE (organization_id, dm_key)`; un solo `is_general` por organización |
| `conversation_members` | PK `(conversation_id, user_id)`, `organization_id`, `role` (`owner`·`member`), `notify` (`all`·`mentions`·`none`), `muted`, `last_read_seq` BIGINT, `joined_at` | Salir = borrar la fila. `notify` por defecto: `all` en DMs, `mentions` en canales |
| `messages` | `id`, `organization_id`, `conversation_id`, `seq` (raíz) / `thread_root_id` + `thread_seq` (respuesta), `sender_id`, `kind` (`user`·`system`), `body_doc` JSON, `body_text` TEXT, `client_msg_id`, `reply_count`, `last_reply_at`, `reply_user_ids` JSON (≤ 3), `edited_at`, `deleted_at`, `deleted_by`, `created_at` | `UNIQUE (conversation_id, seq)`, `UNIQUE (thread_root_id, thread_seq)`, `UNIQUE (conversation_id, client_msg_id)`, `FULLTEXT (body_text)` |
| `message_reactions` | PK `(message_id, user_id, emoji)`, `organization_id`, `created_at` | `emoji` ≤ 64 (unicode o código) |
| `message_mentions` | PK `(message_id, user_id)`, `organization_id`, `conversation_id`, `kind` (`user`·`channel`·`here`) | Para avisos y el contador de menciones |
| `thread_followers` | PK `(thread_root_id, user_id)`, `organization_id` | Autor de la raíz, quien responde y quien es mencionado en el hilo |
| `inactive_users` | PK `(organization_id, user_id)`, `since` | Lo mantiene el consumidor de `identity.user.disabled/enabled` |
| `outbox_messages`, `processed_events` | las de siempre | Formato de `@facturero/outbox-relay` |

Mensajes de sistema (`kind = system`, `body_doc` con un código y parámetros, traducidos en el frontend): se unió, salió, renombró el
canal, cambió el tema, archivó.

## Reglas de acceso

| Acción | Canal público | Canal privado | DM / grupo |
|---|---|---|---|
| Ver en «Explorar canales» | Toda la organización | Solo miembros | — |
| Leer mensajes | Toda la organización (vista previa sin unirse) | Solo miembros (si no, 404) | Solo participantes (si no, 404) |
| Escribir, reaccionar | Miembros (unirse es un clic) | Miembros | Participantes activos |
| Agregar personas | Cualquier miembro | Cualquier miembro | Grupo: crea otro DM de grupo (como Slack); 1-a-1: no |
| Quitar a otro | Dueño del canal o `chat:admin` | Dueño del canal o `chat:admin` (si es miembro) | — |
| Renombrar, tema, descripción | Dueño o `chat:admin` | Dueño o `chat:admin` (si es miembro) | — |
| Archivar / desarchivar | Dueño o `chat:admin` (`#general` nunca) | Dueño o `chat:admin` (si es miembro) | — |
| Editar un mensaje | Su autor | Su autor | Su autor |
| Borrar un mensaje | Autor o `chat:admin` | Autor o `chat:admin` (si es miembro) | Solo su autor |
| `@canal` / `@aquí` | Libre hasta 20 miembros; más: dueño o `chat:admin` | Igual | `@aquí` no aplica |

- Permiso nuevo **`chat:admin`** (Administrador) en las migraciones de auth-service. Cualquier miembro de la organización usa el chat:
  el gateway exige el módulo `comm.internal_chat`, no un permiso. `chat:admin` **no** abre DMs ni canales privados ajenos.
- Persona **inactiva** (`inactive_users`): sale de los canales; sus DMs se ven pero no aceptan mensajes nuevos (409 `USER_INACTIVE`).
- Límite de envío: 30 mensajes por minuto por persona (en memoria; una réplica) → 429.

## Avisos (los calcula chat-service al enviar)

| Situación | Socket (contador y lista) | Navegador (`notifyUserIds`) | Campana (`userIds`) |
|---|---|---|---|
| Mensaje en un canal | Todos los miembros | Quienes tienen `notify = all` y no silenciaron | — |
| `@persona` (miembro) | ✓ | ✓ aunque esté en `mentions` | ✓ |
| `@canal` | ✓ | Todos salvo `notify = none` | ✓ |
| `@aquí` | ✓ | Solo los conectados (lo filtra el hub con la presencia) | — |
| Mensaje en DM / grupo | ✓ | Salvo `notify = none` o silenciado | ✓ |
| Respuesta en un hilo que sigues | ✓ | ✓ | — |
| Silenciado (`muted`) | ✓ | Solo menciones directas | Solo menciones directas |

- Nunca se avisa al autor. La campana se **agrupa por conversación**: notification-service debe colapsar los avisos de chat no leídos de la
  misma conversación en uno («3 mensajes nuevos en #ventas») usando `conversationId` como clave. **Cambio necesario en
  notification-service** (hoy guarda una fila por evento); sin él no se activa el proveedor de campana.
- Proveedor de campana `chat.message.created`, canal **`app` solamente** (sin `smtp`, decisión del dueño), en
  `notification-service/src/provider-config.json` con `pluginCode: 'comm.internal_chat'`.
- La notificación del navegador la muestra el frontend (API `Notification`, permiso pedido con un botón, nunca al cargar) si la pestaña
  está oculta o la conversación no está abierta.

## Integración con el CRM

- **Tarjetas**: nodo `crmLink` en el texto (cliente, factura, tarea, proyecto, producto). Se insertan con «/» o pegando una URL del CRM
  (`/customers/:id`, `/invoices/:id`, `/my-tasks?task=:id`, `/projects/:id`, `/products/:id`). chat-service guarda solo
  `entityType`, `entityId` y la etiqueta del momento; **la tarjeta se completa en el navegador con la API de siempre y los permisos de
  quien la ve** (sin permiso: solo la etiqueta y «sin acceso»). chat-service no llama a otros servicios al enviar.
- **Crear tarea desde un mensaje** (menú ⋯ del mensaje, si la organización tiene `projects.tasks_kanban` y la persona `project:read`, que
  es lo único que projects-service exige para una tarea propia; `project:create` es para crear proyectos):
  el frontend abre el alta de tarea con el texto como título y el enlace al mensaje en la descripción, la crea con la API de Proyectos y
  responde en el hilo con la tarjeta de la tarea. Sin acoplar servicios.
- Enlace permanente a un mensaje: `/messages/:conversationId?m=:messageId` (y `&thread=:rootId`).

---

## Cambios fuera de este repo

| Repo | Cambio | Entregable |
|---|---|---|
| `auth-service` | Migración del permiso `chat:admin` (Administrador) | E2 |
| `plugin-catalog-service` | Migración `20261114110000-chat-core-plugin.cjs`: `comm.internal_chat` → `is_core = 1`, `price_cents = 0`, `build_status = 'disponible'` (estaba `en_construccion`, 3,99) | **E1 (hecho)**: la ruta del gateway lo exige |
| `api-gateway-node` | `ANY /chat/*` → chat-service (`requiresPlugin: 'comm.internal_chat'`, `maxBodyBytes` 64 KB), `CHAT_SERVICE_URL` y `CHAT_INTERNAL_SECRET` (env, k8s), `chat-routing.ts` + prueba, `chat-client.ts`, bind `chat.#` (**E1 hecho**); `chat-socket.ts` (typing, presencia) | E1, E4 |
| `audit-log-service` | Denylist con prefijos: fuera `chat.message.*`, `chat.reaction.*`, `chat.member.*`, `chat.conversation.read` | **E0 (antes de publicar nada)** |
| `notification-service` | Proveedor `chat.message.created` (solo `app`) y colapso por conversación | E2 |
| `document-service` | `GET /files` no lista `resourceType: chat_conversation` (privacidad de DMs y canales privados) + prueba + openapi | E3 |
| `frontend` | `/messages`, `stores/chat.ts`, `api/chat.ts`, `MessageInbox` conectado, contador en el menú, widget, i18n, recorrido | E1–E4 |
| `plugin-catalog-service` (seed) | `seed/plugins-dependencias.json`: `comm.internal_chat` → `status: hecho`, `service: chat-service` (lo lee `check-widgets.mjs`; no toca la base) | E4 |
| raíz | `docker-compose.yml` (`chat-migrate`, `chat-service`), `docker/mysql/init.sql`, AGENTS.md (orden de despliegue) | E1 |

## Entregables

**E1 — Núcleo.** Migración nueva; `#general` creado al primer uso con todo el equipo (contactos de auth); crear canal público/privado,
explorar y unirse, salir, abrir DM y DM de grupo; enviar y listar mensajes (paginado por `seq`, alrededor de un mensaje); no leídos y
línea de «nuevos» (`last_read_seq`); eventos con el relay; consumidor de `identity.*`; hub del gateway entregando `chat.message.created`;
pantalla de tres paneles y bandeja de la barra superior. Hecho cuando: dos navegadores conversan en vivo en un canal y en un DM, los
contadores bajan al leer, y `verify-chat.mjs` pasa los casos de concurrencia (30 envíos simultáneos → `seq` 1..30 sin huecos ni
repetidos; 10 «abrir DM» iguales → una conversación; reenvío con el mismo `client_msg_id` → un mensaje).

**E2 — Conversación completa.** Hilos (panel derecho, contador y avatares), reacciones, editar, borrar (lápida), menciones `@persona`,
`@canal`, `@aquí`, preferencias por conversación (avisos, silenciar), notificaciones del navegador, campana agrupada, permiso
`chat:admin`.

**E3 — Archivos y CRM.** Pegar y adjuntar imágenes y archivos (visor y colores de Proyectos), tarjetas `crmLink`, crear tarea desde un
mensaje, enlace permanente.

**E4 — Presencia, búsqueda y widget.** Punto verde y ausente, «escribiendo…», búsqueda (`FULLTEXT`, solo lo legible), widget «Mensajes sin
leer», recorrido guiado.

**E5 — Producción.** Catálogo (núcleo y gratis), gateway, comprobar que `chat_db` está vacía, desplegar en orden y probar con la sesión del
dueño.

## Orden de despliegue (cuando toque)

1. **audit-log-service** (denylist por prefijos) — antes que nada que publique `chat.*`.
2. **auth-service** (`chat:admin`, E2).
3. **chat-service** (migración nueva; comprobar antes que `chat_db` está vacía). Su `k8s/deployment.yaml` ya toma
   `AUTH_SERVICE_URL` y el Secret `internal-service-secret` (existe en el clúster: lo usan notification-service y otros).
4. **notification-service** (proveedor y colapso, E2).
5. **plugin-catalog-service** (`comm.internal_chat` núcleo y disponible) — **antes que el gateway**: la ruta `/chat/*` exige el módulo.
6. **api-gateway-node** (`/chat/*`, `CHAT_SERVICE_URL`, `CHAT_INTERNAL_SECRET`, hub).
7. **document-service** (no listar adjuntos del chat, E3) **y enseguida fiscal-ecuador** (reejecutar su workflow): ruedan el mismo
   secreto (AGENTS.md, orden de despliegue 2). Antes que el frontend: sin esto los adjuntos de un DM se podrían listar por su id.
8. **frontend**.

---

## Bitácora de construcción

**E1 (2026-11-14).** Decisiones al construir: los eventos no llevan texto (InboxConsumer guarda cada payload en `processed_events`; el
hub pide el mensaje a `/internal/messages/:id`); `CHAT_INTERNAL_SECRET` propio en el gateway (con `INTERNAL_SERVICE_SECRET` se
encendería BUG #9, apagado en producción: ver AGENTS.md); `comm.internal_chat` pasa a núcleo en E1 (la ruta lo exige); escribir marca
leído lo anterior (como Slack). En local el chat va en el puerto 3021 del host (3007 es document-service).

**E2 (2026-11-15).** Bugs que encontró la prueba en el navegador, corregidos: (1) la barra de acciones del mensaje desaparecía al llevar
el ratón al menú ⋯ (la fila perdía el «hover» y se llevaba el menú): ahora se queda mientras haya un menú abierto; (2) «@Ana» ofrecía
primero @canal («c-ana-l»): las menciones especiales coinciden por el principio y salen después de las personas; (3) el botón flotante
del asistente tapaba «Enviar» en el editor pegado al borde derecho. Las menciones dentro de un hilo avisan, pero no suman al contador
de menciones del canal (no tienen `seq`); la vista «Hilos»/«Actividad» de Slack queda para después.

**E3 (2026-11-16).** Archivos con el mismo editor y visor de Proyectos (`uploadFile` en `stores/chat.ts`, el clip fuera del editor con
`attach()` donde no hay barra). Al construir apareció un hueco de privacidad: `GET /files?resourceType=chat_conversation&resourceId=…`
listaba los adjuntos de cualquier conversación a quien supiera su id, y el id de los DM queda en la auditoría: document-service ya no
lista ese tipo (regla 22). Tarjetas: `utils/crm-links.ts` (búsqueda, resolución con caché y `parseCrmUrl`, solo mismo origen),
`CrmLinkCard`, nodo `crmLink` del editor (solo con `crm-links`: Proyectos no lo acepta) y `CrmLinkPicker` («/» con el editor vacío o
el botón). Crear tarea pide `project:read` (no `project:create`, que es crear proyectos). La descripción de la tarea cita solo el texto
plano del mensaje: su documento puede traer @canal o tarjetas que la lista blanca de Proyectos rechaza.

**E4 (2026-11-16).** Gateway: `chat-socket.ts` (`PresenceRegistry`, `chat:typing|presence|activity`) y `chat-members.ts`; el hub usa la
presencia para `@aquí` e invalida la caché con `chat.member.*`. Decisión al construir: un socket entra a la presencia cuando la pestaña
se anuncia con `chat:activity`, no al conectar (la caja POS abre el mismo socket con su `sub`). Bug que encontró la prueba: el primer
«escribiendo…» con el reloj en 0 se descartaba (límite con `?? 0`). Búsqueda: `FULLTEXT` en modo booleano con `+palabra*` (prefijo),
las palabras de menos de 3 letras por LIKE (InnoDB no las indexa), solo lo legible (canal público o miembro; un DM o privado ajeno nunca,
ni con `chat:admin`), cursor por `created_at` + `id`. Frontend: `PresenceAvatar`, «escribiendo…» en la línea de la ayuda (el editor no
salta), `ChatSearchDialog` (resalta sin `v-html`), widget `chat.unread` (grupo «Equipo») y un paso en el recorrido de la app.
Al subir el gateway: `gateway.config.ts` y `k8s/deployment.yaml` mezclan cambios ajenos (SRI, reservas, reporting): van con un
parche solo-chat (`git apply --cached --unidiff-zero`); `main.ts`, `hub.ts`, `env.ts` y los `src/realtime/chat-*` son solo del chat.

**Cierre (2026-11-16).** Faltaba la pantalla de miembros y de datos del canal (la API existía desde E1): `ChannelDetailsDialog`.
«(editado)» pasa a la línea del texto. En el teléfono el margen para el botón del asistente apretaba el editor del hilo (111 px): ahí
ese botón queda bajo la tarjeta y el margen sobra. Trampa vista: un bloque de i18n insertado buscando `  "chat": {` cayó en
`tour.chat` (la línea indentada también casa); `lint:ui` no revisa claves de texto, así que se comprobaron todas a mano. Comandos de
subida en `cmr-proyect/subir-chat/SUBIR.md`.

**Vista «Hilos» (2026-11-16).** Cada seguidor de un hilo lleva su cursor (`thread_followers.last_read_thread_seq`, migración
`20261116100000`). Siguen un hilo el autor de la raíz, quien responde y quien es mencionado (ya era así desde E2). Responder avanza el
cursor propio; abrir el hilo en el navegador lo marca leído hasta la última respuesta cargada (solo si eso lo adelanta). Contadores:
respuestas de otros sin borrar tras el cursor, y menciones a mí tras el cursor; en `/chat/unread` van aparte (`threads`), y el
frontend las suma al globo. Silenciar una conversación saca sus hilos de «nuevos», no sus menciones (regla de E2: silenciar apaga todo
salvo la mención directa). Sin evento propio de «hilo leído»: las otras pestañas se ponen al día con el siguiente aviso o al
reconectar (decisión para no tocar gateway ni auditoría a esta altura).

**Emojis personalizados (2026-11-16).** Tabla `custom_emojis` (migración `20261116110000`); la imagen la sube el navegador a
document-service con `resourceType: chat_emoji` (sin privacidad especial: los emojis son de toda la organización). En el texto, nodo
`emoji` con su nombre (chat-service no comprueba que exista al enviar: si lo quitan, el navegador muestra `:nombre:`); en `body_text`
queda `:nombre:` (búsqueda y campana). Reacciones: `:nombre:` se acepta si el emoji existe (quitar una reacción vieja siempre se puede).
Sin evento propio: los navegadores piden la lista al entrar, al abrir el selector y al ver un nombre que no conocen (con freno). Un
fallo que encontró la prueba: el freno de 5 s descartaba el aviso y un emoji recién subido no aparecía en otros navegadores; ahora la
recarga se reprograma al terminar el freno. Agrega cualquiera del equipo y quita quien lo subió o `chat:admin` (como el ajuste por
defecto de Slack); tope de 500 por organización.
