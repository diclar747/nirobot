# NIRO: entrega de PWA y experiencia móvil

Fecha: 21 de septiembre de 2026.
Repositorio compartido: `/root/nirobot`, aplicación: `niro-enterprise-inicial`.

## Estado de entrega

Implementación local preparada para revisión y publicación por el agente de despliegue. **No se publicó ni se reiniciaron los servicios productivos.** La compilación y las verificaciones de interfaz/PWA se ejecutaron localmente. Las pruebas de atención usaron datos ficticios y respuestas API interceptadas; no equivalen a una prueba de WhatsApp real, base de datos o notificaciones en teléfonos físicos.

El repositorio ya tenía cambios de otro agente, y siguió recibiéndolos durante este trabajo. No usar `git reset`, no sustituir archivos por versiones de HEAD y no publicar todos los cambios sin revisar su alcance. En particular, `Layout.tsx` contiene tanto el menú móvil de esta entrega como ajustes ajenos de identidad/reconexión que deben conservarse.

## Lo implementado

- PWA con identidad estable, inicio en `/inbox`, ventana independiente, idioma español e iconos PNG 192/512. Icono maskable con margen seguro para Android y Apple Touch Icon 180 para iOS.
- Los iconos provienen del SVG del robot existente en `NiroMascot.tsx`; no se inventó otra marca. Pantalla inicial con el robot y estado de carga de rutas protegidas.
- Botón de instalación y guía para navegadores sin diálogo programático. En móvil autenticado se accede desde el menú para no tapar controles; en el login aparece directamente.
- Un único service worker en `/sw.js`, conservando las notificaciones push previas. No se registró otro worker que compita por el mismo scope.
- Pantalla offline pública. Solo se cachean `/offline.html` y `/icons/niro-192.png`. API, autenticación, conversaciones, archivos, sockets y HTML de la aplicación no se guardan en Cache Storage por este worker. No hay cola de envíos offline ni reintentos automáticos que puedan duplicar mensajes.
- Versión del worker calculada por build, activación solicitada por el usuario y aviso antes de recargar. Revisión de versiones al volver a la aplicación.
- Menú lateral móvil, áreas seguras de pantalla, altura dinámica y ajuste al viewport del teclado. Lista de chats y conversación se muestran en vistas separadas hasta 860 px. Contacto en panel superpuesto, acceso táctil a transferir, crear pedido y cambiar etapa.
- Enlaces de conversación y navegación de historial. Borradores separados por conversación, conservados **en memoria mientras el Inbox permanece montado**, incluyendo el modo nota interna. No persisten al recargar, cerrar sesión o salir del módulo. El Enter en pantalla táctil inserta una línea; el botón envía.
- Errores de envío/transferencia visibles. El borrador no se limpia cuando falla el envío. Una invitación de transferencia fallida permanece disponible para reintentar.
- Modales con semántica de diálogo, enfoque inicial, ciclo de tabulación y devolución del foco. Navegación por teclado en la lista de conversaciones.
- Dashboard adaptado a teléfono, estadísticas compactas, reportes de una columna, tablas con desplazamiento propio y estilos compatibles con los temas existentes.
- Cabeceras Nginx: worker sin caché, manifest con MIME apropiado y revalidación, HTML revalidado, assets con hash cacheables y archivos faltantes de `/assets/` devuelven 404.

## Archivos de esta entrega

En `apps/web/`:

- `public/manifest.webmanifest`, `public/offline.html`, `public/icons/*`.
- `public/sw.js`, `index.html`, `nginx.conf`.
- `src/components/PwaExperience.tsx`, `src/styles/mobile-pwa.css`.
- Integración en `src/App.tsx`, `src/main.tsx`, `src/components/Layout.tsx`.
- Adaptaciones en `src/routes/Inbox.tsx`, `src/routes/Reports.tsx`, `src/components/Modal.tsx`, `src/components/ProtectedRoute.tsx`.
- `scripts/version-sw.mjs`, `scripts/generate-pwa-icons.cjs` y comando `build` en `package.json`.

Esta entrega no cambia el esquema de base ni necesita migraciones. Las migraciones ya presentes de campañas/encuestas pertenecen al otro trabajo: revisarlas y desplegarlas con su propio procedimiento.

## Verificación realizada

