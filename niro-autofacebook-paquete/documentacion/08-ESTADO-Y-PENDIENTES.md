# 08 · Estado actual, pendientes y límites conocidos

Fecha: 24/09/2026 · Versión 0.9.0 · Cuenta: Dickel Claudio (19 páginas, 503 grupos).

## 1. Qué está terminado y probado en vivo

| Módulo | Estado |
| --- | --- |
| PostgreSQL `autofacebook` (32 tablas + vista), respaldo JSON de emergencia | Funcionando |
| Interfaz rediseñada (estilo Niro/Facebook, temas, móvil) | Funcionando |
| Publicar en perfil, grupo, página (como la página), historia | Probado con publicaciones reales |
| Envíos masivos y programaciones (trabajo por destino, reintentos, reanudación tras reinicio) | Probado (13/13 páginas; grupos con fallos legítimos) |
| Sincronización a pedido con Detener (perfil, páginas, grupos, avisos, chats, historial, publicaciones) | Probado (19 páginas, ~500 grupos, 27 chats, 191 mensajes, 284 publicaciones) |
| Chrome sin ventana (headless) | Funcionando |
| Instagram: detección de cuentas y publicación (post) | Probado con publicación real en @cd.diclar |
| Respuestas con IA (Niro): clasificación, redacción, modos, envío como página, auditoría | Probado con respuesta real como página “Consejo de Desarrollo” |
| Publicaciones: filtros por fecha/destino/estado/origen, seleccionar todo, borrar | Funcionando |
| Explorar grupos: segmentos, búsqueda, ficha, agenda, seguimiento | Funcionando; agenda real en curso |
| CRM visual: tableros, kanban, ficha, tareas, contactos, campañas, reportes, webhooks | Funcionando, 20 pruebas automáticas |

## 2. Cambios hechos al preparar este paquete

1. **Adjuntos portables:** al arrancar, si la ruta absoluta guardada en `media.path` no existe
   (otro equipo/SO), se busca el archivo por nombre en `data/uploads` (`loadStore()` en `server.mjs`).
2. **Publicar en grupos más robusto:** espera hasta ~15 s al cuadro “Escribe algo…” y, si no se
   puede publicar, explica el motivo real (`groupBlocker()`): grupo en pausa, solicitud pendiente, no
   miembro, solo administradores, grupo no disponible. Tiempo máximo por trabajo de grupo: 75 s.

`npm run check` y `npm test` (20/20) pasan después de estos cambios.

## 3. Configuración activa al momento del paquete (tenerla en cuenta al arrancar)

| Elemento | Estado | Efecto al arrancar el servidor nuevo |
| --- | --- | --- |
| Respuestas con IA | **Activada**, modo general **Solo notificar** | Clasifica y avisa; no envía solo. |
| Programador | `NIRO_SCHEDULER_AUTOSTART=true` | 2 programaciones automáticas con 4 trabajos en cola se ejecutarán. |
| Agenda de grupos | **No pausada**, 166 solicitudes (5/día, 24/09 → 27/10/2026) | Se envían solas con Facebook conectado. |
| Monitor de avisos | Se enciende desde el panel | — |

## 4. Pendientes (lo que el siguiente agente puede continuar)

| # | Pendiente | Detalle |
| --- | --- | --- |
| 1 | Permisos por usuario/empresa/departamento/tablero | Hoy una sola contraseña; “Trabajás como” solo registra el nombre. Se resuelve naturalmente al integrar con el login de la plataforma (06 §3). |
| 2 | Envío real de campañas del CRM por WhatsApp/SMS | Solo existe selección + CSV + validaciones. Falta conectar con el endpoint de envío de Niro. |
| 3 | Reel de Instagram | Implementado, falta prueba real con un video. |
| 4 | Historia de Instagram | Implementada; revisar manualmente la primera publicada. |
| 5 | Respuesta de IA por Messenger | Ruta de envío implementada, no probada en vivo (sí la de comentarios). |
| 6 | Grupos con aprobación del administrador | Facebook deja la publicación “pendiente”; Niro la registra como publicada. Se podría detectar el aviso “pendiente de aprobación” tras publicar. |
| 7 | Arrastrar tarjetas en pantallas táctiles | En celular se mueve con el selector “Etapa”. |
| 8 | Webhooks de formularios | Requieren publicar con HTTPS y cargar las variables. |
| 9 | Explorador: vigilar las primeras solicitudes reales tras el ajuste de detección de “Unirte” | Cubierto por `tests/explorer.test.mjs` con página simulada. |
| 10 | Varias cuentas de Facebook | Una instancia por cuenta (06 §2B); opcional agregar `NIRO_DATA_DIR`. |
| 11 | Seguridad | Rotar `NIRO_AI_API_KEY` (se compartió por chat); definir `NIRO_SESSION_SECRET`. |

## 5. Límites conocidos (propios del enfoque)

- Automatiza la web de Facebook: si Facebook cambia textos o estructura, algún flujo puede fallar
  hasta ajustar selectores (07 §7). Puede pedir verificaciones (código, aprobación) en equipos nuevos.
- Publicar muy seguido o unirse a muchos grupos por día puede disparar límites de Facebook: mantener
  pausas (≥ 20 s entre publicaciones, ≤ 5–10 solicitudes de grupo por día).
- La descarga de publicaciones y chats guarda solo lo que Facebook carga al desplazarse.
- Instagram depende de que la cuenta profesional esté vinculada a la página en Business Suite.
- Una sola acción de navegador a la vez por instancia.

## 6. Historial de publicaciones al momento del paquete

| Destino | Publicadas | Fallidas |
| --- | --- | --- |
| Grupo | 15 | 4 |
| Página | 13 | 3 |
| Perfil | 5 | 1 |
| Historia | 1 | 1 |
| Instagram | 1 | 3 |

Los fallos de grupo corresponden a grupos pausados/solicitud pendiente y a la carga lenta ya corregida.
