# Checklist — mensajería tipo Slack

Marca con `[x]` al terminar cada punto **y verificarlo** (no al escribirlo). Reglas y detalle de cada punto en `IMPLEMENTATION.md`.
`(repo)` indica dónde va el cambio cuando no es chat-service.

## E0 — Antes de publicar nada

- [x] (audit-log-service) `AUDIT_DENYLIST` acepta prefijos (`chat.message.`) y excluye `chat.message.*`, `chat.reaction.*`, `chat.member.*`, `chat.conversation.read`; prueba `denylist.test.ts`
- [x] (audit-log-service) typecheck y pruebas en verde (66)
- [x] Decisión: los eventos no llevan texto; el hub pide el mensaje a `GET /internal/messages/:id` (contratos ajustados)

## E1 — Núcleo

Backend chat-service
- [x] Estructura de projects-service: config, errores, `inTransaction` con reintento ante deadlock, unidad de trabajo, middlewares (actor desde `X-User-Id` / `X-Organization-Id` / `X-Permissions`), `parseBody`, telemetría OTel
- [x] Migración nueva: borra las tablas viejas y crea `conversations`, `conversation_members`, `messages`, `message_reactions`, `message_mentions`, `thread_followers`, `inactive_users` (+ `outbox_messages`, `processed_events` si faltan)
- [x] Repositorios con SQL explícito (INSERT IGNORE, FOR UPDATE, LOCK IN SHARE MODE) + falsos en memoria para pruebas
- [x] Dominio: tipos, nombre de canal (`name_key`), `dm_key`, reglas de acceso (tabla de IMPLEMENTATION.md), errores
- [x] Texto enriquecido: `richtext.ts` copiado de projects-service + nodo `crmLink`, `body_text`, tope de 4000 caracteres
- [x] Caso de uso: `#general` al primer uso con el equipo (contactos de auth, `X-Internal-Secret`)
- [x] Casos de uso: crear canal, explorar, unirse, salir/quitar, agregar miembros, renombrar/tema/descripción, archivar/desarchivar
- [x] Casos de uso: abrir DM y DM de grupo (idempotente)
- [x] Casos de uso: enviar (seq con `FOR UPDATE`, `client_msg_id` idempotente, unirse al escribir en público), listar (before/after/around), obtener uno
- [x] Casos de uso: marcar leído, no leídos por conversación, `/chat/unread`, preferencias
- [x] Eventos al outbox con `memberUserIds` / `notifyUserIds` / `userIds` (asyncapi)
- [x] Consumidor `identity.user.accepted_invite` / `disabled` / `enabled` (InboxConsumer, cola `chat-service.events`)
- [x] Rutas HTTP `/chat/*` + `/internal/messages/:id` y `/internal/conversations/:id/members`; límite 30 msj/min
- [x] `scripts/check-openapi-routes.mjs` y `check-asyncapi-events.mjs` (+ `npm run verify:*`) en verde
- [x] Pruebas en memoria: acceso (404 en privados y DMs ajenos), aislamiento entre organizaciones, idempotencia, seq — 38 pruebas
- [x] `scripts/verify-chat.mjs` contra MySQL: 30 envíos simultáneos → seq 1..30; 10 «abrir DM» → 1; mismo `client_msg_id` → 1 mensaje; 10 «unirse» → 1 fila

Local
- [x] (raíz) `docker-compose.yml`: `chat-migrate` y `chat-service`; `docker/mysql/init.sql` o `db:create`
- [x] Levantado en Docker local (host 3021 → contenedor 3007; el 3007 del host es document-service); las dos migraciones corren en orden

