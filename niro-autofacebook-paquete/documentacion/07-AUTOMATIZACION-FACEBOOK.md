# 07 · Automatización de Facebook (cómo funciona por dentro)

Todo vive en la clase `FacebookAgent` de `server.mjs` (más `instagram.mjs` y
`groups-explorer.mjs`). Usa Playwright sobre la interfaz web real, en español.
Facebook cambia su HTML seguido: este documento resume **qué se probó y funciona** para que
quien mantenga el sistema sepa dónde mirar cuando algo deje de andar.

## 1. Navegador

- `chromium.launchPersistentContext(NIRO_BROWSER_PROFILE, {headless, executablePath, userAgent})`.
- Sin ventana: se lee el user agent real y se reemplaza `HeadlessChrome` por `Chrome`
  (guardado en `app_meta.meta.browser.userAgent`); sin eso Facebook entrega una versión reducida.
- `open()` reutiliza la instancia; `close()` cierra ordenadamente; `setHeadless()` reabre.
- `waitForFacebookReady()` espera a que el cuerpo tenga contenido (≤ 25 s). `isLoggedOut()` detecta
  la pantalla de login ⇒ error “El perfil conectado no tiene una sesión activa”.
- `openUrl()` solo permite facebook.com, www.facebook.com, business.facebook.com, messenger.com.

## 2. Publicar

| Destino | Flujo | Métodos |
| --- | --- | --- |
| Perfil | `facebook.com/` → clic en “¿Qué estás pensando…?” → diálogo “Crear publicación” → escribir → adjuntar → “Siguiente” si aparece → **Publicar** | `preparePost` → `prepareComposer` → `publishPrepared` |
| Grupo | URL del grupo → clic en “Escribe algo…” (reintenta hasta ~15 s, los grupos grandes cargan tarde) → mismo diálogo → **Publicar** | `prepareGroupPost`, `groupBlocker` |
| Página | **Meta Business Suite** `business.facebook.com/latest/composer/?asset_id=<pageId>` → en “Publicar en” se deja **solo** la página (desmarca el Instagram vinculado para no hacer publicación cruzada) → **Publicar** | `preparePagePost` + `instagram.selectOnly` |
| Historia | `facebook.com/stories/create` → “Crear una historia de texto” o foto/video → **Compartir en historia** | `prepareStory`, `publishStory` |
| Instagram | Business Suite: `/latest/composer/` (post/carrusel), `/latest/reels_composer/`, `/latest/story_composer/`; en “Publicar en” solo la cuenta IG (nombre de usuario sin espacios) → **Publicar/Compartir** → verificación en `/latest/posts/published_posts?asset_id=` | `instagram.mjs` |

Reglas de seguridad del editor (`visibleEditor({dialogOnly})`):
- Solo se escribe en un `contenteditable`/`textarea` **dentro del diálogo de publicación**
  (texto del diálogo con “Crear publicación”, “Publicar en”, “¿Qué estás pensando?”…).
- Se descartan campos cuyo `aria-label` sugiere comentario, respuesta, mensaje o búsqueda.
  Así nunca se “publica” un comentario en una publicación ajena.
- Adjuntos: `input[type=file]` del diálogo o el botón “Foto/video”.
- Botón final: `/^(Publicar|Post)$/` (o “Compartir en historia”).

Diagnóstico de grupos (`groupBlocker()`), mensajes claros en vez de “no mostró el campo”:

| Texto en la página | Error devuelto |
| --- | --- |
| “está en pausa” | El grupo está en pausa (un admin desactivó publicaciones). |
| “Tu solicitud está pendiente” / “Cancelar solicitud” | Solicitud de ingreso pendiente. |
| “Solo los administradores pueden publicar” | Solo publican administradores. |
| Botón “Unirte al grupo” | La cuenta no es miembro. |
| “Este contenido no está disponible” | Grupo eliminado o inaccesible. |

