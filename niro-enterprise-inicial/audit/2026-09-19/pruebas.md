# Resultados de pruebas aisladas

Total: 121; aprobadas: 120; fallidas: 1.

Las dependencias externas de WhatsApp e IA están simuladas. Esto no demuestra entrega ni audio reales.

## campaigns.test.js

- passed: Campañas de WhatsApp crea una campaña con audiencia mixta y perfil de velocidad
- passed: Campañas de WhatsApp programa una campaña y conserva sus destinatarios en el historial
- passed: Campañas de WhatsApp rechaza campañas sin audiencia válida
- passed: Campañas de WhatsApp el endpoint de sesiones es seguro y la sincronización exige una sesión conectada
- passed: Campañas de WhatsApp acepta un archivo multimedia/documento antes de iniciar
- passed: Campañas de WhatsApp marca fallidos cuando se inicia sin WhatsApp conectado
- failed: Campañas de WhatsApp registra el envío en la conversación y actualiza entregado/visto
- passed: Campañas de WhatsApp personaliza el mensaje por destinatario y conserva el texto renderizado en el historial
- passed: Campañas de WhatsApp genera una API key de una sola lectura, envía por Bearer y revoca el acceso
- passed: Campañas de WhatsApp envía todos los tipos multimedia de la API con multipart
- passed: Campañas de WhatsApp publica el contrato OpenAPI sin exponer credenciales

## push.test.js

- passed: Notificaciones push — rutas GET /vapid-public-key devuelve null sin claves configuradas
- passed: Notificaciones push — rutas GET /vapid-public-key devuelve la clave pública cuando está configurada
- passed: Notificaciones push — rutas POST /subscribe guarda la suscripción del usuario
- passed: Notificaciones push — rutas POST /subscribe responde 503 si las notificaciones no están configuradas
- passed: Notificaciones push — rutas POST /subscribe rechaza una suscripción sin las claves p256dh/auth
- passed: Notificaciones push — rutas DELETE /subscribe borra la suscripción del usuario
- passed: Notificaciones push — rutas DELETE /subscribe no borra la suscripción de otro usuario
- passed: Notificaciones push — rutas todas las rutas exigen sesión iniciada
- passed: Notificaciones push — lógica de envío (src/lib/push.js) sendToUser manda una notificación por cada suscripción del usuario
- passed: Notificaciones push — lógica de envío (src/lib/push.js) sendToUser no manda nada sin claves VAPID configuradas
- passed: Notificaciones push — lógica de envío (src/lib/push.js) una suscripción vencida (410) se borra sola sin romper el envío a las demás
- passed: Notificaciones push — lógica de envío (src/lib/push.js) notifyNewInboundMessage avisa al agente asignado y no a los managers
- passed: Notificaciones push — lógica de envío (src/lib/push.js) notifyNewInboundMessage avisa a los managers cuando la conversación no está asignada

## conversations.test.js

- passed: Conversaciones crea una conversación con contacto nuevo y aparece en la lista
- passed: Conversaciones un AGENT solo ve lo asignado a él o sin asignar en su departamento
- passed: Conversaciones un AGENT no puede asignar una conversación a otro agente
- passed: Conversaciones claim es atómico: de dos requests concurrentes solo una gana (prueba de concurrencia)
- passed: Conversaciones mensajes: outbound, inbound y nota interna
- passed: Conversaciones agregar y quitar etiquetas
- passed: Aislamiento multiempresa en conversaciones una organización no ve ni puede tocar conversaciones ni contactos de otra

## ai.test.js

