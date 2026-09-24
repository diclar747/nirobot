# Niro — centro local de Facebook y Messenger

Panel local para publicar, programar y responder en Facebook usando una sesión
de navegador separada. Abre un perfil persistente de Chrome/Edge, lee perfil,
grupos, páginas, Messenger y notificaciones, y guarda todo en PostgreSQL.

## Requisitos

- Node.js 20 o posterior.
- PostgreSQL 14+ (probado con 17) con una base `autofacebook`.
- Una cuenta que pueda iniciar sesión manualmente en Facebook.
- Playwright y su navegador Chromium (o Chrome/Edge instalados).

## Instalación

```powershell
npm install
npx playwright install chromium
copy .env.example .env
```

Crear la base (una sola vez):

```powershell
createdb -h localhost -U postgres -E UTF8 autofacebook
```

`NIRO_DATABASE_URL` en `.env` apunta a esa base. Al primer arranque el panel
crea las tablas y **importa automáticamente** `data/niro.json`. Si
`NIRO_DATABASE_URL` queda vacío, el panel sigue funcionando con el JSON.

La carpeta `data/browser-profile` contiene la sesión de Facebook: tratarla como
una credencial, no subirla ni copiarla a otro equipo.

## Uso

```powershell
npm run panel:iniciar   # en segundo plano, sin ventana (registro en data\logs\panel.log)
npm run panel:detener   # cierra Facebook ordenadamente y detiene el panel
npm start               # o en primer plano, en esta terminal
```