- `npm run build:all`: widget, TypeScript y bundle de producción.
- `nginx -t` en contenedor efímero, sin red, con el archivo nuevo montado: correcto.
- Navegador Chromium: lista/chat/contacto, separación de borradores, envío, bloqueo offline sin pérdida del borrador, transferencia y menú.
- Anchos 320, 360, 390, 768, 1024 y 1440 px; comprobación de campo de escritura visible. Viewport reducido de 390 × 430 con editor enfocado para simular el espacio del teclado.
- Comprobaciones adicionales de dashboard, contactos, pedidos, reportes y CRM a 390 px. El tablero CRM conserva desplazamiento horizontal interno entre columnas.
- Worker real: instalación, control de página, iconos con dimensiones PNG correctas, navegación offline, API sin fallback/caché, actualización en espera hasta recibir la acción explícita.
- Chromium DevTools Protocol: manifest sin errores y `installabilityErrors: []` en perfil normal (no incógnito).
- Pruebas y resultados reproducibles en esta carpeta; capturas con datos ficticios en `screenshots/`.

**No verificado aquí:** instalación física en Windows/Android/iOS/macOS, cámara/micrófono reales, recepción Web Push con app cerrada, entrega real de mensajes o transferencias multiusuario, recuperación de sesiones reales después de suspender el teléfono. Tampoco se ejecutó una auditoría completa de permisos/multiempresa ni la batería de integración del backend contra una base de pruebas. No se declara el sistema entero certificado para producción.

## Hallazgos de producción

| Prioridad | Hallazgo | Acción para publicación |
|---|---|---|
| Alta | `npm audit --omit=dev` del backend reportó 3 entradas altas: `prisma`, `@prisma/config`, `deepmerge-ts`; corresponden a una cadena de dependencias, no a tres fallos independientes. | Revisar actualización compatible, regenerar Prisma y ejecutar pruebas contra base aislada. Registrar resolución o evaluación técnica explícita antes de publicar. No aplicar `--force` a ciegas. |
| Alta en herramientas | Auditoría completa del frontend: Vite alta y esbuild moderada. `--omit=dev` dio cero vulnerabilidades. | El runtime publicado es Nginx estático; no exponer Vite ni `vite preview`. Planificar actualización compatible del toolchain y validar widget/build. El audit propone un salto mayor; no se aplicó automáticamente en este repositorio compartido. |
| Media | Bundle principal alrededor de 907 kB / 265 kB gzip; Emoji Mart se carga aparte (~458 kB / 111 kB gzip). | Medir el arranque en Android con red móvil. Dividir rutas en una tarea de rendimiento posterior; no confundir build correcto con métricas Lighthouse aprobadas. |
| Media | Fonts externas de Google. | Validar CSP/acceso y medir; para independencia completa servir fuentes propias en una siguiente mejora. Hay fuentes de sistema como fallback. |
| Operativa | HTTPS, dominio, cookies, proxy y VAPID determinan instalación y notificaciones reales. | Verificar configuración efectiva y los pasos físicos de aceptación de abajo. |
| Operativa | Cambios simultáneos en autenticación, campañas y backend. | Revisar el diff final conjunto y repetir verificaciones sobre el commit exacto que se publique. |

Avisos registrados por npm:

- https://github.com/advisories/GHSA-ggr8-5vv4-36mx
- https://github.com/advisories/GHSA-4w7w-66w2-5vf9
- https://github.com/advisories/GHSA-v6wh-96g9-6wx3
- https://github.com/advisories/GHSA-fx2h-pf6j-xcff
- https://github.com/advisories/GHSA-67mh-4wv8-2f99

Los resultados son una fotografía del lockfile y del registro consultado en esta sesión; volver a ejecutar audit sobre el commit final.

## Instrucciones para el agente que verifica y publica

1. Revisar `git status` y el diff completo en `/root/nirobot`. Integrar esta entrega junto con los cambios autorizados del otro agente sin borrarlos. Crear un commit identificable y conservar la imagen anterior para rollback.
2. Usar Node 22 como en el Dockerfile. En `niro-enterprise-inicial/apps/web`, ejecutar `npm ci` y `npm run build:all`. Verificar que `dist/` contiene manifest, worker versionado, página offline, iconos y widget. Publicar **todo el dist de un mismo build** de forma atómica; no mezclar `index.html` de una versión con assets de otra.
3. Resolver/evaluar los hallazgos de dependencias y ejecutar las pruebas de backend sobre una base aislada. Respaldar base/adjuntos/sesiones antes de aplicar cambios de backend o migraciones de las otras tareas.
4. Revisar HTTPS válido, `COOKIE_SECURE=true`, `WEB_ORIGIN` exacto y `TRUST_PROXY` limitado al proxy real. No mostrar secretos en reportes. API y WebSocket deben seguir disponibles en el mismo origen. Mantener volúmenes de base, adjuntos y sesiones de WhatsApp.
5. Para pruebas locales de UI, iniciar `npm run preview -- --host 127.0.0.1 --port 5189` y ejecutar los scripts siguientes. El script móvil intercepta `/api/**` y `/socket.io/**` con fixtures. El script del worker levanta su propio servidor local efímero, sin backend.

