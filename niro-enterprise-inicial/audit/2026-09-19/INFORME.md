# Auditoría Nirobot — 19 de septiembre de 2026

## Resultado

No se puede certificar el sistema completo ni las llamadas reales. Se verificaron infraestructura, acceso público, protecciones sin sesión y la suite existente en un entorno aislado. Se reprodujeron dos defectos del ciclo de cierre del proveedor instalado. Las llamadas individuales del chat no implementan conversación de voz con el navegador.

No se modificó código funcional ni se desplegaron cambios. No se realizaron llamadas, envíos de mensajes ni cambios de datos de negocio de producción. Abrir la pantalla de acceso generó un flujo QR temporal propio de esa pantalla; no se escaneó. La base temporal de pruebas quedó detenida.

## Evidencia de despliegue

- Sitio: https://nirobot.cnid.com.py/.
- Proyecto efectivo: `/root/nirobot/niro-enterprise-inicial`.
- Contenedores: `nirobot-api-1`, `nirobot-web-1`, `nirobot-db-1`.
- API y web activas; PostgreSQL marcado healthy.
- Comparación recursiva: `apps/api/src` coincide con `/app/src` de la API desplegada.
- `/health`: HTTP 200, `database: connected`.
- Proveedor: `baileys-caller`, disponible; biblioteca y ffmpeg presentes. Esta comprobación solo valida dependencias, no conectividad o audio.
- Otros contenedores llamados Niro no se usaron como evidencia de funcionamiento de Nirobot.

## Defectos y limitaciones de llamadas

### 1. El botón de llamada del chat no transporta voz del navegador — confirmado en código

`apps/api/src/lib/callCampaigns.js:475` llama al proveedor con `audioSource: 'silence'` y duración predeterminada de 60000 ms. El flujo `Inbox.tsx` inicia y consulta la llamada por HTTP, pero no conecta micrófono/altavoces al proveedor. El uso de getUserMedia en otros puntos de Inbox corresponde a notas de voz y cámara.

Impacto: aunque el destinatario reciba y conteste la llamada, este flujo no permite conversar desde el CRM. No demuestra por sí solo por qué un destinatario no recibe timbrado.

Corrección necesaria: definir e implementar el transporte bidireccional de audio, con captura/reproducción, autorización por llamada, estados de conexión y cierre. La UI debe comunicar las capacidades reales mientras ese flujo no exista.

### 2. Colgar manualmente deja pendiente la finalización — reproducido sin red

En `baileys-caller/dist/index.mjs`, `ActiveCall.end()` marca `#ended=true` antes de que `_forceEnd()` pueda resolver la promesa de cierre. `_forceEnd()` retorna inmediatamente si esa marca está activa.

La prueba llama a `end()`, simula el estado terminal y ejecuta `_forceEnd('hangup')`: `waitForEnd()` continúa sin resolver. El control positivo de cierre remoto sí resuelve.

Impacto en Nirobot: `callProvider.js:215` depende de esa promesa para cerrar el cliente de voz y reanudar WhatsApp. `callCampaigns.js` depende de ella/evento para cerrar registros y liberar bloqueos. La consulta periódica a `_forceEnd()` no soluciona esa condición.

Corrección necesaria: finalizador idempotente que resuelva una sola vez tanto al colgar localmente como al recibir cierre remoto; probar cierre, liberación de cuenta y recuperación del chat. Fijar la revisión de la dependencia o aplicar una corrección reproducible, no editar solo el contenedor en ejecución.

### 3. El corte automático por duración también deja pendiente la finalización — reproducido sin red

El temporizador del proveedor llama al mismo `end()`. La prueba con duración de 10 ms sigue pendiente a los 100 ms. Mismo impacto que el punto anterior.

Pruebas reproducibles: [provider-probe.mjs](provider-probe.mjs), [provider-results.json](provider-results.json). Se usa la biblioteca copiada del contenedor y un motor ficticio: no se inicializa WhatsApp ni se accede a credenciales.

### 4. Contrato de eventos incompatible con campañas — confirmado en código

`callCampaigns.js:328` exige `connected && reason === 'hangup'` para registrar COMPLETED. La versión instalada finaliza remotamente con `ended` o `remote_end`; no emite `hangup`. Así, una campaña conectada que termine normalmente puede quedar FAILED y no enviar su encuesta posterior.

También se escucha `audio-started`, pero la biblioteca instalada no emite ese evento. PLAYING no tiene evidencia real en este contrato.

Corrección necesaria: adaptar motivos/eventos del proveedor y distinguir llamada contestada, audio reproducido, cierre normal, rechazo y error. No marcar éxito solo porque se conectó.

### 5. El tiempo de espera para contestar se utiliza como duración total — confirmado en código

`callCampaigns.js:312` pasa `answerTimeoutSeconds * 1000` como `durationMs`. En la biblioteca ese temporizador empieza al crear ActiveCall y cuelga toda la llamada, incluso contestada. Puede cortar audios antes de terminar.

Corrección necesaria: separar el límite de timbrado del límite de conversación/reproducción; cancelar el primero al contestar y finalizar según reproducción real.

### 6. Limpieza incompleta si falla connect() — riesgo identificado en código

`callProvider.js:157-159` guarda el cliente en el mapa solo después de `await client.connect()`. Si connect abre recursos y luego falla, `closeAccount()` no lo encuentra; podría quedar un socket de voz compitiendo con el chat. No se reprodujo contra WhatsApp.

