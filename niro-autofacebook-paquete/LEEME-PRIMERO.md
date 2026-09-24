# Niro Autopost Facebook — paquete completo

**Versión del sistema:** 0.9.0 · **Fecha del paquete:** 24/09/2026
**Origen:** `D:\localhost\git\facebook` (Windows 11, Node.js 24, PostgreSQL 17)

Este comprimido contiene el sistema completo de autopublicación y atención en
Facebook, Messenger e Instagram de Niro: código, base de datos con todos los datos
actuales, archivos multimedia y documentación para que otro desarrollador o agente
continúe el trabajo o lo integre en otro sistema (por ejemplo, la plataforma de
Niro con inicio de sesión por QR de WhatsApp).

---

## 1. Contenido del paquete

```
niro-autofacebook-paquete/
├── LEEME-PRIMERO.md                 ← este archivo
├── MANIFIESTO.txt                   ← lista de archivos con tamaño y SHA-256
├── sistema/                         ← la aplicación lista para instalar
│   ├── server.mjs                   servidor HTTP + automatización de Facebook (núcleo)
│   ├── db.mjs                       capa PostgreSQL (PgStore)
│   ├── db-import.mjs                importa data/niro.json a PostgreSQL
│   ├── ai-replies.mjs               respuestas con IA (API de Niro IA)
│   ├── crm.mjs                      CRM visual (tableros, contactos, campañas, webhooks)
│   ├── groups-explorer.mjs          explorar grupos y agenda de solicitudes de ingreso
│   ├── instagram.mjs                publicación en Instagram vía Meta Business Suite
│   ├── public/                      interfaz web (SPA sin framework ni compilación)
│   ├── scripts/                     iniciar/detener en segundo plano (Windows)
│   ├── tests/                       pruebas automáticas (node --test)
│   ├── data/images/                 fotos de perfil, páginas, grupos y chats (copias locales)
│   ├── data/uploads/                archivos adjuntos subidos para publicar
│   ├── .env                         configuración REAL usada en producción (contiene secretos)
│   ├── .env.example                 plantilla de configuración documentada
│   └── package.json / package-lock.json
├── base-de-datos/
│   ├── autofacebook-completo.sql    volcado SQL completo (estructura + datos), texto plano UTF-8
│   ├── autofacebook.dump            mismo volcado en formato binario de pg_restore
│   ├── autofacebook-solo-estructura.sql  solo tablas, índices y la vista
│   ├── restaurar.ps1 / restaurar.sh      scripts para restaurar en Windows / Linux
│   └── LEEME-BASE-DE-DATOS.md
└── documentacion/
    ├── 01-INSTALACION-Y-DESPLIEGUE.md
    ├── 02-ARQUITECTURA.md
    ├── 03-FUNCIONES-DEL-PANEL.md
    ├── 04-API-REFERENCIA.md
    ├── 05-BASE-DE-DATOS.md
    ├── 06-GUIA-DE-INTEGRACION.md     ← cómo adaptarlo al otro sistema (WhatsApp QR, etc.)
    ├── 07-AUTOMATIZACION-FACEBOOK.md
    └── 08-ESTADO-Y-PENDIENTES.md
```

**Orden de lectura recomendado para un agente nuevo:** este archivo → 02 (arquitectura)
→ 06 (integración) → 04 (API) → 05 (base de datos) → 07 (Facebook) → 08 (pendientes).

## 2. Qué NO incluye (a propósito) y por qué

| Excluido | Motivo | Qué hacer |
| --- | --- | --- |
| `node_modules/` | Se reinstala con `npm install` (depende del sistema operativo). | `npm install` |
| `data/browser-profile/` | Es la **sesión iniciada de Facebook** (cookies). Chrome la cifra con la cuenta de Windows (DPAPI): copiada a otro equipo no funciona y sería una credencial expuesta. | En el servidor nuevo: **Conectar Facebook → Mostrar navegador** e iniciar sesión una vez. |
| `data/logs/` | Registros locales sin valor para la migración. | Se crean solos. |
| Capturas `data/debug-*.png` | Diagnóstico temporal. | — |
| `data/niro.json` | Copia JSON **vieja** (23/09, anterior a PostgreSQL: 0 páginas, 80 avisos). Si estuviera, un arranque con base vacía o `npm run db:import` cargaría datos desactualizados y podría **pisar la base buena**. | La base de datos del paquete es la fuente correcta. El panel crea este archivo solo si PostgreSQL falla (copia de emergencia). |

