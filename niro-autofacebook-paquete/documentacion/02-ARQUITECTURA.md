# 02 · Arquitectura

## 1. Visión general

```
 Navegador del usuario (SPA)                     Otros sistemas (Niro, WhatsApp, webhooks)
   public/index.html + app.js + *-ui.js                  │ HTTP JSON / SSE
            │  fetch JSON  +  EventSource(/api/stream)    │
            ▼                                             ▼
 ┌──────────────────────────── server.mjs (Node.js, http nativo) ────────────────────────────┐
 │ Seguridad: Host permitido · solo JSON en escrituras · control de Origin · login opcional   │
 │ Router /api/*  ──►  handlers  ──►  store (memoria)  ──►  persist() ──► PostgreSQL (db.mjs) │
 │                                      ▲                                   └─► niro.json (respaldo) │
 │ Módulos:  ai-replies.mjs · crm.mjs · groups-explorer.mjs · instagram.mjs                   │
 │ FacebookAgent (Playwright) ── candado único ──► Chrome con perfil persistente             │
 │ Temporizadores: monitor · programador · IA · explorador · CRM · vigilante del candado      │
 └────────────────────────────────────────────────────────────────────────────────────────────┘
            │                                 │
            ▼                                 ▼
   facebook.com / business.facebook.com     API de Niro IA (niro.cnid.com.py/api/v1)
   (sesión real de la cuenta)               chat/completions · whatsapp/contacts · departments
```

- **Sin frameworks.** Servidor con `node:http`, interfaz con JavaScript nativo (sin React
  ni bundler). Cada archivo `.mjs` se lee tal cual; no hay paso de compilación.
- **Una instancia = una cuenta de Facebook = un perfil de Chrome = una base.**
- **No usa APIs privadas de Facebook**: automatiza la interfaz web con la sesión real
  (Playwright). La API oficial de Meta solo se usa para leer formularios de Lead Ads.

## 2. Archivos y responsabilidades

| Archivo | Líneas | Responsabilidad |
| --- | --- | --- |
| `server.mjs` | ~3.850 | Arranque, configuración, store en memoria, persistencia, seguridad HTTP, router de toda la API, SSE, clase `FacebookAgent` (todas las acciones en Facebook), sincronización, programador, envíos masivos, monitor, exportaciones, archivos estáticos. |
| `db.mjs` | ~810 | `PgStore`: crea el esquema, carga el estado completo, guarda por diferencias (upsert + borrado de filas que ya no están), importación/limpieza, estadísticas. |
| `db-import.mjs` | 25 | `npm run db:import`: reemplaza el contenido de PostgreSQL por `data/niro.json`. |
| `ai-replies.mjs` | ~900 | Respuestas con IA: captura de interacciones, instrucciones por capas, llamada a Niro IA, validación, modos, envío como la página correcta, auditoría, prospectos. |
| `crm.mjs` | ~1.210 | CRM: tableros, columnas/embudos, contactos e identidades por canal, oportunidades, actividades, tareas con recordatorio, historial de etapas, campañas, reportes, captura automática desde Messenger/comentarios/formularios. |
| `groups-explorer.mjs` | ~400 | Segmentos, búsqueda de grupos en Facebook, ficha del grupo, solicitud de ingreso, agenda y seguimiento de membresías. |
| `instagram.mjs` | ~275 | Detección de cuentas de Instagram vinculadas a páginas y publicación (post, carrusel, reel, historia) desde Meta Business Suite. |
| `public/index.html` | — | Estructura: barra superior, menú lateral, columna derecha, barra inferior móvil. |
| `public/app.js` | ~2.440 | SPA: router por hash, estado, render de cada sección, acciones delegadas `data-action`, SSE. |
| `public/explorer-ui.js` | ~460 | Pantalla *Explorar grupos*. |
| `public/crm-ui.js` | ~1.000 | Pantalla *CRM* (kanban con arrastrar y soltar, ficha, tareas, contactos, campañas, reportes). |
| `public/appearance.js` | ~100 | Temas de color, menú colapsable, menú móvil. |
| `public/dialogs.js` | ~120 | Diálogos propios (confirmar/preguntar) en lugar de `confirm()`/`prompt()`. |
| `public/styles.css` | ~910 | Estilos (variables CSS, modo oscuro/claro, responsive). |
| `public/login.html` | — | Pantalla de contraseña (solo si `NIRO_PANEL_PASSWORD` está definida). |
| `tests/*.test.mjs` | — | Pruebas del CRM y del explorador con página simulada (sin Facebook ni PostgreSQL). |

