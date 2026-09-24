# 03 · Funciones del panel (manual de uso, sección por sección)

Panel web en `http://<host>:8787`. Menú lateral (colapsable) + barra superior
(búsqueda, notificaciones, Messenger, color del sistema, menú del perfil). En celular
el menú es un panel lateral y la navegación principal pasa a una barra inferior.

---

## 1. Inicio (`#/home`)
1. Portada con foto y nombre del perfil conectado, estado de conexión.
2. Botones: **Conectar Facebook**, **Actualizar avisos**, **Crear publicación**, **Programar**.
3. Métricas: avisos sin leer, chats, programaciones pendientes, grupos, páginas.
4. Actividad de los últimos 14 días y distribución por tipo de aviso.
5. Composer rápido: Historia, Foto/video, Publicar en todo, Programar.
6. Columna derecha: interruptores **Monitoreo de avisos** y **Publicación automática**, contactos de Messenger.

## 2. Crear publicación (`#/publicar`)
1. **Destinos** (pestañas): Perfil · Historia · Grupos · Páginas · Instagram · **Todo** (combinación libre).
2. Lista de destinos con búsqueda, foto, “Seleccionar visibles” y “Limpiar”; actualizar grupos/páginas desde ahí.
3. Texto (3–5.000 caracteres), emojis, adjuntos (fotos, videos, archivos; hasta 100 MB c/u) con vista previa.
4. **Vista previa estilo Facebook** del resultado.
5. Bloque **Instagram**: cuentas conectadas, formato (Publicación/carrusel ≤10, Reel, Historia), descripción propia.
6. **Responder interacciones con Niro** (IA por publicación): configuración general / instrucciones exclusivas / no responder, y campaña.
7. **Enviar interesados al CRM**: tablero, columna inicial y agente responsable.
8. **Publicar ahora**:
   - Un destino → se publica **directo** (sin ventana de confirmación, para permitir automatizar).
   - Varios destinos → envío masivo en segundo plano, uno por uno, con la pausa elegida (20 s–1 h).
   - Opción “Confirmar antes” (se recuerda en el navegador; por defecto apagada).
9. **Programar**: varias fechas (cada una con texto y adjuntos propios opcionales), atajos “Mañana 9:00”
   y “Próximos 7 días”, intervalo entre destinos y la casilla **Publicar automáticamente**.

## 3. Programación (`#/programacion`)
1. Calendario mensual; tocar un día agrega una fecha nueva.
2. Interruptor **Activar/Pausar automatización** (programador).
3. Cada programación: destinos, progreso por destino (publicado/fallido/en cola), próxima fecha.
4. Acciones: **Preparar/Revisar siguiente**, **Publicar pendientes ahora**, **Pausar/Reanudar**,
   **Reintentar fallidas**, **Quitar**.
5. Cada destino es un **trabajo independiente**: si falla uno, se reintenta solo ese.

## 4. Notificaciones (`#/notificaciones`)
1. Bandeja clasificada: comentarios, reacciones, menciones, Messenger, Marketplace, seguridad, otros.
2. Filtros con contador, marcar leído/no leído, **Marcar todo como leído**.
3. Detalle: texto, persona, enlace **Abrir hilo original**.
4. **Preparar respuesta** (con borrador de Niro) y enviar; **Enviar al CRM** / **Ver en CRM**.
5. Tiempo real: aviso emergente, contador en la campana y aviso de escritorio (si se habilita).

## 5. Messenger (`#/messenger`)
1. Lista de chats con foto, último mensaje y no leídos; búsqueda; descarga JSON.
2. Historial guardado de cada chat y **Sincronizar este chat**.
3. Responder (Enter prepara, confirmación antes de enviar).
4. **Enviar al CRM** / **Ver en CRM**.

## 6. Publicaciones (`#/publicaciones`)
Dos pestañas:
- **Publicado con Niro** (historial): filtros por texto, **fecha desde/hasta**, **destino**
  (perfil, historia, grupo, página, Instagram), cuenta, estado (publicada/falló) y origen
  (manual, programada, automática, envío masivo). Selección con **Seleccionar todo**,
  **Eliminar seleccionadas**, **Eliminar todo / las filtradas**, eliminar de a una,
  **Marcar publicada** (corrige un falso fallo). Exporta CSV/JSON.
- **Descargadas**: publicaciones leídas de Facebook (perfil, páginas y grupos) con los mismos
  filtros y borrado. Eliminar solo borra de Niro, **nunca** de Facebook/Instagram.

## 7. Grupos (`#/grupos`) y Páginas (`#/paginas`)
1. Listas con foto, búsqueda, cantidad de miembros/última actividad.
2. **Actualizar grupos / páginas** (lee de Facebook), exportar CSV.
3. Selección múltiple para publicar o para descargar sus publicaciones.

## 8. Explorar grupos (`#/explorar`)
1. **Segmentos**: nombre + palabras clave. **Buscar en Facebook** recorre cada palabra en la
   búsqueda de grupos y agrega los nuevos como *Por revisar* (privacidad, miembros, actividad, foto).
2. **Grupos encontrados (catálogo)**: filtros (texto, segmento, estado, privacidad), selección múltiple:
   *Marcar para unirme*, *Por revisar*, *Descartar*, **Leer ficha** (descripción y reglas), *Quitar*.
