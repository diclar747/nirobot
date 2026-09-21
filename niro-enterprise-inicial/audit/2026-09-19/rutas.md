# Inventario de rutas de API

126 declaraciones de rutas. Los prefijos se definen en apps/api/src/app.js.
Inventario estático; no equivale a cobertura funcional. Cada ruta requiere pruebas de rol, organización, entrada válida/inválida y efectos.

## ai.routes.js

| Método | Ruta relativa | Línea |
|---|---|---|
| GET | `/usage/summary` | 25 |
| GET | `/status` | 37 |
| POST | `/chat/test` | 53 |
| GET | `/agents` | 72 |
| POST | `/agents` | 81 |
| POST | `/agents/:id/chat` | 99 |
| POST | `/vision/extract` | 112 |
| POST | `/documents/analyze` | 126 |
| POST | `/audio/transcriptions` | 139 |

## api.routes.js

| Método | Ruta relativa | Línea |
|---|---|---|
| GET | `/` | 22 |
| GET | `/openapi.json` | 26 |
| GET | `/sessions` | 32 |
| POST | `/messages` | 36 |

## auth.routes.js

| Método | Ruta relativa | Línea |
|---|---|---|
| POST | `/whatsapp/start` | 263 |
| GET | `/whatsapp/status/:flowId` | 281 |
| POST | `/whatsapp/complete` | 299 |
| POST | `/login` | 451 |
| POST | `/refresh` | 490 |
| POST | `/logout` | 554 |
| GET | `/me` | 575 |
| POST | `/change-password` | 588 |

## bot-flow.routes.js

| Método | Ruta relativa | Línea |
|---|---|---|
| GET | `/` | 30 |
| PATCH | `/` | 40 |
| POST | `/test` | 58 |

## call.routes.js

| Método | Ruta relativa | Línea |
|---|---|---|
| GET | `/provider` | 55 |
| GET | `/accounts` | 57 |
| POST | `/accounts/connect` | 63 |
| POST | `/accounts/:id/disconnect` | 75 |
| POST | `/direct` | 87 |
| GET | `/direct/:id` | 122 |
| POST | `/direct/:id/hangup` | 130 |
| GET | `/audios` | 139 |
| GET | `/audios/ai/status` | 146 |
| POST | `/audios` | 150 |
| POST | `/audios/ai/generate` | 172 |
| PATCH | `/audios/:id` | 201 |
| DELETE | `/audios/:id` | 210 |
| GET | `/audios/:id/file` | 221 |
| GET | `/dashboard` | 231 |
| GET | `/campaigns` | 259 |
| POST | `/campaigns` | 266 |
| GET | `/campaigns/:id` | 319 |
| POST | `/campaigns/:id/start` | 331 |
| POST | `/campaigns/:id/pause` | 339 |
| POST | `/campaigns/:id/resume` | 354 |
| POST | `/campaigns/:id/cancel` | 362 |
| GET | `/campaigns/:id/attempts` | 370 |
| GET | `/history` | 381 |
| GET | `/reports` | 408 |
| GET | `/surveys/:id/responses` | 419 |

## campaigns.routes.js

| Método | Ruta relativa | Línea |
|---|---|---|
| GET | `/` | 23 |
| POST | `/` | 40 |
| POST | `/:id/attachment` | 104 |
| GET | `/:id` | 138 |
| POST | `/:id/start` | 171 |
| POST | `/:id/pause` | 197 |
| POST | `/:id/cancel` | 217 |
| POST | `/:id/retry-failed` | 237 |
| POST | `/:id/resend` | 252 |

## contacts.routes.js

| Método | Ruta relativa | Línea |
|---|---|---|
| GET | `/` | 17 |
| POST | `/` | 41 |
| GET | `/:id` | 58 |
| PATCH | `/:id` | 74 |

## conversations.routes.js

| Método | Ruta relativa | Línea |
|---|---|---|
| GET | `/` | 58 |
| POST | `/` | 99 |
| GET | `/:id` | 169 |
| GET | `/:id/messages` | 187 |
| PATCH | `/:id` | 206 |
| POST | `/:id/claim` | 257 |
| POST | `/:id/transfer` | 292 |
| POST | `/:id/transfer-response` | 380 |
| POST | `/:id/messages` | 450 |
| POST | `/:id/attachments` | 573 |
| GET | `/:id/attachments/:attachmentId` | 641 |
| POST | `/:id/messages/:messageId/ai-read` | 660 |
| POST | `/:id/messages/:messageId/react` | 701 |
| DELETE | `/:id/messages/:messageId` | 735 |
| POST | `/:id/messages/poll` | 759 |
| POST | `/:id/messages/contact` | 804 |

## developer.routes.js

| Método | Ruta relativa | Línea |
|---|---|---|
| GET | `/api-keys` | 23 |
| POST | `/api-keys` | 36 |
| DELETE | `/api-keys/:id` | 65 |

## orders.routes.js

| Método | Ruta relativa | Línea |
|---|---|---|
| GET | `/` | 39 |
| POST | `/` | 69 |
| GET | `/:id` | 114 |
| PATCH | `/:id` | 127 |

## org.routes.js

| Método | Ruta relativa | Línea |
|---|---|---|
| GET | `/` | 59 |
| PATCH | `/` | 78 |
| PATCH | `/settings` | 96 |
| GET | `/users` | 128 |
| POST | `/users` | 155 |
| PATCH | `/users/:id` | 203 |
| POST | `/users/:id/reset-password` | 238 |
| GET | `/departments` | 269 |
| POST | `/departments` | 289 |
| PATCH | `/departments/:id` | 313 |
| DELETE | `/departments/:id` | 340 |
| POST | `/departments/:id/members` | 359 |
| DELETE | `/departments/:id/members/:userId` | 390 |
| GET | `/presence` | 416 |
| POST | `/presence/status` | 425 |
| GET | `/dashboard-stats` | 438 |

## public.routes.js

| Método | Ruta relativa | Línea |
|---|---|---|
| GET | `/` | 6 |
| GET | `/health` | 16 |
| GET | `/api` | 25 |
| GET | `/api/public/org/:slug` | 33 |

## push.routes.js

| Método | Ruta relativa | Línea |
|---|---|---|
| GET | `/vapid-public-key` | 13 |
| POST | `/subscribe` | 17 |
| DELETE | `/subscribe` | 28 |

## reports.routes.js

| Método | Ruta relativa | Línea |
|---|---|---|
| GET | `/summary` | 15 |
| GET | `/audit` | 115 |

## superadmin.routes.js

| Método | Ruta relativa | Línea |
|---|---|---|
| GET | `/organizations` | 27 |
| POST | `/organizations` | 48 |
| GET | `/organizations/:id` | 105 |
| PATCH | `/organizations/:id` | 118 |

## whatsapp.routes.js

| Método | Ruta relativa | Línea |
|---|---|---|
| GET | `/status` | 15 |
| GET | `/sessions` | 19 |
| POST | `/sync-contacts` | 23 |
| POST | `/connect` | 32 |
| POST | `/disconnect` | 41 |

## widget.routes.js

| Método | Ruta relativa | Línea |
|---|---|---|
| GET | `/:slug/info` | 45 |
| POST | `/:slug/start` | 57 |
| GET | `/:slug/conversation` | 110 |
| POST | `/:slug/messages` | 128 |
| POST | `/:slug/attachments` | 197 |
| GET | `/:slug/attachments/:attachmentId` | 248 |
