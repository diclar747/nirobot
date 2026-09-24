# 06 · Guía de integración con otro sistema

Objetivo: incorporar este módulo de Facebook/Instagram (publicar, programar, responder, IA,
explorar grupos, CRM) a una plataforma existente, por ejemplo la de Niro con inicio de sesión
por QR de WhatsApp, usuarios, empresas y su propio CRM/WhatsApp.

---

## 1. Tres reglas que no se pueden romper

1. **Regla de oro de los datos:** mientras el servidor corre, la verdad está en su memoria.
   **Leer PostgreSQL directo = OK. Escribir directo = NO** (se borra o se pisa en el próximo
   guardado). Toda escritura pasa por la API HTTP (`04-API-REFERENCIA.md`).
2. **Una instancia por cuenta de Facebook.** El proceso maneja una sola sesión de Chrome y un
   candado único. Varias cuentas/clientes ⇒ varias instancias (puerto + base + perfil propios).
3. **Las acciones en Facebook son en serie.** Si otra acción usa el navegador, la API devuelve
   409: reintentar con espera (o usar `publish/bulk` y programaciones, que ya encolan).

## 2. Estrategias posibles

### A) Microservicio detrás de la plataforma (RECOMENDADA)
El sistema queda casi igual y la plataforma principal lo consume:

```
 Usuario ─► Plataforma Niro (login QR WhatsApp, usuarios, empresas)
                │  1. valida la sesión del usuario
                │  2. resuelve qué instancia de Facebook le corresponde
                ▼
        Proxy / backend de la plataforma ──HTTP JSON──►  niro-facebook (instancia de la empresa X)
                ▲                                         127.0.0.1:87xx, base autofacebook_x
                └────────────── SSE /api/stream ───────────┘
```
- Ventajas: no se toca la lógica de Facebook (lo más frágil); se actualiza independiente.
- La plataforma guarda un registro `instancias(empresa_id, puerto o url, base, perfil, estado)`.

**Dos formas de mostrar la interfaz:**
1. **Pantallas propias** en la plataforma que llaman a la API (control total del diseño).
2. **Reutilizar la interfaz incluida** bajo un subdominio o ruta del mismo sitio, con el proxy
   inyectando la autenticación (ver §3). Si se quiere dentro de un `<iframe>`, hay que cambiar
   `X-Frame-Options: DENY` en `applySecurityHeaders()` de `server.mjs` por
   `Content-Security-Policy: frame-ancestors https://tu-plataforma` y servir ambos en el mismo
   sitio (la cookie es `SameSite=Strict`).

### B) Varias instancias (multiempresa)
Por cada empresa/cuenta de Facebook:

```bash
createdb -T template0 -E UTF8 autofacebook_empresa42
NIRO_PORT=8842 \
NIRO_DATABASE_URL=postgres://niro:***@localhost:5432/autofacebook_empresa42 \
NIRO_DATABASE=/srv/niro/empresa42/niro.json \
NIRO_BROWSER_PROFILE=/srv/niro/empresa42/browser-profile \
node /opt/niro/sistema/server.mjs
```
Carpetas de datos: hoy `data/uploads` y `data/images` se toman **relativas a la carpeta del
código** (`server.mjs` usa `ROOT/data`). Para varias instancias con un solo código:
- opción simple: una copia de `sistema/` por empresa (son ~1 MB de código + sus datos), o
- cambio pequeño: agregar `NIRO_DATA_DIR` y usarlo en `DATA_DIR` (línea `const DATA_DIR = join(ROOT, "data")`).
Consumo aproximado: 300–600 MB de RAM por instancia con Chrome abierto.

### C) Fusionar el código en otro backend Node
Posible pero más trabajo. Los módulos ya están escritos como **fábricas con dependencias
inyectadas**, así que se pueden reutilizar:

```js
createCrm({ getStore, persist, broadcast, now, cleanText })
createAiReplies({ getStore, persist, broadcast, facebook, now, cleanText, withBrowser })
createGroupsExplorer({ getStore, persist, broadcast, facebook, now, cleanText, withBrowser })
createInstagram({ getStore, persist, broadcast, facebook, now, cleanText, withBrowser, mediaById })
```
Lo que habría que extraer de `server.mjs`: la clase `FacebookAgent`, `withBrowser/exclusive`,
el programador, `recordPublication` y el store. Recomendado solo si la plataforma también es Node
y se quiere un único proceso por empresa.

## 3. Autenticación: unir el login por QR de WhatsApp

Hoy el panel tiene **una contraseña compartida** (`NIRO_PANEL_PASSWORD`) o ninguna. Opciones:

**3.1 Sin tocar código (proxy):** dejar el panel en `127.0.0.1` sin contraseña y que **solo** el
backend/proxy de la plataforma llegue a él. El proxy valida la sesión QR del usuario y reenvía.
Cuidado: cualquiera que alcance el puerto tiene control total; firewall obligatorio.

**3.2 Con contraseña técnica:** definir `NIRO_PANEL_PASSWORD` y que el backend de la plataforma
haga `POST /api/login` una vez, guarde la cookie `niro_session` (dura 14 días, `SESSION_DAYS`) y la
agregue en cada llamada. El usuario final nunca ve esa contraseña.

**3.3 Token de la plataforma (cambio mínimo en `server.mjs`):** reemplazar `isAuthenticated()`
para aceptar un token firmado por la plataforma (p. ej. JWT HS256 con secreto compartido):

