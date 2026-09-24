# 04 · Referencia de la API HTTP

Base: `http://127.0.0.1:8787` (o el dominio publicado). Todas las respuestas son JSON con
`ok: true|false`; en error llega `error` con un mensaje en español listo para mostrar.

## 0. Reglas comunes

| Regla | Detalle |
| --- | --- |
| Escrituras | `POST`, `PATCH`, `DELETE` **deben** llevar `Content-Type: application/json` (si no → 415). |
| Origin | Si se envía `Origin`, debe ser el mismo host del panel (si no → 403). Llamadas de servidor a servidor: no enviar `Origin`. |
| Host | La cabecera `Host` debe estar en `127.0.0.1`, `localhost`, `::1` o `NIRO_ALLOWED_HOSTS` (si no → 421). |
| Sesión | Si hay `NIRO_PANEL_PASSWORD`: `POST /api/login {"password"}` → cookie `niro_session`; sin ella `/api/*` → 401 `{login:true}`. |
| Navegador ocupado | Acciones sobre Facebook responden **409** con el motivo si otra acción usa el navegador. Reintentar después. |
| Tareas largas | Responden **202** y siguen en segundo plano; el avance llega por SSE (`/api/stream`). |
| Códigos | 200 ok · 201 creado · 202 aceptado · 400 datos inválidos · 401 sin sesión · 404 no existe · 409 ocupado/fallo de Facebook · 415/403/421 seguridad · 500 interno. |

Ejemplo (Node/servidor):
```js
const res = await fetch("http://127.0.0.1:8787/api/publish/bulk", {
  method: "POST",
  headers: { "content-type": "application/json", cookie: "niro_session=..." }, // cookie solo si hay contraseña
  body: JSON.stringify({ text: "Hola", targets: [{ type: "page", id: "553737567832820" }], spacingSeconds: 45 }),
});
const data = await res.json(); // { ok, schedule }
```

---

## 1. Sesión, estado y tiempo real

| Método y ruta | Cuerpo / consulta | Respuesta y efecto |
| --- | --- | --- |
| `POST /api/login` | `{password}` | Cookie de sesión (8 intentos / 15 min por IP). |
| `POST /api/logout` | — | Borra la cookie. |
| `GET /api/status` | — | Estado general: navegador abierto, monitor, programador, almacenamiento (`engine`), pendientes de IA, resumen del CRM, etc. |
| `GET /api/dashboard` | — | Todo lo que necesita el panel en una llamada (perfil, grupos, páginas, eventos, chats, programaciones, métricas). |
| `GET /api/stream` | — | SSE. Eventos: `event, schedule, publication, posts, sync, sync-progress, ai, instagram, groups-explorer, crm` (ver 02 §6). |
| `GET /api/db/status` | — | Motor y conteo por tabla. |

## 2. Navegador (sesión de Facebook)

| Método y ruta | Cuerpo | Efecto |
| --- | --- | --- |
| `POST /api/browser/open` | `{}` | Abre Chrome con el perfil persistente (si hay que iniciar sesión, usar modo con ventana). |
| `POST /api/browser/close` | `{}` | Cierra Chrome; detiene monitor y programador. |
| `PATCH /api/browser/mode` | `{headless: bool}` | Cambia entre segundo plano y con ventana (reabre el navegador). |
| `POST /api/browser/restore-profile` | `{}` | Limpia bloqueos del perfil tras un cierre forzado. |
| `POST /api/browser/open-url` | `{url}` | Abre una URL de facebook.com / business.facebook.com / messenger.com en la pestaña. |
| `GET /api/browser/debug` · `POST /api/browser/snapshot` | `{url, waitMs, click, clickSelector, scrolls, selector, screenshot}` | **Solo con `NIRO_DEBUG=true`.** Diagnóstico de selectores. |

## 3. Datos de Facebook (lectura y sincronización)