3. **Programar solicitudes**: desde fecha, cantidad por día (1–20, por defecto 5), franja horaria (9–18).
4. **Agenda**: próximas solicitudes (cancelar una o todas), historial de intentos con nota/error.
   Si el grupo pide **responder preguntas o aceptar reglas**, NO se responde solo: la tarea queda
   *Requiere tu intervención* y **Completar** abre el grupo con ventana.
5. **Seguimiento**: solicitudes enviadas, miembro desde, última revisión; **Revisar solicitudes**
   confirma aprobaciones (y agrega el grupo a *Grupos* para publicar) o marca rechazos.
6. Interruptor para **pausar la agenda**.
Estados: por revisar · seleccionado · programado · solicitud enviada · miembro · rechazado · descartado · requiere intervención.

## 9. Respuestas IA (`#/respuestas`)
1. **Activar**, modo general **Automático / Supervisado / Solo notificar**, **Parada de emergencia**.
2. Métricas: pendientes, enviadas, derivadas, ignoradas/notificadas, con error.
3. Pestañas:
   - **Bandeja**: filtros por estado/categoría/canal; por cada interacción: texto original, contexto de la
     publicación, categoría y confianza, respuesta propuesta editable, acciones **Aprobar, Editar,
     Regenerar, Derivar, Ignorar, Tomar el hilo / Liberar**, historial.
   - **Por publicación**: estadísticas por publicación.
   - **Instrucciones** por capas: general → cuenta → campaña → publicación (la más específica manda),
     con versión, modo y campos (tema, oferta, datos autorizados, preguntas frecuentes, tono, contacto,
     cuándo derivar, instrucciones adicionales).
   - **Configuración**: canales (comentarios, menciones, Messenger), modo por cuenta, voz, temas fuera de
     lugar, **base de conocimiento**, derivación (departamento de Niro, agente), límites
     (por hilo 3, espera 3 min, 40 por hora, 600 caracteres), enviar prospectos al CRM de Niro,
     **Procesar últimas N horas** (backfill).
   - **Prospectos** detectados, **Historial** (auditoría), **Probar** (simulación sin enviar).
4. Envío: responde en el hilo exacto **con la voz de la página dueña** de la publicación y vuelve al perfil personal.

## 10. CRM (`#/crm`)
1. **Tableros** con columnas configurables (color, tipo: nuevo, contactado, cotización, seguimiento,
   en proceso, ganado, perdido), varios embudos por tablero, reordenar columnas.
2. **Kanban**: arrastrar tarjetas entre columnas (en táctil, con el selector *Etapa*). “Perdida” pide motivo.
3. **Ficha de oportunidad**: contacto, valor, agente, origen y atribución (red → cuenta → campaña →
   publicación → interacción), actividades, notas con adjuntos, tareas, historial de etapas, responder.
4. **Tareas**: con fecha/hora y responsable; aviso al vencer (panel + escritorio).
5. **Contactos**: identidades por canal, sugerencia de **unir duplicados** (decide un agente),
   **Borrar datos del contacto** (elimina todo lo relacionado).
6. **Campañas**: filtros por tablero, columnas, etiquetas, producto, origen, último contacto; vista previa
   de quién no puede recibir (sin teléfono, sin autorización, fuera de la ventana de 24 h); guardar y **CSV**.
7. **Reportes**: interesados, contactados, cotizaciones, ventas, valor ganado; por publicación/formulario/
   campaña, por canal, por responsable; motivos de pérdida.
8. **Trabajás como**: nombre del agente que queda registrado en cada cambio.
9. Captura automática: mensajes de Messenger, comentarios con intención de compra, formularios
   (Meta, Google Ads, web). Un “me gusta” o compartido **no** crea tarjeta.

## 11. Borradores (`#/borradores`)
Borradores de respuesta generados por Niro para cada aviso (plantilla o `NIRO_DRAFT_WEBHOOK`); se pueden
editar, usar o descartar.

## 12. Datos (`#/datos`)
1. **Conexión**: Conectar/Cerrar navegador, **Mostrar navegador / Volver a segundo plano**, **Restaurar perfil**.
2. **Sincronización a pedido** (modo por defecto: solo publicar):
   perfil, páginas, grupos, notificaciones, lista de chats, historial de mensajes, historial de
   publicaciones (perfil + páginas/grupos elegidos). “Solo esto”, “Sincronizar lo seleccionado”,
   progreso en vivo y **Detener**. Barra flotante mientras corre.
3. **Instagram · cuentas conectadas**: Revisar cuentas, Conectar Instagram (abre Business Suite).
4. **Base de datos**: motor, estado, conteo por tabla.
5. **Descargas**: exportaciones JSON/CSV de avisos, chats, grupos, páginas, publicaciones, etc.
6. Avisos de escritorio, cambiar tema, cargar datos de ejemplo (demo).

## 13. Apariencia
Color del sistema: Azul, Violeta, Verde, Naranja, Grafito (oscuros) o Claro. Menú lateral minimizable
con insignias. Diseño adaptable a escritorio, tablet y celular.

## 14. Login (opcional)
Si `NIRO_PANEL_PASSWORD` está definida, `/login.html` pide la contraseña (una sola para todo el panel);
**Cerrar sesión del panel** en el menú del perfil.