## 3. Modelo de datos en memoria y persistencia (IMPORTANTE)

1. Al arrancar, `loadStore()` lee **todas** las tablas a un objeto `store` en memoria:
   `store.groups`, `store.pages`, `store.events`, `store.schedules`, `store.crmContacts`, etc.
   (lista completa en `05-BASE-DE-DATOS.md`).
2. Todo el código trabaja sobre ese objeto. Después de cada cambio llama `persist()`.
3. `persist()` → `PgStore.save(store)`: por cada colección compara el JSON con la última
   foto guardada; si cambió, dentro de **una transacción**:
   - hace *upsert* de cada elemento (`id`, columnas tipadas, `data` jsonb completo, `position`);
   - en colecciones **no** *append*, **borra las filas cuyo id ya no está en memoria**.
4. Las colecciones *append* (`chats`, `messages`, `events`, `drafts`, `aiAudit`) nunca borran filas.
5. `profile` va a `fb_profile` y `meta` (configuración y marcas de tiempo) a `app_meta` (clave `meta`).
6. Las escrituras se serializan (una a la vez). Si PostgreSQL falla, se escribe una copia de
   emergencia `data/niro.json` y se avisa al siguiente arranque.

**Consecuencias para integrar:**
- La fuente de verdad **mientras corre** es la memoria del proceso. PostgreSQL es su espejo.
- Un `INSERT` externo en una tabla no-append **se borra** en el próximo guardado de esa
  colección, y un `UPDATE` externo **se pisa**. Para escribir, usar la API HTTP.
- Leer directo de PostgreSQL (reportes, BI, otro sistema) **sí es seguro**. La columna `data`
  tiene el objeto completo; las columnas tipadas sirven para filtrar e indexar.
- Si hace falta editar la base a mano: detener el panel, editar, volver a arrancar.

## 4. El navegador y el candado único

`FacebookAgent` (en `server.mjs`) abre Chrome con `chromium.launchPersistentContext(perfil)`
y usa **una sola pestaña principal** (`homePage`). Como todo pasa por esa pestaña:

- `exclusive(response, tarea)` y `withBrowser(tarea)` garantizan que **solo una acción** use
  Facebook a la vez (publicar, sincronizar, responder, IA, explorador, Instagram).
  Si está ocupado, la API responde **409** con el motivo (`busyMessage()`).
- Las tareas en segundo plano (IA, agenda de grupos, programador) reintentan más tarde.
- **Vigilante:** si una acción retiene el navegador más de 6 minutos (`ACTION_MAX_MS`), el
  candado se libera solo para que la cola siga.
- `facebook.cancelRequested` permite detener sincronizaciones y búsquedas largas.
- Modo sin ventana (`NIRO_HEADLESS=true`): se corrige el *user agent* (`HeadlessChrome` →
  `Chrome`) para que Facebook entregue la interfaz normal. Se cambia en vivo con
  `PATCH /api/browser/mode`.
- Identidad: responder como una página cambia la identidad de **toda la sesión**;
  `ensurePersonalProfile()` vuelve al perfil personal antes de publicar en perfil/grupos.

Detalle de cada flujo de Facebook: `07-AUTOMATIZACION-FACEBOOK.md`.

## 5. Procesos automáticos (temporizadores)