| Método y ruta | Cuerpo / consulta | Efecto |
| --- | --- | --- |
| `GET /api/profile` | — | Perfil conectado. |
| `POST /api/profile/scan` | `{}` | Relee el perfil. |
| `GET /api/groups` · `POST /api/groups/scan` | — | Lista / relee los grupos donde es miembro. |
| `GET /api/pages` · `POST /api/pages/scan` | — | Lista / relee las páginas administradas (id numérico). |
| `GET /api/chats?limit=` | — | Chats de Messenger. |
| `GET /api/chats/:id/messages` | — | Mensajes guardados del chat. |
| `POST /api/chats/:id/sync` | `{}` | Descarga el historial de ese chat. |
| `POST /api/chats/scan` | `{deep}` | Lee la lista de chats (y mensajes si `deep`). |
| `GET /api/events?limit=` | — | Notificaciones/avisos. |
| `PATCH /api/events/:id` | `{read: bool}` | Marca leído/no leído. |
| `POST /api/events/read-all` | `{}` | Marca todo leído. |
| `POST /api/scan` | `{deep}` | Lee notificaciones y chats nuevos ahora. |
| `GET /api/drafts` · `PATCH /api/drafts/:id` | `{body, status}` | Borradores de respuesta. |
| `GET /api/posts?ownerType=&ownerId=` | — | Publicaciones descargadas. |
| `POST /api/posts/scan` | `{profile, pageIds[], allPages, groupIds[]}` | Descarga publicaciones (202, progreso por SSE). |
| `POST /api/posts/delete` | `{ids[]}` | Borra publicaciones descargadas (solo en Niro). |
| `GET /api/sync/state` | — | Configuración y estado de la sincronización. |
| `PATCH /api/sync/settings` | `{profile, pages, groups, notifications, chats, chatHistory, postsProfile, monitorNotifications, monitorChats, postPageIds[], postGroupIds[] (máx. 50)}` (booleanos salvo las listas) | Qué sincronizar y qué vigila el monitor. |
| `POST /api/sync/run` | `{items[], chatIds[], postsProfile, postPageIds[], postGroupIds[]}` | Corre la sincronización (202). `items`: `profile, pages, groups, notifications, chats, chatHistory, posts`. Sin `items` usa la configuración. |
| `POST /api/sync/cancel` | `{}` | Detiene la sincronización en curso (conserva lo descargado). |
| `POST /api/sync/all` | `{}` | Sincronización completa (compatibilidad). |
| `GET /api/images/:archivo` | — | Imagen cacheada (`group-<id>.jpg`, `page-<id>.jpg`, `chat-…`, `post-…`). |
| `GET /api/export?kind=&format=json|csv` | — | Descarga. `kind`: `all, profile, groups, pages, chats, messages, events, drafts, schedules, publications, posts, crm-contacts, crm-opportunities`. |

## 4. Adjuntos

| Método y ruta | Cuerpo | Respuesta |
| --- | --- | --- |
| `POST /api/media` | `{name, mimeType, data}` — `data` en base64 (acepta `data:...;base64,`). Máx. 100 MB. | `201 {media:{id, name, mimeType, size}}`. Usar el `id` en `media[]` al publicar. |
| `GET /api/media/:id/file` | — | Devuelve el archivo (vista previa). |

## 5. Publicar en Facebook

Todas estas usan el navegador (candado). `media` es una lista de ids de `/api/media`.
`ai` (opcional) configura la IA para esa publicación: `{mode: "inherit"|"custom"|"off", campaign, fields:{...}}`.

| Método y ruta | Cuerpo | Efecto |
| --- | --- | --- |
| `POST /api/publish` | `{text, media[], ai}` | Publica en el **perfil**. |
| `POST /api/story` | `{text, media[], ai}` | Publica una **historia**. |
| `POST /api/group-post` | `{groupId, text, media[], ai}` | Publica en un **grupo**. |
| `POST /api/page-post` | `{pageId, text, media[], ai}` | Publica **como la página** (Business Suite, solo esa página marcada). |
| `POST /api/publish/prepare` · `/api/story/prepare` · `/api/group-post/prepare` · `/api/page-post/prepare` | igual sin `ai` | Solo deja el editor listo (no publica). Luego `publish` o `cancel`. |
| `POST /api/publish/cancel` | `{}` | Descarta el editor preparado. |
| `POST /api/publish/bulk` | `{text, targets:[{type:"profile"|"story"|"group"|"page", id}], instagramTargets:[{id, format}], instagramCaption, media[], spacingSeconds (20–3600, def. 45), ai}` | **Envío masivo** en segundo plano (202, `{schedule}`); un trabajo por destino. |