Corrección necesaria: desconectar el cliente parcialmente creado en el catch de getClient, con límites de tiempo y pruebas de fallo en cada fase.

## Otras observaciones

- Los logs contienen `ERR_ERL_UNEXPECTED_X_FORWARDED_FOR`: Express no configura trust proxy mientras Nginx agrega X-Forwarded-For. Riesgo de compartir el límite de acceso entre visitantes. Corregir según la cadena real Cloudflare/Traefik/Nginx; no habilitar confianza indiscriminada.
- Logs QR: renovaciones por 408 (`QR refs attempts ended`) y cierre 428 (`Connection Terminated`). El acceso QR sí generó un código en la comprobación visual. Estos logs, por sí solos, no prueban la causa del fallo de llamadas.
- La consulta de historial devolvió dos llamadas directas COMPLETED con duración de 60 segundos y ningún intento de campaña. Es información histórica; no prueba timbrado ni conversación. No se imprimieron teléfonos ni contenido de conversaciones.
- Las llamadas entrantes no están soportadas por la biblioteca según su documentación; si el problema se refiere a recibirlas, falta esa capacidad. Fuente: https://github.com/SheIITear/baileys-caller#status.

## Verificación por flujo

| Flujo | Evidencia | Límite |
|---|---|---|
| Web pública y acceso de agentes | Navegación visual, QR y formulario visibles; sin errores JS al revisar | No se inició sesión |
| API y base | Health real 200 y DB connected | No implica éxito de integraciones |
| Rutas privadas sin sesión | 401 en me, contactos, conversaciones, proveedor/historial de llamadas, pedidos e informes | No se probaron todos los roles en producción |
| Login, cookies, CSRF y sesiones | Suite auth aprobada | Base aislada |
| Roles y aislamiento entre organizaciones | Suites rbac e isolation aprobadas | Casos existentes, no auditoría de seguridad exhaustiva |
| Conversaciones y adjuntos | Suites conversations y attachments aprobadas | Transporte externo simulado |
| Tiempo real | Suite realtime aprobada | Falta recorrido visual autenticado desplegado |
| Widget | Suite widget aprobada | Falta instalación real en sitio tercero |
| Campañas de mensajes/API pública | 10/11 inicial; 11/11 en repetición focalizada | Prueba temporalmente inestable, sin entrega WhatsApp real |
| Reanudación de campañas | Suite campaign-resume aprobada | Casos simulados |
| Pedidos e informes | Suites orders y reports aprobadas | Datos de prueba |
| IA, bots, transcripción/OCR y consumo | ai, ai-bot, ai-read, ai-usage y bot aprobadas | Proveedor IA simulado; no certifica modelo, coste ni salida real |
| Push | Suite push aprobada | Servicio push simulado, no dispositivo real |
| Identificadores WhatsApp | Suite whatsapp-identifiers aprobada | No emparejamiento real |
| Llamadas: simulador/validación | 4 pruebas existentes aprobadas | No hay cobertura de rutas completas de llamadas reales |
| Llamadas: cierre del proveedor instalado | Control remoto pasa; local y temporizado fallan | Prueba de biblioteca sin teléfono |
| Usuarios, departamentos, configuración, CRM, editor de bot, portal desarrolladores | Rutas inventariadas y cobertura parcial indirecta | Pendiente recorrido visual autenticado por rol |

## Pruebas generales

Imagen `nirobot-api` con PostgreSQL 16 nuevo, red Docker `--internal`, sin volúmenes ni credenciales de producción. Migraciones aplicadas correctamente.

- Primera ejecución: 20 suites, 19 aprobadas y 1 fallida; 121 pruebas, 120 aprobadas y 1 fallida.
- Fallo: campañas, registro del envío en conversación; `sentMessage` fue null tras esperar 100 ms.
- Repetición exclusiva de campañas, sin modificar código: 11/11 aprobadas.
- Clasificación: fallo intermitente de test/temporización; no evidencia suficiente para afirmar pérdida real de mensajes. Sustituir espera fija por espera acotada de condición observable y esperar trabajadores antes de limpiar la base de pruebas.
- La suite completa no se repitió; no se presenta como una ejecución íntegra verde.

Detalle: [pruebas.md](pruebas.md). Inventario estático de 126 declaraciones de endpoints: [rutas.md](rutas.md).

## Pendiente para certificar extremo a extremo

1. Aclarar síntoma: no timbra, no hay audio, entrantes ausentes o historial incorrecto.
2. Acceso de pruebas autenticado para recorrer la UI por rol, organización y navegador.
3. Números de prueba autorizados, con alguien que confirme timbrado y audio; comprobar contestación, rechazo, no respuesta, ambos cierres, segunda llamada y recuperación de mensajes.
4. Audio de campaña conocido, final de reproducción, encuesta y respuesta reales; reintento, pausa/cancelación y reinicio.
5. Servicios IA y push reales de pruebas, con presupuesto y dispositivos pertinentes.
6. Corregir y desplegar los defectos anteriores antes de certificar las llamadas.

No se pidió ni se recibió todavía información suficiente para ejecutar esas comprobaciones reales. El estado de esta auditoría es PARCIAL, con defectos confirmados y resultados reproducibles.