## 3. Arranque rápido (resumen)

```bash
# 1) Base de datos (PostgreSQL 14+)
createdb -U postgres -E UTF8 -T template0 autofacebook
psql -U postgres -d autofacebook -f base-de-datos/autofacebook-completo.sql

# 2) Aplicación
cd sistema
npm install
npx playwright install chromium        # si el servidor no tiene Chrome/Edge
# revisar .env (NIRO_DATABASE_URL, NIRO_HOST, NIRO_PANEL_PASSWORD, NIRO_ALLOWED_HOSTS...)
npm start                              # http://127.0.0.1:8787
```

Detalle completo (Windows, Linux, servicio, proxy HTTPS): `documentacion/01-INSTALACION-Y-DESPLIEGUE.md`.

## 4. Datos incluidos (al 24/09/2026)

| Contenido | Cantidad |
| --- | --- |
| Perfil de Facebook (Dickel Claudio) | 1 |
| Páginas administradas | 19 |
| Grupos donde es miembro | 503 |
| Publicaciones descargadas | 284 |
| Chats de Messenger / mensajes | 27 / 191 |
| Notificaciones (eventos) / borradores | 209 / 209 |
| Programaciones / trabajos de publicación | 7 / 37 |
| Historial de publicaciones hechas con Niro | 47 |
| Cuentas sociales (Instagram) revisadas | 19 |
| Interacciones de IA / auditoría / instrucciones | 22 / 98 / 1 |
| Segmentos / grupos descubiertos / tareas de ingreso | 2 / 285 / 169 |
| CRM: tableros / columnas / contactos / oportunidades | 1 / 6 / 8 / 8 |
| Archivos adjuntos (`media`) | 16 |

La restauración se verificó: se cargó el volcado en una base nueva y el conteo de
las 32 tablas y la vista coincidió exactamente con el original.

## 5. Avisos importantes

1. **`sistema/.env` contiene secretos reales** (clave de la API de Niro IA y la
   contraseña de PostgreSQL). Tratá el ZIP como confidencial. La clave `NIRO_AI_API_KEY`
   ya circuló por chat: **conviene rotarla** en https://niro.cnid.com.py y actualizar `.env`.
2. **No escribir directamente en las tablas mientras el panel está corriendo.** El
   servidor mantiene todo en memoria y sincroniza PostgreSQL por diferencias: una fila
   insertada desde afuera puede ser **borrada** en el siguiente guardado. Otro sistema
   tiene que usar la API HTTP (ver `06-GUIA-DE-INTEGRACION.md`, sección “Regla de oro”).
3. **Una cuenta de Facebook por instancia.** El sistema maneja una sola sesión de
   navegador. Para varios clientes/cuentas se levanta una instancia por cuenta
   (puerto, base y perfil propios).
4. **Agenda de ingreso a grupos activa:** hay ~166 solicitudes programadas
   (5 por día, del 24/09 al 27/10/2026). Al arrancar en el servidor nuevo con Facebook
   conectado, **se reanudan solas**. Si no querés que eso pase durante la migración,
   pausala en *Explorar grupos* o, antes del primer arranque, ejecutá:
   `UPDATE app_meta SET value = jsonb_set(value, '{groupsExplorer,paused}', 'true') WHERE key = 'meta';`
5. Hay **2 programaciones con “Publicar automáticamente” y 4 trabajos en cola**. Se
   ejecutan solas si `NIRO_SCHEDULER_AUTOSTART=true` (así está en el `.env` incluido).
   Para una migración tranquila poné `NIRO_SCHEDULER_AUTOSTART=false` hasta verificar todo.