- passed: Agentes IA — /api/org/ai GET /status refleja si hay API key configurada y si la IA está habilitada
- passed: Agentes IA — /api/org/ai GET /status devuelve aiEnabled true cuando la organización lo activó
- passed: Agentes IA — /api/org/ai POST /chat/test usa el prompt de la organización y devuelve la respuesta
- passed: Agentes IA — /api/org/ai POST /chat/test rechaza a un AGENT (requiere OWNER/ADMIN/SUPERVISOR)
- passed: Agentes IA — /api/org/ai POST /chat/test propaga un error de saldo (402) de Niro IA
- passed: Agentes IA — /api/org/ai GET /agents lista los agentes propios de la organización
- passed: Agentes IA — /api/org/ai POST /agents crea un agente y lo audita, solo para roles de gestión
- passed: Agentes IA — /api/org/ai POST /agents rechaza a un AGENT
- passed: Agentes IA — /api/org/ai POST /agents/:id/chat conversa con un agente propio
- passed: Agentes IA — /api/org/ai POST /vision/extract exige un archivo
- passed: Agentes IA — /api/org/ai POST /vision/extract devuelve el texto/JSON de la factura
- passed: Agentes IA — /api/org/ai POST /documents/analyze responde la pregunta sobre el PDF
- passed: Agentes IA — /api/org/ai POST /audio/transcriptions devuelve el texto transcrito
- passed: Agentes IA — /api/org/ai todas las rutas exigen sesión iniciada

## ai-bot.test.js

- passed: Bot de IA (chat libre) en conversaciones internas responde con IA cuando no hay menú, IA habilitada y nadie tomó el chat
- passed: Bot de IA (chat libre) en conversaciones internas no responde si la conversación ya tiene un agente humano asignado
- passed: Bot de IA (chat libre) en conversaciones internas no responde si la conversación está resuelta
- passed: Bot de IA (chat libre) en conversaciones internas no responde si NIRO_AI_API_KEY no está configurada, aunque aiEnabled esté prendido
- passed: Bot de IA (chat libre) en conversaciones internas una clave de menú sigue derivando a un departamento sin llamar a la IA
- passed: Bot de IA (chat libre) en conversaciones internas si Niro IA falla (402 sin crédito) la conversación sigue funcionando sin romperse
- passed: Bot de IA en el widget público responde con IA en el chat del sitio web cuando no hay menú que matchee

## widget.test.js

- passed: Widget público info devuelve nombre y mensaje de bienvenida de una org activa
- passed: Widget público start crea una conversación nueva y devuelve un token
- passed: Widget público el token permite retomar la conversación y mandar mensajes
- passed: Widget público un token inventado o de otra organización nunca funciona
- passed: Widget público las notas internas de los agentes nunca aparecen en el widget
- passed: Widget público una conversación cerrada no acepta más mensajes del visitante
- passed: Widget público con el bot de menú activado, el widget arranca con la bienvenida y deriva por clave

## attachments.test.js

- passed: Adjuntos (interno) sube una imagen a una conversación y queda disponible para descargar
- passed: Adjuntos (interno) rechaza tipos de archivo no permitidos
- passed: Adjuntos (interno) aislamiento: un adjunto de otra organización no se puede descargar
- passed: Adjuntos (widget) un visitante puede subir una imagen y el agente la ve; una nota con adjunto no es descargable desde el widget

## auth.test.js

- passed: POST /api/auth/login rechaza credenciales inválidas
- passed: POST /api/auth/login rechaza usuarios inactivos
- passed: POST /api/auth/login rechaza usuarios de una organización suspendida
- passed: POST /api/auth/login login correcto entrega cookies de sesión y csrf
- passed: GET /api/auth/me sin cookie devuelve 401
- passed: GET /api/auth/me con sesión válida devuelve el usuario actual
- passed: POST /api/auth/refresh rota el refresh token y el anterior no puede reutilizarse
- passed: POST /api/auth/logout revoca la sesión: el refresh token ya no sirve tras logout

## realtime.test.js

- passed: un mensaje creado en la organización A solo notifica al socket de la organización A, nunca al de B
- passed: un socket sin cookie de sesión válida no puede conectarse
- passed: el socket del widget solo recibe eventos de su propia conversación, nunca de otra
- passed: un socket con un widgetToken inventado no puede conectarse

## rbac.test.js

- passed: Permisos por rol dentro de una organización un AGENT no puede listar usuarios ni crear departamentos
- passed: Permisos por rol dentro de una organización un ADMIN no puede editar el perfil de la organización (solo OWNER)
- passed: Permisos por rol dentro de una organización un ADMIN no puede crear ni modificar propietarios
- passed: Permisos por rol dentro de una organización no se puede desactivar al último propietario activo ni a uno mismo
- passed: Permisos por rol dentro de una organización respeta el límite de usuarios del plan (maxUsers)
- passed: Permisos por rol dentro de una organización las mutaciones sin token CSRF son rechazadas
- passed: Alcance de superadmin SUPERADMIN no puede usar los endpoints de organización (no tiene organizationId)
- passed: Alcance de superadmin un OWNER de organización no puede usar los endpoints de superadmin

