# 05 · Base de datos (PostgreSQL `autofacebook`)

32 tablas + 1 vista. Esquema creado por `db.mjs` (`CREATE TABLE IF NOT EXISTS`, idempotente).
Volcado completo en `base-de-datos/`.

## 1. Patrón común de todas las tablas de colección

| Columna | Tipo | Significado |
| --- | --- | --- |
| `id` | text PK | Id del objeto (uuid o id de Facebook). |
| *columnas tipadas* | varias | Copia de campos útiles para filtrar/ordenar (se reescriben en cada guardado). |
| `data` | jsonb | **Objeto completo** tal como vive en memoria. Es la fuente real: si una columna tipada y `data` difieren, manda `data`. |
| `position` | int | Orden dentro de la colección en memoria. |
| `updated_at` | timestamptz | Último guardado de la fila. |

**Colecciones “append”** (nunca se borran filas desde el panel): `chats`, `chat_messages`,
`events`, `drafts`, `ai_reply_audit`. **El resto se sincroniza por diferencias**: una fila cuyo `id` ya
no está en memoria se borra en el siguiente guardado. Por eso **no insertar/editar desde afuera con
el panel encendido** (ver 02 §3).

## 2. Mapa colección en memoria → tabla

| `store.*` | Tabla | Columnas tipadas |
| --- | --- | --- |
| `profile` | `fb_profile` | name, url, avatar_url, synced_at |
| `groups` | `fb_groups` | name, url, synced_at |
| `pages` | `fb_pages` | name, url, synced_at |
| `posts` | `fb_posts` | owner_type (profile/page/group), owner_id, owner_name, url, text, posted_label, observed_at |
| `chats` | `chats` | name, preview, url, kind, unread_count, message_count, last_message, first_seen_at, last_seen_at, synced_at |
| `messages` | `chat_messages` | chat_id, sender, text, sent_label, url, first_seen_at |
| `events` | `events` | key, source (facebook/messenger), kind, external_id, text, url, read, first_seen_at, last_seen_at |
| `drafts` | `drafts` | event_id, body, status, created_at |
| `schedules` | `schedules` | destination, text, status, auto_publish, next_run_at, completed_count, failed_count, created_at |
| `schedules[].jobs` | `schedule_jobs` | schedule_id, target_type, target_id, target_name, text, run_at, status, attempts, published_at, last_error |
| `publications` | `publications` | target_type, target_id, target_name, text, status, origin, schedule_id, job_id, url, error, created_at |
| `media` | `media` | path, name, mime_type, size, created_at |
| `socialAccounts` | `social_accounts` | platform (instagram), page_id, page_name, username, status, checked_at |
| `aiInteractions` | `social_interactions` | channel, status, category, person_name, account_name, text, final_reply, thread_key, created_at, sent_at |
| `aiPrompts` | `ai_reply_prompts` | scope, scope_id, scope_name, version, mode, changed_at |
| `leads` | `crm_leads` | name, phone, email, interest, channel, created_at (prospectos detectados por la IA) |
| `aiAudit` | `ai_reply_audit` | interaction_id, action, actor, details, at |
| `groupSegments` | `group_segments` | name, keywords text[], last_search_at |
| `discoveredGroups` | `discovered_groups` | name, url, privacy, members, status, segment_ids text[], description, rules, requested_at, member_since |
| `groupJoinTasks` | `group_join_tasks` | group_id, group_name, account, run_at, status, attempts, last_attempt_at, note |
| `crmBoards` | `crm_boards` | name, archived, created_at |
| `crmStages` | `crm_stages` | board_id, pipeline_id, name, kind, sort_order |
| `crmContacts` | `crm_contacts` | name, phone, email, created_at |
| `crmIdentities` | `crm_contact_identities` | contact_id, channel, external_id, display_name, last_inbound_at |
| `crmOpportunities` | `crm_opportunities` | board_id, pipeline_id, stage_id, contact_id, title, value, status, agent, source_channel, publication_id, created_at, stage_changed_at |
| `crmActivities` | `crm_activities` | opportunity_id, contact_id, type, channel, text, external_id, actor, at |
| `crmTasks` | `crm_tasks` | opportunity_id, contact_id, title, due_at, agent, status |
| `crmStageHistory` | `crm_stage_history` | opportunity_id, board_id, from_stage_id, to_stage_id, actor, reason, at |
| `campaignSources` | `campaign_sources` | kind, network, publication_id, campaign, board_id, created_at |
| `crmCampaigns` | `crm_campaigns` | name, channel, total, available, created_at |
| `campaignRecipients` | `campaign_recipients` | campaign_id, contact_id, opportunity_id, channel, status, reason, created_at |
| `meta` | `app_meta` (key `meta`, `value` jsonb) | configuración, ver §4 |

