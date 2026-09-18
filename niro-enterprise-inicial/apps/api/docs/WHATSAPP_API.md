# NIRO WhatsApp API

Base URL: `https://TU_DOMINIO/api/v1`

Cada organización administra sus propias claves desde **API & Desarrolladores**. La clave completa se muestra una sola vez.

## Autenticación

Enviar uno de estos headers en cada endpoint protegido:

```http
Authorization: Bearer nr_live_TU_CLAVE
```

o:

```http
X-API-Key: nr_live_TU_CLAVE
```

Las claves están limitadas a su organización y no pueden usar la sesión de otra empresa.

## Enviar texto y emojis

`POST /messages` con `application/json`:

```bash
curl -X POST https://TU_DOMINIO/api/v1/messages \
  -H "Authorization: Bearer nr_live_TU_CLAVE" \
  -H "Content-Type: application/json" \
  -d '{"to":"595981234567","type":"text","text":"Hola 👋 Tu pedido está listo."}'
```

Campos: `to` es un teléfono internacional sin `+`; `type` es `text`; `text` admite hasta 8.000 caracteres; `createContact` es opcional y por defecto crea el contacto si todavía no existe.

## Enviar imagen, video, audio, documento o sticker

`POST /messages` con `multipart/form-data` y un campo `file`:

```bash
curl -X POST https://TU_DOMINIO/api/v1/messages \
  -H "Authorization: Bearer nr_live_TU_CLAVE" \
  -F "to=595981234567" \
  -F "type=image" \
  -F "caption=Imagen desde NIRO" \
  -F "file=@foto.jpg"
```

Tipos admitidos: `image`, `video`, `audio`, `document` y `sticker`. Los stickers deben ser `image/webp`. Para audios, `ptt=true` los envía como nota de voz. El máximo es 15 MB. La alternativa para integraciones JSON es `mediaBase64` junto con `mimeType` y `fileName`.

## Consultar sesiones

`GET /sessions` devuelve las líneas de WhatsApp de la organización y su estado (`disconnected`, `connecting`, `qr` o `connected`). La sesión se conecta desde **Integraciones** escaneando el QR de esa empresa.

## Respuesta y errores

Una respuesta exitosa contiene `id`, `conversationId`, `to`, `type`, `status`, `waMessageId` y el mensaje persistido en el Inbox. Errores frecuentes:

- `400`: payload inválido, teléfono incorrecto o archivo no permitido.
- `401`: API key ausente, inválida o revocada.
- `409`: WhatsApp todavía no está conectado para la organización.
- `429`: se superó el límite por clave.
- `502`: WhatsApp rechazó el envío.

## OpenAPI

El contrato actual está disponible en `GET /api/v1/openapi.json` y se puede abrir desde el portal de desarrolladores.
