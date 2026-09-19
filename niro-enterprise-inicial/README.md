# NIRO Enterprise — instalación

Base instalable de NIRO Enterprise con Docker, PostgreSQL, Prisma, Node.js/Express y un frontend React (Vite + TypeScript).

Incluye autenticación con sesiones (JWT en cookies httpOnly + rotación/revocación de refresh tokens), roles y permisos, aislamiento multiempresa, conversaciones en tiempo real, WhatsApp, CRM, pedidos, reportes y campañas de difusión con historial y auditoría.

También incluye un portal de desarrolladores por organización: API keys con hash, permisos, revocación, contrato OpenAPI y envío de mensajes de WhatsApp por API.

Y un asistente de IA (Niro IA — https://niro.cnid.com.py/docs) que responde en WhatsApp y en el widget, transcribe audios, lee facturas/imágenes por OCR y permite crear agentes propios con su propio prompt.

## Requisitos
- Docker Engine + Docker Compose plugin
- Puerto 3000 y 4000 disponibles

## Instalación
1. Descomprime el archivo en tu servidor.
2. Copia `.env.example` a `.env`.
3. Cambiá `JWT_SECRET`, `POSTGRES_PASSWORD` y `SEED_SUPERADMIN_PASSWORD` antes de exponer el servicio a Internet. Dejá `COOKIE_SECURE=false` solo para pruebas locales sin HTTPS; en producción debe ser `true` detrás de un proxy con HTTPS.
4. Ejecutá:

```bash
docker compose up -d --build
```

5. Comprobá:
   - API: `http://TU_SERVIDOR:4000/health`
   - Interfaz: `http://TU_SERVIDOR:3000` (también proxea `/api` hacia el backend, mismo origen)
6. Iniciá sesión con el usuario `SEED_SUPERADMIN_EMAIL`/`SEED_SUPERADMIN_PASSWORD` definido en `.env`. El sistema pide cambiar la contraseña en el primer login.
7. Como superadmin, creá tu primera organización desde "Organizaciones". Se genera una contraseña temporal para el propietario (no hay envío de email configurado todavía) — copiala y entregala de forma segura.

## Migraciones Prisma
El contenedor de la API corre `prisma migrate deploy` (migraciones versionadas en `apps/api/prisma/migrations/`) y luego `prisma/seed.js` al iniciar. Para agregar cambios de esquema en desarrollo, generá una nueva migración con Prisma y commiteala junto con el cambio de `schema.prisma`.

## Campañas de WhatsApp
Desde **Campañas** se puede crear una campaña directa o programada, elegir la sesión/línea disponible, combinar etiquetas del CRM con contactos puntuales, agregar emojis y un archivo multimedia/documento, seleccionar los perfiles de 10, 40, 60 o 100 mensajes por hora y consultar el historial por destinatario. El tablero calcula pendientes, enviados, entregados, vistos, fallidos y respuestas; los fallidos se pueden reintentar y una campaña terminada o cancelada se puede reenviar.

La sincronización de contactos del teléfono se habilita desde el botón **Sincronizar teléfono** cuando WhatsApp está conectado. Baileys debe recibir la libreta durante la sincronización de historial; para instalaciones con historiales muy grandes se puede desactivar con `WHATSAPP_SYNC_FULL_HISTORY=false` y dejar la importación para una sesión configurada específicamente para sincronizar.

Si el proceso se reinicia (deploy, crash) a mitad de un envío, la campaña que quedó en estado "enviando" se retoma sola al arrancar de nuevo: espera a que WhatsApp reconecte (hasta 30 segundos) y sigue con el próximo destinatario pendiente. Si WhatsApp no reconecta a tiempo (por ejemplo, necesita un QR nuevo), la campaña queda como estaba — pausarla y volver a iniciarla desde **Campañas** es el reintento manual.

### Campañas de llamadas de WhatsApp

El módulo de llamadas está disponible en **Llamadas WhatsApp** y agrega cuentas, biblioteca de audios MP3/WAV, campañas 1:1 directas o programadas, consentimiento/opt-out, control de ritmo, estados por destinatario, reintentos, pausa/reanudación, encuestas posteriores por WhatsApp, historial, CSV y reportes. La guía completa de instalación y operación está en `apps/api/docs/WHATSAPP_CALLS.md`.

Para pruebas locales sin realizar llamadas se puede usar `WHATSAPP_CALL_PROVIDER=mock`. La dependencia `baileys-caller` ya queda incluida para el proveedor real; las llamadas reales requieren Node.js 20+, `ffmpeg`, `WHATSAPP_CALL_PROVIDER=baileys-caller` y una cuenta autorizada de prueba. No se habilitan automáticamente.

## Notificaciones push
El equipo puede recibir notificaciones del navegador (Web Push, sin depender de que la pestaña esté abierta) cuando llega un mensaje nuevo o les transfieren una conversación. Se activan con la campanita 🔔 de la barra superior — cada persona decide si las quiere en cada dispositivo/navegador donde inicia sesión.

Reglas de aviso: si la conversación ya tiene un agente asignado, se le avisa solo a esa persona; si no tiene a nadie asignado, se avisa a quienes administran la organización (Propietario, Administrador, Supervisor) para que alguien la tome. A quien ya tiene la aplicación abierta (con un socket conectado) no se le manda push — ya lo está viendo en tiempo real.

Configuración (en `apps/api/.env`, o en el `.env` raíz si usás Docker Compose):

```
VAPID_PUBLIC_KEY=...
VAPID_PRIVATE_KEY=...
VAPID_SUBJECT=mailto:tu-correo@tuempresa.com
```

Generá tu propio par de claves una vez (son gratis, no dependen de ningún servicio externo) y guardalas:

```bash
cd apps/api
node -e "console.log(require('web-push').generateVAPIDKeys())"
```

Sin estas variables, la campanita queda oculta sola — no hace falta nada más para que el resto del sistema funcione igual.

## API de WhatsApp para integraciones
Desde **API & Desarrolladores** cada usuario de una organización puede crear una credencial, copiarla una sola vez, revocarla y probar envíos en tiempo real. Las claves se almacenan como SHA-256; la clave completa nunca vuelve a aparecer y cada solicitud queda asociada a su organización y a su auditoría.

Contrato y endpoints:

- `GET /api/v1/openapi.json`: documentación OpenAPI 3.0 descargable.
- `apps/api/docs/WHATSAPP_API.md`: guía portable con autenticación, ejemplos cURL, multimedia y errores.
- `POST /api/v1/messages`: texto con emojis por JSON; imagen, video, audio, documento y sticker WebP por `multipart/form-data` con el campo `file`. También acepta `mediaBase64` en integraciones que no usen multipart.
- `GET /api/v1/sessions`: estado de las líneas de WhatsApp de la organización.
- Autenticación: `Authorization: Bearer nr_live_...` o `X-API-Key: nr_live_...`.
- Archivos permitidos: formatos de imagen, video, audio, PDF, Office y texto, con máximo de 15 MB.

El envío se refleja en el Inbox como mensaje saliente y conserva `conversationId`, `waMessageId`, estado de entrega y adjunto. El API tiene un límite configurable de 120 solicitudes por minuto por clave (`API_RATE_LIMIT`).

### Multiusuario y aislamiento de WhatsApp

Cada organización usa una carpeta de credenciales Baileys distinta (`WHATSAPP_SESSION_ROOT/<organizationId>`). El propietario o administrador genera el QR desde **Integraciones**; los demás usuarios autorizados de la misma organización ven el estado y trabajan sobre esa misma sesión. Las claves API solo pueden enviar a través de la sesión de su propia organización y nunca pueden leer ni usar datos de otra empresa.

## Asistente de IA (Niro IA)
El sistema se conecta a la API de Niro IA (https://niro.cnid.com.py/docs) para todo lo que es inteligencia artificial. Se configura con dos variables de entorno en `apps/api/.env` (o en el `.env` raíz si usás Docker Compose):

```
NIRO_AI_BASE_URL=https://niro.cnid.com.py
NIRO_AI_API_KEY=niro_xxxxxxxxxxxxxxxxxxxxxxxx
```

Generá la key en `/api-keys` dentro de esa plataforma. **Sin `NIRO_AI_API_KEY` configurada, el asistente queda apagado en todo el sistema** — nada se rompe, simplemente no responde ni se pueden crear agentes.

Qué hace cada parte:

- **Bot de WhatsApp y del widget:** se activa desde **Configuración → Asistente de IA**. Manda la bienvenida, deriva por el menú de departamentos configurado (si hay uno) y, si nadie pidió una opción del menú, sigue respondiendo libremente con IA usando el historial de la conversación — hasta que un agente humano toma el chat o la conversación se marca como resuelta/cerrada. El mismo panel de Configuración tiene un botón para probar la respuesta con el prompt actual sin mandar nada a un cliente real.
- **Transcripción de audios:** cada nota de voz que llega por WhatsApp se transcribe automáticamente en segundo plano y el texto queda debajo del audio en el chat. También se puede pedir a mano desde cualquier audio ya guardado en una conversación (botón "Transcribir con IA").
- **Lectura de imágenes y facturas (OCR):** desde cualquier imagen de una conversación se puede pedir "Leer texto con IA" (transcribe todo el texto) o "Leer como factura" (devuelve emisor, RUC, timbrado, ítems, IVA 5 %/10 % y total en JSON, pensado para facturas de Paraguay).
- **Agentes IA:** módulo propio (`/ai-agents`) para crear agentes con su propio system prompt y probarlos en un chat de prueba. Crear agentes está limitado a OWNER/ADMIN/SUPERVISOR; cualquier rol puede listarlos y conversar con ellos.

Si Niro IA devuelve un error (sin saldo, proveedor caído, etc.) la conversación sigue funcionando con normalidad: el mensaje del cliente siempre se guarda, y solo la respuesta automática queda pendiente.

**Uso y costo:** cada llamada exitosa a Niro IA (bot, agentes, transcripción, OCR, documentos) queda registrada con su costo — visible en **Agentes IA → Uso de IA**, desglosado por tipo. El costo se muestra tal cual lo devuelve la API de Niro IA, sin sumarlo entre tipos, porque no hay garantía de que la unidad sea comparable entre categorías (algunas respuestas traen decimales chicos, otras enteros grandes). Para el detalle en tu moneda real, `/wallet` en la plataforma de Niro IA sigue siendo la fuente de verdad.

## Desarrollo local
Con PostgreSQL disponible y `apps/api/.env` configurado:

```bash
cd apps/api
npm install
npm run prisma:generate
npx prisma migrate deploy
npm run seed
npm run dev
```

En otra terminal:

```bash
cd apps/web
npm install
VITE_API_PROXY_TARGET=http://localhost:4000 npm run dev -- --host 127.0.0.1 --port 5173
```

Para una prueba aislada, usá otra base `DATABASE_URL`, un `WHATSAPP_SESSION_ROOT` exclusivo y `WHATSAPP_RESUME_SESSIONS=false`; así no se reutilizan sesiones de WhatsApp del entorno real.

Para probar la API localmente, levantá el servidor y usá la ruta `http://localhost:4000/api/v1/openapi.json` o el portal `http://localhost:5173/api`. Primero conectá una sesión real desde **Integraciones**; si no hay sesión, la API responde `409` sin intentar enviar.

## Estructura
- `apps/api`: API Node.js + Express + Prisma (autenticación, organizaciones, usuarios, departamentos)
- `apps/web`: frontend React + Vite + TypeScript (login y paneles de administración)
- `docker-compose.yml`: PostgreSQL, API y web
- `apps/api/prisma/schema.prisma`: modelo de datos multiempresa

## Pruebas del backend
Los tests de integración (`apps/api/tests/`) cubren login/sesión, permisos, aislamiento multiempresa, conversaciones, pedidos, adjuntos, campañas y API: audiencia por etiquetas/contactos, programación, archivos, sesiones, sincronización protegida, estados fallidos, trazabilidad de entregado/visto, claves Bearer, revocación, OpenAPI y todos los tipos multimedia. Corren contra una base Postgres real:

```bash
# Con el docker compose ya levantado (usa una base de test aparte):
createdb -h localhost -U niro niro_test   # o crearla manualmente en el motor Postgres

cd apps/api
TEST_DATABASE_URL="postgresql://niro:<password>@localhost:4432/niro_test?schema=public" \
DATABASE_URL="postgresql://niro:<password>@localhost:4432/niro_test?schema=public" \
npx prisma migrate deploy

TEST_DATABASE_URL="postgresql://niro:<password>@localhost:4432/niro_test?schema=public" npm test
```

(Ajustá host/puerto/credenciales según tu `.env`. No se deben apuntar estos tests a la base de producción.)

## Antes de publicar en producción
Checklist concreto — ningún paso es opcional para exponer el servicio a Internet con datos reales:

1. **Secretos propios.** Cambiá `JWT_SECRET`, `POSTGRES_PASSWORD` y `SEED_SUPERADMIN_PASSWORD` en tu `.env` — no uses los valores de ejemplo del repo. `JWT_SECRET` fuerte: `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`.
2. **HTTPS + `COOKIE_SECURE=true`.** Las cookies de sesión no viajan por HTTP en producción. La forma más simple con este repo: `docker compose -f docker-compose.yml -f docker-compose.https.yml up -d --build` (agrega un proxy Caddy que saca y renueva el certificado solo — ver ese archivo). Si ya tenés tu propio proxy/dominio, sirve igual, solo asegurate de que termine en HTTPS y de setear `COOKIE_SECURE=true`.
3. **Backups automáticos.** `scripts/backup-db.sh` respalda la base de datos, los adjuntos subidos y las sesiones de WhatsApp en un solo paso. Programalo con cron (el propio script trae el ejemplo en su cabecera) y probá al menos una vez que un respaldo se pueda restaurar.
4. **API de Niro IA y notificaciones push son opcionales** pero recomendadas: sin `NIRO_AI_API_KEY` el asistente queda apagado, sin `VAPID_PUBLIC_KEY`/`VAPID_PRIVATE_KEY` las notificaciones push quedan ocultas. Ninguna de las dos rompe el resto del sistema si falta.
5. **Revisión de dependencias.** `npm audit` en `apps/api` señala una vulnerabilidad conocida en una dependencia de desarrollo de Prisma (no del cliente en tiempo de ejecución) — no bloquea el uso, pero conviene revisar `npm audit fix` antes de publicar y de ahí en más de forma periódica.
6. **Acceso a la base de datos.** El puerto de Postgres no debería quedar expuesto a Internet — en el `docker-compose.yml` base no se publica ningún puerto para `db`, mantenelo así salvo que necesites conectarte de afuera, y en ese caso restringilo por IP/VPN.

## Próximos módulos a desarrollar
1. Múltiples líneas de WhatsApp simultáneas por organización y selección de `lineId` en la API (hoy cada organización usa una sola sesión; el campo "línea de envío" de las campañas todavía no elige entre varias).
2. Cola durable para envíos API/campañas y webhooks externos, pensada para correr varios servidores de API a la vez (hoy es un solo timer en memoria por servidor — funciona bien para un despliegue de un servidor, y las campañas que quedan a mitad de un envío se reanudan solas al reiniciar, ver "Campañas de WhatsApp").
3. Envío de la contraseña temporal por email a los usuarios nuevos (hoy se muestra una vez en pantalla para copiar y entregar a mano).