Vista `group_memberships`: grupos descubiertos en estado `requested`, `member`, `rejected` o
`attention` con fechas de solicitud/ingreso, última revisión y nota.

## 3. Valores de estado

| Campo | Valores |
| --- | --- |
| `schedules.status` | queued, paused, completed, failed |
| `schedule_jobs.status` | queued, running, published, failed |
| `schedule_jobs.target_type` / `publications.target_type` | profile, story, group, page, instagram |
| `publications.origin` | manual, schedule, scheduler, bulk |
| `publications.status` | published, failed |
| `events.kind` | comment, reaction, mention, message, marketplace, security, other |
| `social_interactions.status` | queued, processing, pending, approved, sending, sent, ignored, derived, notified, error |
| `social_interactions.channel` | comment, mention, messenger |
| `discovered_groups.status` | review, selected, scheduled, requested, member, rejected, discarded, attention |
| `group_join_tasks.status` | scheduled, done, attention, failed, cancelled |
| `crm_stages.kind` | new, contacted, quote, followup, open, won, lost |
| `crm_opportunities.status` | open, won, lost |
| `crm_contact_identities.channel` | messenger, instagram, comment, mention, meta_form, google_form, web_form, manual |

## 4. `app_meta` (clave `meta`)

Un único objeto jsonb con:

| Clave | Contenido |
| --- | --- |
| `lastScanAt`, `lastInventoryAt`, `lastChatSyncAt`, `lastPostSyncAt` | Marcas de tiempo de sincronización. |
| `syncSettings` | Qué sincronizar y qué vigila el monitor (ver API `PATCH /api/sync/settings`). |
| `browser` | `userAgent` corregido para modo sin ventana y `headless` (si se cambió desde el panel; si no, manda `NIRO_HEADLESS`). |
| `aiReplies` | Configuración de IA (modo, canales, límites, base de conocimiento, derivación, hilos tomados). |
| `crm` | Tablero por defecto, reglas de captura, agentes, departamentos. |
| `groupsExplorer` | `{paused: bool}` agenda de solicitudes. |

```sql
-- ver la configuración
SELECT jsonb_pretty(value) FROM app_meta WHERE key = 'meta';
-- pausar la agenda de grupos ANTES de arrancar el panel
UPDATE app_meta SET value = jsonb_set(value, '{groupsExplorer,paused}', 'true') WHERE key = 'meta';
-- apagar la IA antes de arrancar
UPDATE app_meta SET value = jsonb_set(value, '{aiReplies,enabled}', 'false') WHERE key = 'meta';
```

## 5. Consultas útiles (lectura: seguras con el panel encendido)

```sql
-- próximas publicaciones automáticas
SELECT target_type, target_name, run_at, status FROM schedule_jobs WHERE status = 'queued' ORDER BY run_at;
-- publicaciones por destino y estado
SELECT target_type, status, count(*) FROM publications GROUP BY 1,2 ORDER BY 1,2;
-- agenda de solicitudes a grupos
SELECT run_at::date AS dia, count(*) FROM group_join_tasks WHERE status = 'scheduled' GROUP BY 1 ORDER BY 1;
-- embudo del CRM
SELECT s.name, count(o.*) FROM crm_stages s LEFT JOIN crm_opportunities o ON o.stage_id = s.id AND o.status = 'open'
GROUP BY s.name, s.sort_order ORDER BY s.sort_order;
-- contactos con teléfono (para WhatsApp)
SELECT name, phone, email FROM crm_contacts WHERE phone IS NOT NULL AND phone <> '';
-- campo que solo está en data
SELECT id, data->>'avatarUrl' AS foto, data->>'lastActive' AS actividad FROM fb_groups LIMIT 10;
```

## 6. Archivos que acompañan a la base

- `media.path` guarda la ruta absoluta del archivo en `data/uploads/`. Al mover el sistema a
  otro equipo, el servidor **re-ubica solo** cada adjunto en la carpeta `data/uploads` local
  (por nombre de archivo) al arrancar.
- Las fotos (`avatarUrl`, `image`) se guardan como `/api/images/<archivo>` y el archivo vive en
  `data/images/`. Copiar esa carpeta junto con la base.

## 7. Importar / reiniciar

- `npm run db:import`: reemplaza TODO el contenido de PostgreSQL por `data/niro.json` (con el panel detenido).
  **No usarlo con este paquete**: el JSON viejo se excluyó a propósito; la base restaurada es la fuente correcta.
- Base vacía + `data/niro.json` presente ⇒ importación automática al primer arranque.
- Aviso al arrancar “`niro.json` es más reciente que PostgreSQL”: informativo; solo importar si otra
  copia del panel siguió escribiendo en el JSON. **Con el paquete, la base es la fuente correcta.**