```bash
# Desde niro-enterprise-inicial, usando Node >=20 (preferir 22)
npm install --prefix /tmp/niro-pwa-verify --no-audit --no-fund playwright@1.63.0
/tmp/niro-pwa-verify/node_modules/.bin/playwright install chromium
NODE_PATH=/tmp/niro-pwa-verify/node_modules node audit/2026-09-21-pwa/verify-mobile.cjs
NODE_PATH=/tmp/niro-pwa-verify/node_modules node audit/2026-09-21-pwa/verify-worker.cjs
```

`PWA_CHROMIUM_PATH` permite usar un Chromium ya instalado. Las capturas salen en `/tmp/niro-*.png`. No ejecutar los fixtures apuntando a una URL productiva; usan localhost deliberadamente.

6. Construir y desplegar con el flujo Docker/Dokploy **ya utilizado por este proyecto**, incluyendo el nuevo `nginx.conf`. Si solo se publica la PWA, no reiniciar API/base innecesariamente. Si se publica el lote conjunto, seguir el procedimiento de migraciones y respaldo del otro agente. No usar el servidor de desarrollo como servidor público.
7. En el dominio publicado comprobar:

```bash
# Sustituir el dominio antes de ejecutar.
curl -I https://DOMINIO/manifest.webmanifest
curl -I https://DOMINIO/sw.js
curl -I https://DOMINIO/icons/niro-192.png
curl -I https://DOMINIO/icons/niro-512.png
curl -I https://DOMINIO/inbox
curl -I https://DOMINIO/assets/archivo-inexistente.js
```

Esperado: manifest 200 y `application/manifest+json`; worker 200, JavaScript y `no-cache/no-store`; iconos PNG; `/inbox` devuelve HTML de la SPA; asset inexistente 404. Revisar que CDN/proxy no sobreescriba la política del worker/HTML. Confirmar también `/api/health`, login y conexión WebSocket.

8. Pruebas físicas con cuentas de prueba y dos agentes: instalar, abrir desde el robot, autenticar, recibir/responder mensaje, transferir a agente y departamento, aceptar/rechazar desde el receptor, adjuntar imagen/documento, grabar audio y probar permisos de micrófono. Comprobar teclado, orientación, volver a la lista, enlaces de notificaciones y cerrar/reabrir la PWA. La prueba de API interceptada no cubre estas entregas reales.
9. Push: confirmar claves VAPID propias ya existentes, no regenerarlas al desplegar. Suscribir desde la campanita y enviar un mensaje de prueba con app cerrada. En iOS/iPadOS probar desde la app añadida a inicio y con permiso explícito. Las restricciones de batería/sistema y la lógica del backend influyen en la entrega.
10. Actualización: mantener una versión anterior abierta con borrador, desplegar otra, volver a la app y confirmar que aparece «Actualizar» sin recarga automática. Guardar/enviar borradores antes de aceptar. Probar varias ventanas. Desconectar red y relanzar: debe verse la página offline sin datos privados.
11. Cerrar con evidencia: commit/imagen/dominio exactos, pruebas ejecutadas, dispositivos usados, audit final y resultados. Si falla una aceptación, revertir a la imagen anterior completa y validar el acceso. No borrar datos ni sesiones para solucionar un problema de frontend.

## Instalación para usuarios

- Windows: Chrome o Edge, «Instalar NIRO» o menú del navegador → instalar aplicación.
- Android: Chrome u otro navegador compatible → instalar/añadir a pantalla de inicio.
- iPhone/iPad: Safari → Compartir → Añadir a pantalla de inicio; habilitar «Abrir como app» si aparece.
- Mac: Safari → Archivo → Añadir al Dock, o instalación desde Chromium compatible.

La PWA comparte el backend del sistema. No requiere publicar en Microsoft Store, Play Store o App Store. La instalación y el aspecto del splash del sistema dependen del navegador/OS; no se promete instalación nativa en todo navegador. Conversaciones y operaciones requieren Internet.

Referencias oficiales consultadas: [instalabilidad PWA (MDN)](https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/Guides/Making_PWAs_installable), [diálogo de instalación (MDN)](https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/How_to/Trigger_install_prompt), [Web Push en iOS/iPadOS (WebKit)](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/).

## Regenerar iconos (solo al cambiar el robot)

Los PNG están incluidos y el build no necesita herramientas de dibujo. Para regenerarlos desde `NiroMascot.tsx`:

```bash
npm install --prefix /tmp/niro-pwa-icons --no-audit --no-fund @resvg/resvg-js
NODE_PATH=/tmp/niro-pwa-icons/node_modules node apps/web/scripts/generate-pwa-icons.cjs
```

Revisar visualmente los PNG/maskable después de editar el SVG. Mantener los nombres o actualizar manifest, HTML y worker juntos.