Errores típicos de grupo (409): grupo en pausa, solicitud pendiente, no es miembro, solo publican
administradores, grupo no disponible, “Facebook no mostró el campo para escribir la publicación”.

## 6. Programaciones

| Método y ruta | Cuerpo | Efecto |
| --- | --- | --- |
| `GET /api/schedules` | — | Lista con sus trabajos (`jobs`). |
| `POST /api/schedules` | `{destination: "profile"|"story"|"groups"|"pages"|"instagram"|"all", groupIds[], pageIds[], includeProfile, includeStory, instagramTargets[], instagramCaption, text, media[], startAt (ISO), intervalMinutes (1–10080), entries:[{runAt, text, media[], targetIds[]}], autoPublish, ai}` | Crea la programación. Con `entries` cada fecha puede tener texto/adjuntos/destinos propios. |
| `PATCH /api/schedules/:id` | `{autoPublish, status: "queued"|"paused", retryFailed: true}` | Cambia modo, pausa/reanuda, reintenta fallidas. |
| `DELETE /api/schedules/:id` | — | Elimina la programación. |
| `POST /api/schedules/:id/run` | `{}` | Publica ahora todos sus pendientes (202). |
| `POST /api/schedules/:id/prepare` · `/publish` | `{jobId}` | Prepara / publica un trabajo puntual. |
| `POST /api/scheduler/start` · `/stop` | `{}` | Enciende/apaga el programador automático. |
| `POST /api/monitor/start` · `/stop` | `{}` | Enciende/apaga el monitor de avisos. |

Estados de trabajo: `queued`, `running`, `published`, `failed`. De programación: `queued`, `paused`, `completed`, `failed`.

## 7. Historial de publicaciones

| Método y ruta | Cuerpo / consulta | Efecto |
| --- | --- | --- |
| `GET /api/publications?limit=` | — | Historial (manual, programado, automático, masivo). |
| `POST /api/publications/delete` | `{ids[]}` | Borra registros (solo en Niro). |
| `POST /api/publications/:id/status` | `{status: "published"|"failed"}` | Corrige el estado (p. ej. “Marcar publicada”). |

## 8. Responder

| Método y ruta | Cuerpo | Efecto |
| --- | --- | --- |
| `POST /api/reply/prepare` | `{eventId, text}` | Abre el hilo del aviso y deja la respuesta escrita. |
| `POST /api/reply` | `{eventId, text, actor}` | Envía la respuesta (comentario o Messenger). Queda en el CRM si corresponde. |

## 9. Instagram

| Método y ruta | Cuerpo | Efecto |
| --- | --- | --- |
| `GET /api/instagram/accounts` | — | Cuentas detectadas `{id, pageId, pageName, username, status}` + estado de la revisión. |
| `POST /api/instagram/discover` | `{pageIds[]?}` | Revisa qué páginas tienen Instagram vinculado (202; SSE `instagram`). |
| `POST /api/instagram/publish` | `{accountId, format: "post"|"reel"|"story", caption, media[], ai}` | Publica (hasta 6 min de espera al procesamiento). Instagram exige imagen o video. |
| `POST /api/instagram/prepare` | `{accountId}` | Solo abre el editor de Business Suite. |
| `POST /api/instagram/connect` | `{pageId}` | Abre Business Suite con ventana para vincular Instagram a la página. |

## 10. Respuestas con IA