Gateway
- [x] (api-gateway-node) `ANY /chat/*` → chat-service, `CHAT_SERVICE_URL` (env, k8s, lista de servicios), prueba `chat-routes.test.ts`
- [x] (api-gateway-node) `CHAT_INTERNAL_SECRET` propio desde el Secret `internal-service-secret` (decisión: no encender BUG #9 de rebote; anotado en AGENTS.md)
- [x] (plugin-catalog-service) migración `20261114110000-chat-core-plugin.cjs`: `comm.internal_chat` núcleo, gratis, disponible (adelantado de E5: la ruta lo exige)
- [x] (api-gateway-node) `chat-routing.ts` puro + prueba; `chat-client.ts` (`GET /internal/messages/:id`); bind `chat.#`; bloque en `hub.ts` (233 + 9 pruebas)
- [x] Punta a punta en local (gateway + socket + chat-service + RabbitMQ): mensaje en #general llega en ~85 ms con el texto; DM con aviso; privado ajeno: nada por socket y 404

Frontend
- [x] Decidido con el dueño: `/messages` sin `PageHeader`
- [x] Excepción anotada en `frontend/docs/UI-UX.md` (`lint:ui` no la marca: la vista no escribe un título a mano)
- [x] `types/chat.ts`, `api/chat.ts`, `stores/chat.ts` (envío optimista con `clientMsgId`, leído, resync al reconectar), `socket.on('chat.*')` en `utils/realtime.ts`; reset al cerrar sesión
- [x] `/messages/:conversationId?`: barra de canales y DMs con no leídos, conversación con separadores de día, rachas y línea de «nuevos», editor (`RichTextEditor` con `enter-sends`), unirse, salir, archivar, crear canal, explorar, abrir DM; teléfono un panel a la vez
- [x] `MessageInbox.vue` (sobre → foro) conectado a `/chat/unread`; «Mensajes» en el menú lateral con contador (`NavItem.badge`)
- [x] i18n es/en/fr (`chat.*`, `nav.messages`); etiquetas `audit.event.chat_*` de los 12 eventos (las exige `check-audit-labels`)
- [x] `lint:ui` (213), typecheck, pruebas (544, con `utils/chat.test.ts`) y build en verde
- [x] Prueba en dos navegadores (Playwright): #general se abre sola, Enter envía, llega en vivo a la otra persona (~30 ms), contador en el menú y en el DM, DM nuevo aparece sin recargar, canal privado con candado, teléfono un panel a la vez sin scroll horizontal; sin errores de página

## E2 — Conversación completa

- [x] (auth-service) migración `20261115100000-add-chat-admin-permission.js` (Administrador); `check-permissions.mjs` en verde
- [x] Hilos: responder (`thread_seq` con la raíz bloqueada), listar respuestas, contador, caras, seguidores; un hilo no deja el canal sin leer
- [x] Reacciones (añadir/quitar idempotente, INSERT IGNORE) y sus eventos; en las respuestas HTTP agrupadas con «mía»
- [x] Editar (autor, sin historial) y borrar (autor / `chat:admin` en canales, nunca en DMs ajenos; texto a NULL, lápida)
- [x] Menciones `@persona`, `@canal`, `@aquí` (regla de 20 miembros) y cálculo de avisos; respuestas de hilo: a seguidores y mencionados
- [x] Preferencias por conversación (todos / solo menciones / nada, silenciar) en el menú de la conversación
- [x] (notification-service) proveedor `chat.message.created` (solo `app`) y `collapseBy: conversationId` (una campana con `count`; reintento no suma dos veces)
- [x] Notificación del navegador (botón para pedir permiso en la barra; solo con `notify`, pestaña oculta u otra conversación; una por conversación). Sin prueba automática del aviso en sí (el permiso es del sistema)
- [x] Frontend: panel de hilo (URL `?thread=`), reacciones con selector propio, barra al pasar el ratón con menú ⋯ (editar, borrar, copiar enlace `?m=`), @canal/@aquí y solo miembros en las sugerencias, campana del chat
- [x] Pruebas (chat 49, notification 46, frontend 544) + verify-chat (20 respuestas simultáneas → 1..20; reacción x10 → 1 fila; borrar → texto NULL) + prueba en dos navegadores (reacción, hilo, edición, mención con campana, borrado, silenciar: todo en vivo)

## E3 — Archivos y CRM

- [x] Pegar, soltar y adjuntar imágenes y archivos (document-service, `resourceType: chat_conversation`), visor y fichas de Proyectos; clip en la barra (escritorio) o junto a «Enviar» (teléfono, hilo)
- [x] (document-service) `GET /files` nunca lista `chat_conversation` por la ruta de usuario (el id de un DM sale en la auditoría); prueba
- [x] Tarjetas `crmLink` (cliente, factura, tarea, proyecto, producto): «/» con el editor vacío o el botón abren el buscador; pegar una URL del CRM la vuelve tarjeta; se completan con los permisos de quien mira («Sin acceso» si no puede)
- [x] Crear tarea desde un mensaje (con `projects.tasks_kanban` y `project:read`, lo que exige projects-service) y responder en el hilo con la tarjeta
- [x] Enlace permanente `/messages/:conversationId?m=…&thread=…` (hecho en E2)
- [x] Prueba en dos navegadores (imagen cargada, ficha de archivo, `GET /files` vacío, tarjeta pegada, «/» → cliente, crear tarea → tarjeta en el hilo y en «Mis tareas» con enlace al mensaje; sin errores de página). Frontend 547 pruebas, document-service 112

## E4 — Presencia, búsqueda y widget

- [x] (api-gateway-node) `chat-socket.ts` (`chat:typing`, `chat:presence`, `chat:activity`; presencia al anunciarse, no al conectar: la caja POS también conecta), `chat-members.ts` con caché de 30 s invalidada por `chat.member.*`; `@aquí` avisa solo a los activos; 5 pruebas con `io` falso (241 en total)
- [x] Punto verde / ausente (barra de DMs y encabezado del DM; ausente a los 10 min sin actividad) y «escribiendo…» en la conversación y en el hilo
- [x] Búsqueda `GET /chat/search` (`FULLTEXT` booleano con prefijo, palabras cortas por LIKE, solo lo legible, cursor) + diálogo con la palabra resaltada que abre el mensaje (`?m=`); 6 pruebas + verify-chat contra el índice real
- [x] Widget «Mensajes sin leer» (grupo nuevo «Equipo», en el tablero por defecto); `comm.internal_chat` marcado `hecho` en `plugin-catalog-service/seed/plugins-dependencias.json`; `check-widgets.mjs` en verde
- [x] Recorrido guiado: paso «Mensajes» en el recorrido de la app (núcleo y gratis: no hay recorrido de compra)
- [x] Prueba en dos navegadores (punto verde y «En línea», «escribiendo…» que se va solo y al enviar, búsqueda por prefijo → mensaje, widget en el Inicio, desconectado tras 30 s de gracia; sin errores de página)

## Cierre antes de subir (2026-11-16)

- [x] «Detalles del canal» (título, contador de miembros o menú): acerca de (nombre, tema, descripción; editable para el dueño o `chat:admin`) y miembros con presencia (sumar: cualquier miembro; quitar: dueño o `chat:admin`; de #general nadie)
- [x] «(editado)» en la misma línea que el texto (`RichTextView` con `suffix`)
- [x] Teléfono: sin desplazamiento horizontal; el editor del hilo ya no se aprieta (el botón del asistente queda bajo la tarjeta)
- [x] Todas las claves `t('…')` del chat existen en es/en/fr (un bloque de i18n había caído en `tour.chat`; `lint:ui` no lo ve)
- [x] Regresión E2, E3, E4 y cierre en navegador: verde (pruebas en `cmr-proyect/subir-chat/pruebas/`)

## Vista «Hilos» (2026-11-16)

- [x] Migración `20261116100000-thread-read-cursor.cjs`: cursor de leído por seguidor (`last_read_thread_seq`) e índice por persona
- [x] `GET /chat/threads` (los que sigo y puedo leer, el de respuesta más reciente primero, con las 2 últimas respuestas y sus no leídos/menciones), `POST /chat/messages/:id/thread/read` (avanza, nunca retrocede ni pasa de la última) y `threads { unread, mentions }` en `/chat/unread`; responder avanza mi cursor; lo silenciado no suma a «nuevos» pero una mención sí; quien sale de un privado deja de ver sus hilos. 5 pruebas + verify-chat contra MySQL
- [x] Frontend: entrada «Hilos» en la barra (negrita si hay respuestas nuevas, número si hay menciones), las menciones en hilos suman al globo del menú y al sobre (fila «Hilos»), vista `/messages/threads` (solo lectura; «Responder» abre el hilo), abrir un hilo lo deja leído, se actualiza en vivo
- [x] La fila «te mencionan» deja de teñir el texto de naranja (fondo con el token, texto normal)
- [x] Prueba en navegador (`subir-chat/pruebas/chat-threads-ui.mjs`) + regresión E2, E3, E4 y cierre: verde

- [x] Barra: «Canales» y «Mensajes directos» se pliegan con un clic en el título (plegadas dejan a la vista lo abierto y lo sin leer, con «N más»; se recuerda en el navegador). Pedido del dueño: la barra se hacía muy larga

## Emojis personalizados (2026-11-16)

- [x] Migración `20261116110000-custom-emojis.cjs` (`custom_emojis`, UNIQUE organización+nombre); `GET/POST /chat/emojis`, `DELETE /chat/emojis/:id` (agrega cualquiera; quita quien lo subió o `chat:admin`); nodo `emoji` en la lista blanca del texto (`:nombre:` en el texto plano); reacciones con `:nombre:` si existe. 5 pruebas + verify-chat (10 altas simultáneas → 1 fila)
- [x] Frontend: pantalla «Emojis personalizados» (subir PNG/GIF/JPG/WebP ≤ 256 KB con nombre), «:» + letras ofrece la lista, `:nombre:` escrito entero se vuelve imagen, botón de emoji en el editor (escritorio), sección «Personalizados» en el selector de reacciones; un emoji que otro acaba de subir aparece solo (recarga la lista al ver un nombre desconocido, con freno de 5 s que reprograma, no descarta)
- [x] Demo: 4 emojis del estudio en la semilla (`:fiesta:`, `:listo:`, `:cafecito:`, `:corazon:`) usados en #cafe
- [x] Prueba en navegador (`subir-chat/pruebas/chat-emoji-ui.mjs`) + regresión: verde

- [x] Editor del chat: todos los botones en la barra de arriba (formato a la izquierda; clip, emoji, tarjeta del CRM y «Enviar» a la derecha), ninguno a los lados (pedido del dueño); en el teléfono y el hilo, la barra sin los de formato

## E5 — Producción

- [x] Comprobar que `chat_db` de producción está vacía (lectura, 2026-11-16): 0 filas en las 8 tablas viejas; MySQL 9.0.1, `innodb_ft_min_token_size = 3`; Secret `internal-service-secret` y Services (`chat-service-node:3007`, `auth-service-node:3001`) existen; gateway con 1 réplica; la ruta de contactos de auth ya está subida
- [x] `node scripts/check-all.mjs --full` en verde (2026-11-16). Commits «solo chat» de los repos mezclados probados en copias limpias: gateway (215 pruebas), notification (38), auth (280), catálogo (193)
- [x] Comandos de commit por repo, en el orden de despliegue de IMPLEMENTATION.md (los sube el dueño)
- [ ] Prueba en producción con la sesión del dueño
- [x] IMPLEMENTATION.md, AGENTS.md, ficha de la bóveda y memoria actualizados