Casos vistos en producción: *Negocios Encarnación* (pausado por su admin), *Cooperativa Ayacape*
(solicitud pendiente) y *VENTAS ENCARNACION* (carga lenta del cuadro; además exige aprobación del
admin: la publicación queda “pendiente” en el grupo aunque Niro la registre como publicada).

## 3. Leer información

| Qué | Dónde / cómo |
| --- | --- |
| Perfil | Perfil propio: nombre, URL, foto (copia local en `data/images`). |
| Páginas | `facebook.com/pages/?category=your_pages`; el id numérico sale del enlace del centro de anuncios (`ad_center`). |
| Grupos | `facebook.com/groups/joins/` con desplazamiento (hasta 3.000 grupos, 150 rondas). |
| Publicaciones | Artículos con `[aria-posinset]`, texto en `[data-ad-rendering-role=story_message]`; `NIRO_POST_SCROLLS` rondas. |
| Notificaciones | Enlaces `a[href*=notif_id]`; tipo por el parámetro `notif_t` → `classifyEvent()`. |
| Messenger | Lista de hilos; mensajes con `[aria-roledescription][aria-label]` en formato “A las <fecha>, <Remitente>: texto”. |
| Imágenes | `cacheImage()` descarga con la sesión y sirve por `/api/images/<archivo>`. |

La sincronización (`runSyncPlan`) recorre los pasos elegidos (`SYNC_STEPS`), informa progreso por
SSE y revisa `facebook.cancelRequested` en cada ciclo para poder **Detener**.

## 4. Responder comentarios y mensajes

- Comentario: se abre la URL de la notificación (con `comment_id`), se usa el cuadro
  `aria-label^="Responde a"`.
- **Voz de la página:** si la publicación es de una página, se abre el diálogo “Voces disponibles,
  cambiar de perfil” / “Tus perfiles y páginas”, se busca la página y se elige
  (`[role=button][aria-label^="<Página>,"]`). Esto cambia la identidad de **toda la sesión**; al terminar
  se vuelve con el menú de cuenta → “Cambiar a <perfil personal>” (`ensurePersonalProfile`).
- Messenger: abre el hilo y escribe en el cuadro del chat (envío por Messenger probado solo parcialmente
  en vivo; ver 08).

## 5. Explorar grupos

- Búsqueda: `facebook.com/search/groups/?q=<palabra>`; se leen las tarjetas (nombre, privacidad,
  miembros, actividad, si ya es miembro) con desplazamiento.
- Ficha: `/groups/<id>/about` (descripción, reglas, privacidad, miembros, estado de ingreso).
- Unirse: botón “Unirte al grupo” **más alto de la página** (Facebook muestra “Grupos relacionados” con
  sus propios botones “Unirte”; se ignoran). Primero se buscan señales de que ya es miembro.
  Si aparece un diálogo de preguntas/reglas se cierra (Escape) y la tarea queda **attention**.
- Seguimiento: revisa grupos `requested` y detecta aprobación o rechazo.

## 6. Robustez

- Candado único + vigilante de 6 min (ver 02 §4).
- `runWithTimeout()` en cada acción (45 s general, 70–75 s grupos, 6 min Instagram).
- Tras un error de publicación se cierra/resetea el editor para no dejar texto a medias.
- `readableError()` limpia los mensajes de Playwright (quita “Call log” y colores).
- Envíos masivos se retoman tras reiniciar (últimas 12 h).
- Diagnóstico: con `NIRO_DEBUG=true`, `POST /api/browser/snapshot {url, clickSelector, scrolls, screenshot}`
  devuelve botones/campos visibles y guarda una captura en `data/`.

## 7. Qué revisar cuando Facebook cambie algo

1. Reproducir con `NIRO_HEADLESS=false` y mirar la pantalla.
2. Usar `/api/browser/snapshot` para listar los botones/`aria-label` actuales.
3. Ajustar la expresión regular o el selector en el método correspondiente (tabla §2–§5).
4. `npm run check` y `npm test`; probar primero con **preparar** (no publica) antes de publicar.