Abrir [http://127.0.0.1:8787](http://127.0.0.1:8787). Para detenerlo usar siempre
`npm run panel:detener` (o Ctrl+C con `npm start`): cortar el proceso de golpe puede
dejar bloqueado el perfil de `data\browser-profile` hasta el próximo arranque.

| Sección | Qué hace |
| --- | --- |
| **Inicio** | Portada del perfil, métricas, actividad de 14 días, tipos de avisos, notificaciones y publicaciones recientes. |
| **Crear publicación** | Destinos: Perfil, Historia, Grupos, Páginas o **Todo** (combinación libre). Adjuntos con vista previa, emojis y vista previa estilo Facebook. “Publicar ahora” en un destino publica directo (la opción “Confirmar antes” pide confirmación); en varios destinos publica uno por uno con la pausa elegida. |
| **Programación** | Calendario mensual (tocar un día agrega una fecha), cola con progreso por destino, preparar/publicar siguiente, publicar pendientes ahora, pausar, reintentar fallidas. |
| **Notificaciones** | Bandeja clasificada (comentarios, reacciones, menciones, Messenger…), detalle, respuesta con confirmación y borrador de Niro. Las nuevas llegan en tiempo real (toast, campana y aviso de escritorio). |
| **Messenger** | Chats sincronizados, historial guardado y respuesta. |
| **Publicaciones** | Historial de todo lo publicado con Niro (manual, programado, automático, masivo) y publicaciones descargadas del perfil, páginas y grupos. |
| **Grupos / Páginas** | Búsqueda, selección múltiple para publicar o descargar publicaciones, exportación CSV. |
| **Datos** | Conexión, sincronizaciones, estado de PostgreSQL y descargas (JSON/CSV). |

## Sincronización a pedido

Por defecto Niro funciona en **modo solo publicar**: no descarga información de
Facebook salvo lo necesario para publicar (perfil, lista de páginas y de grupos).
En **Datos → Sincronización** se elige qué descargar:

| Tipo | Qué guarda |
| --- | --- |
| Perfil, páginas, grupos | Nombre, foto (copia local), contadores de páginas |
| Notificaciones | Comentarios, reacciones, menciones, Marketplace y seguridad, con foto |
| Lista de chats | Conversaciones de Messenger con foto y último mensaje |
| Historial de mensajes | Todos los mensajes de cada chat (lento; también por chat desde Messenger) |
| Historial de publicaciones | Perfil y las páginas/grupos que se elijan (máx. 50 grupos) |

Cada tipo tiene **Solo esto**; “Sincronizar lo seleccionado” corre todo lo marcado
en segundo plano con progreso en vivo. **Detener** corta en cualquier momento y
conserva lo ya descargado. El monitoreo automático revisa solo lo que se marque
(notificaciones y/o chats).

## Respuestas con IA (Niro)

Sección **Respuestas IA**. Niro recibe cada comentario, mención o mensaje nuevo,
lo clasifica y redacta la respuesta con la API de Niro IA
(`POST /api/v1/chat/completions`, clave en `NIRO_AI_API_KEY`).

| Opción | Función |
| --- | --- |
| Activar respuestas con IA | Enciende o apaga el módulo completo |
| Automático / Supervisado / Solo notificar | Modo general; se puede cambiar por cuenta y por publicación |
| Parada de emergencia | Nada se envía solo; todo queda para aprobar, sin perder interacciones |
| Instrucciones por capas | Publicación → campaña → cuenta → general (la más específica manda), con versión |
| Base de conocimiento | Productos, precios y condiciones que Niro puede usar |
| Derivar a agente | Departamento de Niro y agente responsable; “Tomar el hilo” pausa la IA en ese hilo |
| Límites | Máximo por hilo, por hora y largo de respuesta |

**Flujo:** aviso nuevo → interacción (una por evento, sin duplicados) → Niro abre el
comentario en Facebook y lee la publicación original y el hilo → reglas (propio,
hilo tomado, límites, modo) → IA (categoría, respuesta, derivación, prospecto) →
validador (largo, enlaces no autorizados, confianza) → envío, aprobación, derivación
o descarte → historial completo (`ai_reply_audit`).

**Envío verificado:** responde en el hilo exacto (`comment_id`) **con la voz de la
página dueña** de la publicación (diálogo “Tus perfiles y páginas”) y después vuelve
automáticamente al perfil personal, porque ese cambio afecta a toda la sesión.

Cada publicación nueva tiene **“Responder interacciones con Niro”**: usar la
configuración general, instrucciones exclusivas (tema, oferta, datos autorizados,
preguntas frecuentes, tono, contacto, cuándo derivar, modo) o no responder.

Tablas: `social_interactions`, `ai_reply_prompts`, `crm_leads`, `ai_reply_audit`.
Los prospectos con teléfono se envían al CRM de Niro (`/api/v1/whatsapp/contacts`).

## Explorar grupos

Sección **Explorar grupos**: segmentos con palabras clave, catálogo de grupos
encontrados, agenda de solicitudes de ingreso y seguimiento de membresías.

| Pestaña | Qué hace |
| --- | --- |
| Segmentos | Nombre + palabras clave. “Buscar” recorre cada palabra en la búsqueda de grupos de Facebook y agrega los nuevos como “Por revisar”, con privacidad, miembros, actividad y foto (copia local). |
| Catálogo | Filtros por estado, segmento y privacidad; selección múltiple para marcar, leer la ficha (descripción y reglas), descartar o programar. |
| Agenda de solicitudes | Reparte las solicitudes por día (por defecto 5, de 9 a 18 h). Se puede pausar. Si el grupo pide preguntas o aceptar reglas, **no se responden solas**: la tarea queda “Requiere tu intervención” y “Completar en Facebook” abre el grupo con ventana. |
| Membresías | “Revisar ahora” confirma aprobaciones (y suma el grupo a **Grupos** para publicar) y marca las solicitudes rechazadas o vencidas. |

Tablas: `group_segments`, `discovered_groups`, `group_join_tasks` y la vista `group_memberships`.

## CRM

Sección **CRM**: tableros con columnas configurables (y varios embudos por
tablero), tarjetas que se arrastran entre columnas, ficha completa de cada
oportunidad, tareas de seguimiento, contactos, campañas dirigidas y reportes.

**Cómo nace una tarjeta**

| Interacción | En el CRM |
| --- | --- |
| Mensaje de Messenger | Crea o actualiza contacto y tarjeta y vincula la conversación. Si la persona vuelve a escribir, se actualiza la misma tarjeta. |
| Comentario con consulta («precio», «más información», preguntas…) | Interés por comentario ligado a la publicación. La IA completa el texto real, la categoría y los datos que aporte (teléfono, correo). |
| Formulario de Meta, Google Ads o web propio | Prospecto con los datos del formulario y la atribución (campaña, anuncio, formulario). |
| «Me gusta» o compartido | Solo suma métricas de la publicación: no crea tarjetas ni habilita escribirle a la persona. |

- **Autopost:** en *Crear publicación → Enviar interesados al CRM* se elige tablero,
  columna inicial y agente. Viaja con la publicación, sus programaciones y envíos
  masivos. Atribución: red → cuenta → campaña → publicación → interacción →
  contacto → oportunidad → venta.
- **Messenger y Notificaciones:** botón *Enviar al CRM* / *Ver en CRM*. Desde la
  ficha se responde (con confirmación) y se abre la conversación.
- **Movimientos:** cada cambio de columna guarda quién, cuándo y por qué. “Perdida”
  pide el motivo. En pantallas táctiles se mueve con el selector *Etapa* de la ficha.
- **Tareas:** “Volver a contactar el jueves a las 10:00”: Niro avisa al vencer
  (aviso en el panel y de escritorio) y el resultado queda en el historial.
- **Contactos:** identidad por canal; si coinciden nombre, teléfono o correo entre
  canales se **sugiere** unirlos (la unión la decide un agente). *Borrar datos del
  contacto* elimina a la persona con todas sus tarjetas, mensajes y tareas.
- **Campañas:** filtros por tablero, columnas, etiquetas, producto, origen y último
  contacto. La vista previa explica quién no puede recibir el mensaje (sin teléfono,
  sin autorización, fuera de la ventana de 24 h de Messenger). La selección se
  guarda y se descarga en CSV para enviarla desde Niro.
- **Reportes:** interesados, contactados, cotizaciones, ventas y valor ganado; por
  publicación, formulario o campaña, por canal y por responsable; motivos de pérdida.
- **Agentes:** “Trabajás como” deja constancia de quién hizo cada cambio. Los
  permisos por empresa, departamento y tablero necesitan cuentas de usuario propias
  (hoy el panel tiene una sola contraseña).

Tablas: `crm_boards`, `crm_stages`, `crm_contacts`, `crm_contact_identities`,
`crm_opportunities`, `crm_activities`, `crm_tasks`, `crm_stage_history`,
`campaign_sources`, `crm_campaigns` y `campaign_recipients`.

### Formularios de anuncios (webhooks)

Los webhooks no usan la sesión del panel: cada uno verifica su propio secreto y
queda cerrado (HTTP 503) mientras su variable esté vacía. El panel tiene que estar
publicado con HTTPS (proxy o túnel) y el dominio en `NIRO_ALLOWED_HOSTS`.

| Origen | URL | Variables |
| --- | --- | --- |
| Meta Lead Ads | `https://<dominio>/api/crm/webhooks/meta` (campo `leadgen`) | `NIRO_META_VERIFY_TOKEN`, `NIRO_META_APP_SECRET` (firma), `NIRO_META_PAGE_TOKEN` (para traer nombre, teléfono y correo) |
| Google Ads | `https://<dominio>/api/crm/webhooks/google` | `NIRO_GOOGLE_LEAD_KEY` (la clave que se carga en Google Ads) |
| Formulario web propio | `https://<dominio>/api/crm/webhooks/web` | `NIRO_WEB_FORM_TOKEN` (cabecera `x-niro-token`) |

El formulario web recibe JSON: `{"id","name","phone","email","message","campaign","form","fields":{}}`.

## Apariencia

- **Color del sistema** (botón de color en la barra superior): Azul, Violeta,
  Verde, Naranja o Grafito en modo oscuro, o Claro con fondo blanco.
- **Menú lateral:** el botón de la izquierda lo minimiza a íconos (el activo queda
  marcado y los avisos pendientes se ven como insignia). En tablet y celular el
  mismo botón abre el menú como panel, y en celular la navegación principal pasa a
  una barra inferior.

## Pruebas

```powershell
npm run check   # sintaxis de todos los módulos
npm test        # pruebas del CRM (sin PostgreSQL ni Facebook)
```

## Navegador en segundo plano

Por defecto Chrome trabaja **sin ventana** (`NIRO_HEADLESS=true`, cambiable en
**Datos → Conexión**). Para iniciar sesión o resolver una verificación de Facebook
usar **Mostrar navegador** y luego **Volver a segundo plano**. La API oficial de Meta
solo cubre páginas; perfil, grupos e historias necesitan el navegador.

## Instagram

Instagram se publica con **Meta Business Suite**, usando la cuenta profesional de
Instagram vinculada a cada página y la misma sesión de Facebook: no se guardan
contraseñas ni cookies de Instagram.

- **Datos → Instagram · cuentas conectadas**: “Revisar cuentas” recorre las páginas y
  marca cada una como Conectada, Desconectada o Requiere atención. “Conectar
  Instagram” abre Business Suite (con ventana) para vincular la cuenta.
- **Crear publicación → Instagram** (o dentro de **Todo** junto con Facebook): elegir
  cuentas, formato **Publicación** (1 archivo o carrusel de hasta 10), **Reel** (un
  video) o **Historia** (una imagen o video), descripción propia con emojis y
  etiquetas, y vista previa. Instagram exige imagen o video.
- Cada destino es un **trabajo independiente** en la cola: si Facebook se publica y
  Instagram falla, se reintenta solo Instagram. Los trabajos de Instagram esperan
  hasta 6 minutos al procesamiento antes de darse por fallidos, y el mensaje avisa
  que hay que revisar antes de reintentar para no duplicar.
- En Business Suite se marca **solo** la cuenta de Instagram del trabajo (nunca
  Facebook a la vez), así cada red tiene su estado.

Tabla: `social_accounts` (plataforma, página, usuario, estado, última revisión).

## Seguridad operativa

- Publicar es directo para poder automatizar; “Confirmar antes” (en Crear publicación)
  vuelve a pedir confirmación. Responder pide confirmación.
- Las programaciones automáticas requieren dos decisiones: marcar **Publicar
  automáticamente** al guardar y activar **Publicación automática**.
- Un candado evita que dos acciones usen la pestaña de Facebook a la vez
  (sincronizaciones, publicaciones, envíos masivos y programador).
- Al cancelar una confirmación, el editor preparado en Facebook se descarta.

## Producción

- **Acceso:** por defecto el panel escucha solo en `127.0.0.1`. Para usarlo desde otra
  máquina definí `NIRO_PANEL_PASSWORD`, `NIRO_SESSION_SECRET` y `NIRO_ALLOWED_HOSTS`, y
  ponelo detrás de un proxy HTTPS (Caddy/Nginx) que envíe `X-Forwarded-Proto`.
- **Protecciones incluidas:** login con cookie firmada (HttpOnly, SameSite=Strict),
  límite de intentos, verificación de `Host` (DNS rebinding), acciones solo por JSON con
  control de `Origin` (bloquea CSRF desde otras páginas) y cabeceras de seguridad.
- **Navegador:** trabaja sin ventana (`NIRO_HEADLESS=true`) con la carpeta
  `data/browser-profile` con la sesión iniciada. Para iniciar sesión la primera vez hace
  falta ver la ventana (en Linux, escritorio o `xvfb-run` + VNC); en Windows, un servicio
  con sesión de usuario (p. ej. pm2 o NSSM).
- **Respaldo:** `pg_dump autofacebook` más la carpeta `data/` (sesión, adjuntos e imágenes).

## Cómo publica en cada destino

| Destino | Método verificado |
| --- | --- |
| Perfil | Cuadro “¿Qué estás pensando?” → Siguiente → Publicar |
| Historia | `/stories/create` (texto o foto/video) → Compartir en historia |
| Grupo | Página del grupo → diálogo “Crear publicación” → Publicar |
| Página | Meta Business Suite `/latest/composer?asset_id=<id>`: publica **como la página** sin cambiar la identidad de la sesión |

Niro solo escribe en el editor del diálogo de publicación; nunca usa cuadros de
comentario o mensajes para publicar.

## Base de datos

Tablas principales: `events`, `drafts`, `chats`, `chat_messages`, `fb_groups`,
`fb_pages`, `fb_profile`, `schedules`, `schedule_jobs`, `publications`,
`fb_posts`, `media`, `app_meta` (más las del explorador de grupos y del CRM,
descritas arriba). Cada fila guarda el objeto completo en `data`
(jsonb) y columnas tipadas para consultas, por ejemplo:

```sql
SELECT target_name, status, run_at FROM schedule_jobs WHERE status = 'queued' ORDER BY run_at;
SELECT kind, count(*) FROM events GROUP BY kind;
```

Si otra copia del panel siguió escribiendo en `data/niro.json`, detener el
panel y reimportar (reemplaza el contenido de PostgreSQL):

```powershell
npm run db:import
```

Si PostgreSQL falla durante la ejecución, el panel escribe una copia de
emergencia en `data/niro.json` y avisa al siguiente arranque.

## Alcance y límites

- Facebook puede cambiar su estructura o pedir verificaciones adicionales; la
  automatización trabaja sobre lo que la sesión muestra, sin APIs privadas.
- La descarga de publicaciones y del historial de chats guarda solo lo que
  Facebook carga al desplazarse.
- La generación de borradores es una plantilla de revisión; `NIRO_DRAFT_WEBHOOK`
  permite conectar un generador propio (por ejemplo, IA) que devuelva
  `{"draft":"..."}`.