| Método y ruta | Cuerpo / consulta | Efecto |
| --- | --- | --- |
| `GET /api/ai/state` | — | `{settings, stats, prompts, departments}`. |
| `PATCH /api/ai/settings` | parcial: `{enabled, emergencyStop, mode: "automatic"|"supervised"|"notify", channels:{comments, mentions, messenger}, accounts:{"page:<id>": modo}, voice, offTopic, knowledgeBase, limits:{maxRepliesPerThread, cooldownMinutes, maxPerHour, maxLength}, derivation:{departmentId, departmentName, agentName}, crm:{pushToNiro}}` | Guarda configuración. |
| `GET /api/ai/interactions?status=&category=&channel=` | — | Bandeja. Estados: `queued, processing, pending, approved, sending, sent, ignored, derived, notified, error`. |
| `POST /api/ai/interactions/:id/:accion` | `approve {reply}` · `edit {reply}` · `regenerate` · `derive {reason}` · `ignore` · `retry` · `takeover {agent}` · `release` | Acciones sobre una interacción. |
| `POST /api/ai/prompts` | `{id?, scope: "general"|"account"|"campaign"|"publication", scopeId, scopeName, mode, fields:{topic, offer, facts, faq, tone, contact, escalate, instructions}}` | Crea/versiona instrucciones. |
| `DELETE /api/ai/prompts/:id` | — | Borra instrucciones. |
| `POST /api/ai/test` | `{comment, postText, accountKey, campaign, publicationKey, channel, personName}` | Simula sin enviar: categoría, respuesta, capas usadas. |
| `POST /api/ai/backfill` | `{hours}` | Encola avisos de las últimas N horas. |
| `GET /api/ai/leads` · `GET /api/ai/audit?interaction=` | — | Prospectos detectados / auditoría. |

## 11. Explorar grupos

| Método y ruta | Cuerpo | Efecto |
| --- | --- | --- |
| `GET /api/explorer/state` | — | `{statuses, segments, groups, tasks, settings:{paused}, job, account}`. |
| `POST /api/explorer/segments` | `{id?, name, keywords: "a, b" | []}` | Crea/edita segmento (máx. 30 palabras). |
| `DELETE /api/explorer/segments/:id` | — | Borra segmento (los grupos quedan). |
| `POST /api/explorer/search` | `{segmentId}` o `{segmentIds[]}` | Busca en Facebook (202; SSE `groups-explorer`). |
| `POST /api/explorer/about` | `{groupIds[]}` (máx. 50) | Lee descripción y reglas. |
| `POST /api/explorer/check` | `{}` | Revisa solicitudes enviadas (¿aprobadas?). |
| `POST /api/explorer/cancel` | `{}` | Detiene la búsqueda/revisión. |
| `POST /api/explorer/groups/status` | `{groupIds[], status: review|selected|discarded|rejected|member|requested}` | Cambia estado (cancela tareas programadas si deja de estar seleccionado). |
| `POST /api/explorer/groups/delete` | `{groupIds[]}` | Quita del catálogo. |
| `POST /api/explorer/schedule` | `{groupIds[], startDate: "AAAA-MM-DD", perDay (1–20), fromHour, toHour}` | Crea la agenda de solicitudes. |
| `POST /api/explorer/tasks/cancel` | `{taskIds[]}` | Cancela solicitudes programadas. |
| `POST /api/explorer/tasks/clear` | `{}` | Borra el historial (no las programadas). |
| `POST /api/explorer/open` | `{groupId}` | Abre el grupo con ventana para completarlo a mano. |
| `POST /api/explorer/settings` | `{paused: bool}` | Pausa/reanuda la agenda. |

## 12. CRM (`/api/crm/*`)

`actor` (opcional, en todas las escrituras) = nombre de quien hace el cambio.

