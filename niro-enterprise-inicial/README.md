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

Si Niro IA devuelve un error (sin saldo, proveedor caído, etc.) la conversación sigue funcionando con normalidad: el mensaje del cliente siempre se guarda, y solo la respuesta automática queda pendiente. El costo de cada llamada (créditos de la wallet de la organización en Niro IA) no se muestra en la interfaz todavía; se puede consultar desde `/wallet` en la plataforma de Niro IA.

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

## Próximos módulos a desarrollar
1. Notificaciones push reales (el bot ya invita a escribir "NOTIFICACIONES", pero todavía no hay backend detrás).
2. Soporte de múltiples líneas de WhatsApp simultáneas por organización y selección de `lineId` en la API.
3. Cola durable para envíos API/campañas, webhooks externos y reportes históricos avanzados.
4. Mostrar en la interfaz el costo en créditos de cada respuesta de IA (hoy solo se ve desde `/wallet` en Niro IA).

No publiques el servicio sin configurar secretos, HTTPS, límites de acceso, backups y revisión de seguridad.