## bot.test.js

- passed: Bot de bienvenida y menú al crear una conversación sin departamento, el bot manda la bienvenida con el menú
- passed: Bot de bienvenida y menú no manda bienvenida si la conversación ya se crea con departamento
- passed: Bot de bienvenida y menú una respuesta entrante que matchea una clave del menú deriva al departamento y confirma
- passed: Bot de bienvenida y menú una respuesta entrante que no matchea ninguna clave no deriva ni rompe nada
- passed: Bot de bienvenida y menú el bot no actúa si aiEnabled está apagado

## ai-read.test.js

- passed: Lectura con IA de adjuntos ya guardados transcribe un audio existente y lo guarda en el mensaje
- passed: Lectura con IA de adjuntos ya guardados lee una imagen en modo factura y devuelve el JSON estructurado
- passed: Lectura con IA de adjuntos ya guardados rechaza un mensaje sin adjunto
- passed: Lectura con IA de adjuntos ya guardados responde 503 si Niro IA no está configurada

## isolation.test.js

- passed: Aislamiento multiempresa la lista de usuarios de una organización nunca incluye usuarios de otra
- passed: Aislamiento multiempresa no se puede leer un usuario de otra organización manipulando el id en la URL (404, no 403)
- passed: Aislamiento multiempresa no se puede modificar ni borrar un departamento de otra organización manipulando el id
- passed: Aislamiento multiempresa no se puede agregar como miembro a un usuario de otra organización
- passed: Aislamiento multiempresa un organizationId inyectado en el body es ignorado: el usuario creado queda en la organización del token
- passed: Aislamiento multiempresa el perfil y los ajustes de una organización solo devuelven los datos propios

## campaign-resume.test.js

- passed: Reanudar campañas que quedaron "enviando" tras un reinicio si WhatsApp ya está conectado, retoma el envío del destinatario pendiente
- passed: Reanudar campañas que quedaron "enviando" tras un reinicio si WhatsApp no reconecta a tiempo, no manda nada y deja al destinatario pendiente (sin marcarlo fallido)
- passed: Reanudar campañas que quedaron "enviando" tras un reinicio una campaña que no estaba en SENDING no se toca

## orders.test.js

- passed: Pedidos crea un pedido con contacto nuevo y artículos, calcula el total
- passed: Pedidos cambia estado y responsable
- passed: Pedidos reemplaza los artículos y recalcula el total
- passed: Aislamiento multiempresa en pedidos una organización no ve ni puede tocar pedidos de otra

## reports.test.js

- passed: Reportes resume conversaciones, pedidos y tasa de resolución
- passed: Reportes un AGENT no puede ver los reportes
- passed: Reportes un SUPERVISOR puede ver el resumen pero no el log de auditoría
- passed: Reportes el log de auditoría registra acciones administrativas con el nombre del actor
- passed: Reportes aislamiento: el resumen de una organización no incluye datos de otra

## ai-usage.test.js

- passed: Registro y resumen de uso de IA cada llamada exitosa queda registrada con su tipo y costo
- passed: Registro y resumen de uso de IA una llamada sin costo (null) igual queda registrada, sin costo
- passed: Registro y resumen de uso de IA GET /usage/summary agrupa por tipo y respeta la ventana de días
- passed: Registro y resumen de uso de IA el resumen de una organización nunca incluye el uso de otra

## whatsapp-identifiers.test.js

- passed: identificadores de WhatsApp no trata un LID como teléfono
- passed: identificadores de WhatsApp resuelve un LID al número real usando el mapeo de Baileys
- passed: identificadores de WhatsApp no inventa un teléfono cuando Baileys todavía no tiene el mapeo

## call-provider.test.js

- passed: proveedor de llamadas el simulador recorre ringing, connected y ended
- passed: proveedor de llamadas sin proveedor no permite declarar una llamada real

## call-validation.test.js

- passed: validación de campañas de llamadas obliga a usar audiencia y consentimiento mediante el flujo de creación
- passed: validación de campañas de llamadas valida la encuesta y normaliza los límites configurables