```js
// server.mjs — idea de implementación
function isAuthenticated(request) {
  if (!PANEL_PASSWORD && !process.env.NIRO_PLATFORM_SECRET) return true;
  const bearer = String(request.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (bearer && verifyPlatformToken(bearer)) return true;           // firmado por la plataforma
  return validSession(cookieValue(request, "niro_session"));
}
```
El token puede traer `userName` para completar el campo `actor` (quién hizo cada cambio en el
CRM y la IA). Hoy `actor` lo envía la interfaz desde “Trabajás como”.

## 4. Puntos de conexión con WhatsApp y el CRM de Niro

| Necesidad | Qué existe hoy | Cómo conectarlo |
| --- | --- | --- |
| Prospectos detectados por la IA con teléfono | `ai-replies.mjs` → `registerLead()` los envía a `POST {NIRO_AI_API_URL}/whatsapp/contacts` si `crm.pushToNiro` está activo | Ya funciona con la API key de Niro. |
| Contactos del CRM local con teléfono | `crm_contacts.phone`, `GET /api/crm/contacts` | Leer y sincronizar con los contactos de WhatsApp de la plataforma. |
| Campañas a segmentos del CRM | `POST /api/crm/campaigns` + `GET /api/crm/campaigns/:id/recipients?format=csv`; valida consentimiento, teléfono y la ventana de 24 h de Messenger | **Falta el envío real**: tomar la lista `eligible` y mandarla con el módulo de WhatsApp/SMS de la plataforma. |
| Derivar a un agente humano | Configuración de IA `derivation.departmentId` (lista de `GET {API}/whatsapp/departments`) | La plataforma puede mostrar las interacciones `derived` (`GET /api/ai/interactions?status=derived`). |
| Bandeja unificada | SSE `event`, `ai`, `crm` + `GET /api/events`, `GET /api/chats/:id/messages` | Consumir el SSE desde el backend y reenviarlo a la bandeja de la plataforma. |
| Responder Messenger/comentarios desde la plataforma | `POST /api/reply {eventId, text, actor}` | Botón “responder” de la plataforma → esta llamada. |
| Formularios de anuncios | Webhooks `/api/crm/webhooks/{meta,google,web}` | Publicar la instancia con HTTPS y cargar los secretos. |

## 5. Ejemplos de uso desde la plataforma

```js
const NIRO_FB = "http://127.0.0.1:8787";
const call = (path, body, method = body ? "POST" : "GET") =>
  fetch(NIRO_FB + path, {
    method,
    headers: { "content-type": "application/json", cookie: session },   // session = cookie de §3.2
    body: body ? JSON.stringify(body) : undefined,
  }).then(async (r) => { const j = await r.json(); if (!j.ok) throw new Error(j.error); return j; });

// 1) subir imagen y publicar en 3 páginas y 2 grupos, 45 s entre cada uno
const { media } = await call("/api/media", { name: "promo.jpg", mimeType: "image/jpeg", data: base64 });
const { schedule } = await call("/api/publish/bulk", {
  text: "¡Nueva promo!",
  media: [media.id],
  targets: [
    { type: "page", id: "553737567832820" }, { type: "page", id: "..." }, { type: "page", id: "..." },
    { type: "group", id: "1140560453614046" }, { type: "group", id: "..." },
  ],
  spacingSeconds: 45,
});
// 2) seguir el avance
const es = new EventSource(NIRO_FB + "/api/stream");   // en Node: paquete "eventsource"
es.addEventListener("schedule", (m) => console.log(JSON.parse(m.data)));

// 3) programar para mañana 9:00, publicación automática
await call("/api/schedules", {
  destination: "pages", pageIds: ["553737567832820"], text: "Buen día",
  startAt: "2026-09-25T09:00:00-03:00", intervalMinutes: 5, autoPublish: true,
});
await call("/api/scheduler/start", {});

// 4) contactos del CRM con teléfono para WhatsApp
const { contacts } = await call("/api/crm/contacts?q=");
```

## 6. Lista de tareas sugerida para el agente que integra

1. Restaurar base y levantar una instancia (doc 01). Verificar `/api/status` y `/api/db/status`.
2. Iniciar sesión de Facebook en el servidor nuevo (Mostrar navegador).
3. **Pausar** agenda de grupos y programador hasta terminar las pruebas (LEEME §5).
4. Decidir estrategia A/B/C y el método de autenticación (§3).
5. Registrar en la plataforma la instancia por empresa (url interna, base, perfil, estado).
6. Pantallas o proxy de la interfaz; pasar `actor` con el nombre del usuario logueado.
7. Conectar el SSE a las notificaciones de la plataforma.
8. Implementar el envío real de campañas del CRM por WhatsApp/SMS (§4).
9. Publicar con HTTPS y configurar webhooks si se usan formularios de anuncios.
10. Rotar `NIRO_AI_API_KEY` y definir `NIRO_SESSION_SECRET`.

## 7. Qué NO hacer

- No correr dos procesos con el mismo `NIRO_BROWSER_PROFILE` (Chrome bloquea el perfil).
- No correr dos procesos contra la misma base (cada uno borraría lo del otro al guardar).
- No usar el perfil de Chrome personal del usuario como perfil de automatización.
- No automatizar respuestas a preguntas de ingreso de grupos ni aceptar reglas (se dejó a propósito
  como intervención humana).
- No bajar la pausa entre publicaciones masivas por debajo de 20 s (riesgo de bloqueo de Facebook).