| Proceso | Intervalo | Qué hace | Cómo se activa |
| --- | --- | --- | --- |
| Monitor de avisos | `NIRO_POLL_SECONDS` (60 s) | Lee notificaciones y/o chats nuevos (lo marcado en Sincronización) y emite `event`. | `POST /api/monitor/start` / interruptor en Inicio |
| Programador | `NIRO_SCHEDULE_SECONDS` (15 s) | Ejecuta trabajos vencidos de programaciones con *Publicar automáticamente*. | `POST /api/scheduler/start` o `NIRO_SCHEDULER_AUTOSTART=true` |
| Envíos masivos | continuo | Publica uno por uno los destinos de un envío masivo con la pausa elegida. Se retoman tras reiniciar (últimas 12 h). | `POST /api/publish/bulk` |
| IA | 6 s | Procesa la cola de interacciones (clasificar, redactar, enviar). | Configuración de IA `enabled` |
| Explorador de grupos | 20 s | Ejecuta solicitudes de ingreso vencidas de la agenda. | Agenda no pausada + Facebook conectado |
| CRM | 30 s | Recordatorios de tareas vencidas (emite `crm`). | Siempre |
| Vigilante del candado | 30 s | Libera el candado tras 6 min. | Siempre |

Ninguna publicación ocurre sola sin una decisión explícita: las programaciones
automáticas requieren marcar *Publicar automáticamente* **y** tener el programador activo.

## 6. Tiempo real (SSE)

`GET /api/stream` mantiene una conexión `text/event-stream` (ping cada 25 s). Eventos:

| Evento | Cuándo | Datos |
| --- | --- | --- |
| `event` | Aviso nuevo (comentario, mensaje, reacción…) | `{ event }` |
| `schedule` | Cambio en un trabajo programado o masivo | `{ scheduleId, jobId, status, finished? }` |
| `publication` | Nuevo registro en el historial, o borrado | `{ publication }` o `{ deleted: n }` |
| `posts` | Publicaciones descargadas de un origen | `{ owner, count }` |
| `sync` | Fin de un plan de sincronización o de un escaneo | `{ kind: "plan", cancelled }` / `{ kind: "scan", newCount }` |
| `sync-progress` | Avance de la sincronización | estado completo (`running`, `done`, `total`, `detail`, `cancelRequested`…) |
| `ai` | Interacción de IA, instrucciones o configuración | `{ kind: "interaction", id, status }` / `{ kind: "prompts" }` / `{ kind: "settings" }` |
| `instagram` | Revisión de cuentas (progreso/fin) | `{ kind, detail }` |
| `groups-explorer` | Búsquedas, agenda, cambios de estado | `{ kind, ... }` |
| `crm` | Tarjetas, tareas vencidas, capturas | `{ kind, ... }` |

## 7. Seguridad HTTP

- **Host permitido:** solo `127.0.0.1`, `localhost`, `::1` y lo que diga `NIRO_ALLOWED_HOSTS` (si no → 421).
- **Escrituras solo JSON:** `POST/PATCH/PUT/DELETE` requieren `Content-Type: application/json` (si no → 415).
  Obliga a un *preflight* CORS que el servidor nunca aprueba ⇒ otra web no puede disparar acciones.
- **Origin:** si viene cabecera `Origin`, debe coincidir con el propio host (si no → 403).
  Llamadas servidor-a-servidor (sin `Origin`) están permitidas.
- **Login opcional:** con `NIRO_PANEL_PASSWORD`, `POST /api/login {password}` entrega la cookie
  `niro_session` (HMAC con `NIRO_SESSION_SECRET`, HttpOnly, SameSite=Strict, `Secure` detrás de HTTPS).
  Máx. 8 intentos cada 15 min por IP. Sin cookie válida: `/api/*` → 401, páginas → `/login.html`.
- **Webhooks del CRM** (`/api/crm/webhooks/*`) no usan la cookie: cada uno valida su propio secreto.
- Cabeceras: `nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: same-origin`, `COOP: same-origin`.
- HTML con `no-store`; JS/CSS con versión en la URL (`?v=`) para evitar caché vieja.
- Diagnóstico (`/api/browser/snapshot`, `/api/browser/debug`) solo con `NIRO_DEBUG=true`.

## 8. Interfaz (SPA)

- Router por hash: `#/home`, `#/publicar`, `#/programacion`, `#/notificaciones`, `#/messenger`,
  `#/publicaciones`, `#/grupos`, `#/explorar`, `#/paginas`, `#/borradores`, `#/datos`,
  `#/respuestas`, `#/crm`. `ROUTES` en `app.js`; `explorer-ui.js` y `crm-ui.js` registran
  las suyas (`ROUTES.explorar = ...`, `ROUTES.crm = ...`). Solo `app.js` se carga como
  `<script type="module">` y él importa el resto.
