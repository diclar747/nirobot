# Campañas de llamadas de WhatsApp

Este módulo permite administrar cuentas de WhatsApp, audios, campañas de llamadas 1:1, consentimiento, reintentos, encuestas posteriores y reportes por organización.

## Qué incluye

- Panel `/llamadas` con resumen, campañas, historial, audios y cuentas.
- Campañas directas o programadas, con contactos puntuales o etiquetas del CRM.
- Control de consentimiento y exclusión (`opt-out`) antes de encolar destinatarios.
- Audios MP3/WAV, pausa entre llamadas, concurrencia, límite de intentos y ventana horaria.
- Generación de audios con IA desde la biblioteca, siempre que se configure un proveedor TTS real.
- Estados por destinatario: pendiente, en cola, timbrando, conectado, reproduciendo, completado, sin respuesta, fallido, cancelado y reintento pendiente.
- Pausar, reanudar y cancelar; recuperación de campañas en ejecución después de reiniciar el servidor.
- Historial consultable, CSV, auditoría y encuestas por WhatsApp después de la llamada.
- Llamada individual desde el encabezado de cualquier conversación de WhatsApp, con confirmación, estado en vivo y corte manual.

## Probar localmente sin realizar llamadas

Para probar el ciclo completo de creación, cola, ejecución, pausa, reintento y reportes sin llamar a nadie:

```bash
WHATSAPP_CALL_PROVIDER=mock
```

El proveedor simulado genera los eventos `ringing`, `connected`, `audio-started` y `ended`. No envía tráfico a WhatsApp y no reemplaza una prueba real de audio.

## Habilitar el proveedor real

El proyecto deja el proveedor real desactivado por defecto para que las pruebas locales no llamen a nadie. La dependencia `baileys-caller` queda fijada en `apps/api/package.json` desde su repositorio GitHub y Docker instala `ffmpeg` dentro de la imagen.

Requisitos mínimos:

1. Node.js 20 o superior.
2. `ffmpeg` en el `PATH` del proceso de API.
3. Instalar el proveedor opcional desde su repositorio:

```bash
cd apps/api
npm install github:SheIITear/baileys-caller
```

4. Configurar:

```env
WHATSAPP_CALL_PROVIDER=baileys-caller
```

En Windows local, si `ffmpeg` no está en el PATH global, usar la ruta del ejecutable descargado localmente:

```env
FFMPEG_PATH=D:\\ruta\\al\\proyecto\\.local\\ffmpeg\\bin\\ffmpeg.exe
```

El endpoint `GET /api/org/wa-calls/provider` comprueba ambas dependencias y devuelve `available: false` si falta el paquete o `ffmpeg`; así la interfaz no permite presentar una configuración incompleta como lista para llamar.

El proveedor soporta llamadas salientes 1:1 y reproducción de MP3/WAV. No se deben prometer llamadas grupales, video, llamadas entrantes ni DTMF hasta validarlas en un teléfono de prueba. La pregunta “presione 1/2” se implementa como encuesta posterior por WhatsApp, porque el proveedor no garantiza recepción de tonos DTMF.

Antes de producción, probar una cuenta autorizada y un único contacto con consentimiento explícito. La carpeta de sesión debe persistir entre reinicios y no debe compartirse entre organizaciones. El proveedor abre su propio socket Baileys sobre la misma carpeta de credenciales de la cuenta; por eso hay que validar el primer enlace y una llamada real con una línea de prueba antes de activar campañas, y cerrar la cuenta desde el panel antes de cambiar de sesión.

La identidad del dispositivo vinculado se configura como `Niro Bot` en `apps/api/src/lib/whatsapp.js`. WhatsApp puede conservar el nombre anterior de una vinculación ya existente; para verlo actualizado, desvinculá ese dispositivo desde WhatsApp y escaneá un QR nuevo desde Niro.

## API del módulo

Todas las rutas requieren sesión autenticada, organización activa y protección CSRF cuando corresponde:

- `GET /api/org/wa-calls/provider`
- `GET /api/org/wa-calls/accounts`
- `POST /api/org/wa-calls/accounts/connect`
- `POST /api/org/wa-calls/accounts/:id/disconnect`
- `POST /api/org/wa-calls/direct` — inicia una llamada 1:1 para `{ "conversationId": "..." }`.
- `GET /api/org/wa-calls/direct/:id` — consulta el estado de la llamada individual.
- `POST /api/org/wa-calls/direct/:id/hangup` — finaliza la llamada individual.
- `GET|POST /api/org/wa-calls/audios`
- `GET /api/org/wa-calls/audios/ai/status`
- `POST /api/org/wa-calls/audios/ai/generate` — genera un MP3 con `{ "name", "text", "voice", "language", "speed" }`.
- `PATCH|DELETE /api/org/wa-calls/audios/:id`
- `GET /api/org/wa-calls/audios/:id/file`
- `GET /api/org/wa-calls/dashboard`
- `GET|POST /api/org/wa-calls/campaigns`
- `GET /api/org/wa-calls/campaigns/:id`
- `POST /api/org/wa-calls/campaigns/:id/start`
- `POST /api/org/wa-calls/campaigns/:id/pause`
- `POST /api/org/wa-calls/campaigns/:id/resume`
- `POST /api/org/wa-calls/campaigns/:id/cancel`
- `GET /api/org/wa-calls/campaigns/:id/attempts`
- `GET /api/org/wa-calls/history`
- `GET /api/org/wa-calls/reports`
- `GET /api/org/wa-calls/surveys/:id/responses`

## Persistencia y reinicios

Las credenciales de WhatsApp se guardan por organización en `WHATSAPP_SESSION_ROOT/<organizationId>`. Al iniciar la API se reanudan las carpetas que contienen `creds.json`; mientras el socket vuelve a abrirse, el estado público es `connecting`, no `disconnected`. Si WhatsApp revoca la sesión desde el teléfono, Baileys detecta `loggedOut`, elimina esa carpeta y recién entonces la sesión pasa a desconectada y requiere un QR nuevo.

La ejecución de campañas se guarda en PostgreSQL. Al reiniciar, las campañas `SCHEDULED` y `RUNNING` se reanudan; los destinatarios que estaban en curso vuelven a `PENDING` para evitar perderlos.

## Seguridad y límites

- Todos los registros incluyen `organizationId` y las consultas están aisladas por organización.
- No se encolan contactos sin teléfono válido, sin consentimiento o con exclusión activa.
- Se recomienda respetar la normativa aplicable y enviar solo a personas que solicitaron o aceptaron comunicaciones.
- El proveedor real debe probarse con volumen bajo antes de subir la velocidad; las opciones “conservador”, “equilibrado”, “mejor rendimiento” y “alto rendimiento” son límites operativos, no una garantía de entrega ni de que WhatsApp no aplique restricciones.