| Método y ruta | Cuerpo / consulta | Efecto |
| --- | --- | --- |
| `GET /crm/state?boardId=` | — | Tablero completo: tableros, columnas, tarjetas, contactos, ajustes. |
| `PATCH /crm/settings` | `{defaultBoardId, capture:{...}, agents[], departments[]}` | Ajustes. |
| `POST /crm/boards` · `DELETE /crm/boards/:id` | `{id?, name, color, description, routingKeywords, pipelines, template, archived}` | Tableros. |
| `POST /crm/stages` · `POST /crm/stages/reorder` · `DELETE /crm/stages/:id` | `{id?, boardId, pipelineId, name, kind, color}` · `{ids[]}` · `{moveTo}` | Columnas. `kind`: new, contacted, quote, followup, open, won, lost. |
| `POST /crm/opportunities` | `{name, phone, email, boardId, stageId, agent, title, product, note, value, priority}` | Tarjeta manual. |
| `GET /crm/opportunities/:id` | — | Ficha completa (contacto, actividades, tareas, historial). |
| `PATCH /crm/opportunities/:id` | `{title, value, product, priority, tags, agent, department, lostReason}` | Edita. |
| `DELETE /crm/opportunities/:id` | — | Borra. |
| `POST /crm/opportunities/:id/move` | `{stageId, beforeId, reason}` | Mueve de columna (queda en historial). |
| `POST /crm/opportunities/:id/notes` | `{text, kind, mediaIds[]}` | Nota/actividad. |
| `PATCH /crm/history/:id` | `{reason}` | Motivo de un movimiento. |
| `GET /crm/tasks?scope=open|all` · `POST /crm/tasks` · `PATCH /crm/tasks/:id` | `{opportunityId, title, dueAt, agent, status, result}` | Tareas con recordatorio. |
| `GET /crm/contacts?q=&duplicates=1` | — | Contactos (y sugerencias de duplicados). |
| `PATCH /crm/contacts/:id` · `DELETE /crm/contacts/:id` | `{name, company, notes, tags, phone, email, consent}` | Edita / **borra con todos sus datos**. |
| `POST /crm/contacts/merge` · `/contacts/dismiss-duplicate` | `{targetId, sourceId}` · `{contactId, otherId}` | Unir / descartar sugerencia. |
| `POST /crm/capture/chat` · `/capture/event` | `{chatId|eventId, boardId}` | Enviar un chat o aviso al CRM. |
| `POST /crm/campaigns/preview` | `{boardId, stageIds[], tags[], product, source, lastContactFrom, lastContactTo, channel}` | Quién recibe y quién no (motivo). |
| `GET /crm/campaigns` · `POST /crm/campaigns` | `{name, filters, message}` | Guarda campaña (canal `sms|whatsapp|email|messenger`). |
| `GET /crm/campaigns/:id/recipients?format=csv` | — | Destinatarios (JSON o CSV). |
| `GET /crm/reports?boardId=&from=&to=` | — | Reportes. |
| `GET /crm/webhooks-status` | — | Qué webhooks están configurados. |

### Webhooks de formularios (sin cookie; cada uno con su secreto)

Igual deben cumplir `Content-Type: application/json` y el `Host` permitido.

| Ruta | Autenticación | Cuerpo |
| --- | --- | --- |
| `GET /api/crm/webhooks/meta` | `hub.verify_token` = `NIRO_META_VERIFY_TOKEN` | Verificación de suscripción (devuelve `hub.challenge`). |
| `POST /api/crm/webhooks/meta` | Firma `X-Hub-Signature-256` con `NIRO_META_APP_SECRET` | Payload estándar de Meta (`entry[].changes[].field = "leadgen"`). Los datos se leen de Graph API con `NIRO_META_PAGE_TOKEN`. |
| `POST /api/crm/webhooks/google` | `google_key` = `NIRO_GOOGLE_LEAD_KEY` | Payload de Google Ads (`lead_id`, `user_column_data[]`, `is_test`). |
| `POST /api/crm/webhooks/web` | Cabecera `x-niro-token` (o `token`) = `NIRO_WEB_FORM_TOKEN` | `{id, name, phone, email, message, campaign, form, fields:{}}` → `{ok, duplicate}`. |

Con la variable vacía el webhook responde **503** (cerrado).

## 13. Otros

| Método y ruta | Efecto |
| --- | --- |
| `POST /api/demo` | Carga avisos de ejemplo (solo para probar la interfaz). |
| `GET /` y archivos de `public/` | Interfaz web (`index.html` sin caché; JS/CSS versionados). |