- Estado global `state` en `app.js`; `refresh()` trae `/api/dashboard` y listas; cada vista se
  vuelve a dibujar con `renderView()` (conserva el foco si el usuario está escribiendo).
- Acciones: todo botón tiene `data-action="nombre"`; un único `click` delegado busca
  `actions[nombre]`. Los módulos (`explorer-ui.js`, `crm-ui.js`) agregan las suyas con
  `Object.assign(actions, {...})`.
- `request(path, options)` agrega `Content-Type: application/json` y maneja 401 (vuelve al login).
- Preferencias por navegador en `localStorage` (tema, menú colapsado, confirmar antes de publicar).

## 9. Variables de entorno (todas)

| Variable | Por defecto | Uso |
| --- | --- | --- |
| `NIRO_PORT` | 8787 | Puerto HTTP. |
| `NIRO_HOST` | 127.0.0.1 | Interfaz de escucha. |
| `NIRO_DATABASE_URL` (o `DATABASE_URL`) | — | Conexión PostgreSQL. Vacía ⇒ modo JSON. |
| `NIRO_DATABASE` | `./data/niro.json` | Archivo JSON (modo JSON, importación inicial, copia de emergencia). |
| `NIRO_BROWSER_PROFILE` | `./data/browser-profile` | Perfil persistente de Chrome. |
| `NIRO_BROWSER_EXECUTABLE` | Chrome/Edge de Windows si existen | Ruta del navegador; vacío en Linux ⇒ Chromium de Playwright. |
| `NIRO_HEADLESS` | true | Chrome sin ventana. |
| `NIRO_POLL_SECONDS` | 60 | Intervalo del monitor. |
| `NIRO_SCHEDULE_SECONDS` | 15 | Intervalo del programador. |
| `NIRO_SCHEDULER_AUTOSTART` | false | Arranca el programador con el servidor. |
| `NIRO_MAX_CHATS` | 500 | Tope de chats al sincronizar. |
| `NIRO_CHAT_HISTORY_PAGES` | 30 | Rondas de desplazamiento por chat. |
| `NIRO_MAX_CHAT_MESSAGES` | 5000 | Tope de mensajes guardados. |
| `NIRO_POST_SCROLLS` | 12 | Rondas al descargar publicaciones. |
| `NIRO_DRAFT_WEBHOOK` | — | URL que recibe `{source,text,url,externalId}` y devuelve `{"draft":"..."}`. |
| `NIRO_PANEL_PASSWORD` | — | Activa el login. |
| `NIRO_SESSION_SECRET` | derivado de la contraseña | Firma de la cookie. |
| `NIRO_ALLOWED_HOSTS` | — | Hosts extra permitidos (coma). |
| `NIRO_DEBUG` | false | Habilita endpoints de diagnóstico. |
| `NIRO_AI_API_URL` | `https://niro.cnid.com.py/api/v1` | API de Niro IA. |
| `NIRO_AI_API_KEY` | — | Clave `niro_...`. |
| `NIRO_META_VERIFY_TOKEN` / `NIRO_META_APP_SECRET` / `NIRO_META_PAGE_TOKEN` / `NIRO_META_GRAPH_VERSION` | — / — / — / v23.0 | Webhook de Meta Lead Ads. |
| `NIRO_GOOGLE_LEAD_KEY` | — | Webhook de Google Ads. |
| `NIRO_WEB_FORM_TOKEN` | — | Webhook de formulario web propio. |

## 10. Límites fijos en el código

- Adjunto: máx. 100 MB por archivo (`MAX_MEDIA_BYTES`), enviado en base64 dentro del JSON.
- Texto de publicación: 3 a 5.000 caracteres. Descripción de Instagram: 2.200.
- Envío masivo: pausa entre destinos 20 s a 1 h (por defecto 45 s).
- Tiempo máximo por trabajo: 45 s (perfil/página/historia), 75 s (grupo), 6 min (Instagram).
- Agenda de grupos: 1 a 20 solicitudes por día.
