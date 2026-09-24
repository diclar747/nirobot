# 01 · Instalación y despliegue

## 1. Requisitos

| Componente | Versión | Notas |
| --- | --- | --- |
| Node.js | 20 o superior (probado en 24) | ESM puro (`"type": "module"`), sin compilación. |
| PostgreSQL | 14 o superior (probado en 17) | Base `autofacebook`, codificación UTF-8. |
| Navegador | Chrome o Edge instalado, o Chromium de Playwright | Lo maneja Playwright con un perfil persistente propio. |
| Sistema | Windows 10/11 o Linux (Ubuntu/Debian) | En Linux sin escritorio ver §6. |
| Dependencias npm | `pg`, `playwright`, `dotenv` | Solo tres: todo lo demás es Node estándar. |

Memoria recomendada: 2 GB libres (Chrome + Node). Disco: ~100 MB + crecimiento de `data/`.

## 2. Restaurar la base de datos

### Opción A — SQL plano (cualquier versión 14+)
```bash
createdb -h localhost -U postgres -E UTF8 -T template0 autofacebook
psql -h localhost -U postgres -d autofacebook -v ON_ERROR_STOP=1 -f base-de-datos/autofacebook-completo.sql
```

### Opción B — formato binario (permite restaurar tablas sueltas)
```bash
createdb -h localhost -U postgres -E UTF8 -T template0 autofacebook
pg_restore -h localhost -U postgres -d autofacebook --no-owner --no-privileges base-de-datos/autofacebook.dump
# una sola tabla:  pg_restore ... -t crm_contacts base-de-datos/autofacebook.dump
```

### Opción C — scripts incluidos
- Windows: `powershell -ExecutionPolicy Bypass -File base-de-datos\restaurar.ps1`
- Linux: `bash base-de-datos/restaurar.sh`

Ambos aceptan variables `PGHOST`, `PGPORT`, `PGUSER`, `PGPASSWORD` y el nombre de la base
como primer argumento (por defecto `autofacebook`). **No sobrescriben** una base existente.

### Opción D — base vacía
Si se quiere empezar sin datos: crear la base vacía y arrancar el panel. `db.mjs`
crea todas las tablas (`CREATE TABLE IF NOT EXISTS`) en el primer arranque. Si existe
`data/niro.json` y la base está vacía, lo importa automáticamente; borrar ese archivo
para empezar realmente de cero.

> El usuario de la base no necesita ser superusuario: basta con que sea dueño de la
> base (crea tablas, índices y la vista `group_memberships`).

## 3. Instalar la aplicación

```bash
cd sistema
npm install                     # instala pg, playwright y dotenv
npx playwright install chromium # solo si el servidor no tiene Chrome/Edge
# Linux además: npx playwright install-deps chromium  (librerías del sistema)
```

Copiar/ajustar la configuración: el `.env` incluido es el de producción de Windows.
Revisar como mínimo:

| Variable | Valor en el paquete | Qué ajustar en el servidor nuevo |
| --- | --- | --- |
| `NIRO_DATABASE_URL` | `postgres://postgres:postgres@localhost:5432/autofacebook` | Usuario/contraseña/host reales. |
| `NIRO_HOST` | `127.0.0.1` | `0.0.0.0` solo si se accede sin proxy (no recomendado). |
| `NIRO_PORT` | `8787` | Cualquiera libre. |
| `NIRO_BROWSER_PROFILE` | `./data/browser-profile` | Carpeta con permiso de escritura. |
| `NIRO_BROWSER_EXECUTABLE` | vacío (busca Chrome/Edge de Windows) | En Linux: `/usr/bin/google-chrome` o vacío para Chromium de Playwright. |
| `NIRO_HEADLESS` | `true` | `true` en servidores; `false` para ver la ventana. |
| `NIRO_SCHEDULER_AUTOSTART` | `true` | `false` durante la migración (ver LEEME §5). |
| `NIRO_PANEL_PASSWORD` | vacío | **Obligatorio** si el panel es accesible desde la red. |
| `NIRO_SESSION_SECRET` | vacío | Cadena aleatoria larga (≥ 32 caracteres). |
| `NIRO_ALLOWED_HOSTS` | vacío (solo 127.0.0.1/localhost) | Dominio público, p. ej. `facebook.niro.cnid.com.py`. |
| `NIRO_AI_API_KEY` | clave real | Rotarla y pegar la nueva. |

Lista completa de variables con su efecto: `.env.example` y `02-ARQUITECTURA.md §9`.

## 4. Primer arranque

```bash
npm run check    # verifica sintaxis de todos los módulos
npm test         # 20 pruebas (CRM y explorador) sin Facebook ni PostgreSQL
npm start        # primer plano; Ctrl+C lo detiene ordenadamente
```

En la consola debe verse:
```
Niro local disponible en http://127.0.0.1:8787
Perfil separado: <ruta>/data/browser-profile
```
Para confirmar que está usando PostgreSQL (y no el JSON):
`curl http://127.0.0.1:8787/api/status` → `"storage":{"engine":"postgresql",...}`.
Si dice `"engine":"json"`, `NIRO_DATABASE_URL` está vacía o no es válida. Si PostgreSQL
no responde al arrancar, el servidor **se detiene con error** (no arranca con datos a medias).

Luego, en el panel:
1. **Conectar Facebook** (menú del perfil o Inicio). Se abre Chrome con el perfil de `data/browser-profile`.
2. Como el perfil es nuevo, ir a **Datos → Conexión → Mostrar navegador**, iniciar
   sesión en Facebook a mano (y resolver la verificación si la pide).
3. **Volver a segundo plano**. Desde ahí el navegador trabaja sin ventana.
4. **Datos → Sincronización → Perfil** para confirmar que la sesión es la correcta.
   (Páginas, grupos, etc. ya vienen en la base; no hace falta volver a descargarlos.)

> Si Facebook detecta un equipo/IP nuevos puede pedir código o aprobación desde el
> celular: es normal la primera vez. Resolverlo en la ventana visible.

## 5. Windows como servicio en segundo plano

Scripts incluidos (usan PowerShell, sin ventana, registro en `data\logs\`):
```powershell
npm run panel:iniciar   # scripts/iniciar-panel.ps1
npm run panel:detener   # scripts/detener-panel.ps1 → cierra Facebook primero y luego Node
```
Para que arranque con Windows: Programador de tareas → “Al iniciar sesión” →
`powershell -NoProfile -ExecutionPolicy Bypass -File <ruta>\scripts\iniciar-panel.ps1`.
Debe correr **con la sesión del usuario** (Chrome necesita un perfil de usuario).
Alternativas: NSSM o pm2 (`pm2 start server.mjs --name niro-facebook`).

**Nunca matar el proceso de golpe** (Administrador de tareas): Chrome deja el perfil
bloqueado (`SingletonLock`) y el siguiente arranque falla hasta limpiarlo. El panel
tiene **Datos → Restaurar perfil** para ese caso (`POST /api/browser/restore-profile`).

## 6. Linux (servidor)

```bash
sudo apt install -y postgresql nodejs npm
cd sistema && npm install && npx playwright install --with-deps chromium
```
- Con `NIRO_HEADLESS=true` no hace falta escritorio. Para iniciar sesión en Facebook
  la primera vez hace falta ver la ventana: usar `xvfb-run` + VNC, o **iniciar sesión
  en una máquina con escritorio y el mismo sistema operativo** y copiar la carpeta
  del perfil (en Linux las cookies no están atadas al usuario como en Windows).
- Servicio systemd de ejemplo:

```ini
# /etc/systemd/system/niro-facebook.service
[Unit]
Description=Niro Autopost Facebook
After=network.target postgresql.service

[Service]
WorkingDirectory=/opt/niro/sistema
ExecStart=/usr/bin/node server.mjs
Restart=on-failure
User=niro
Environment=NODE_ENV=production
KillSignal=SIGINT
TimeoutStopSec=15

[Install]
WantedBy=multi-user.target
```
`KillSignal=SIGINT` es importante: dispara el cierre ordenado (cierra Chrome y PostgreSQL).

## 7. Publicarlo con HTTPS (proxy)

El panel escucha en `127.0.0.1`. Ponerle delante Nginx o Caddy:

```nginx
server {
  server_name facebook.midominio.com;
  location / {
    proxy_pass http://127.0.0.1:8787;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_http_version 1.1;
    proxy_set_header Connection "";      # necesario para SSE (/api/stream)
    proxy_buffering off;                 # eventos en tiempo real sin demora
    proxy_read_timeout 1h;
    client_max_body_size 150m;           # adjuntos de hasta 100 MB en base64
  }
}
```
Y en `.env`: `NIRO_ALLOWED_HOSTS=facebook.midominio.com`, `NIRO_PANEL_PASSWORD=...`,
`NIRO_SESSION_SECRET=...`. La cookie se marca `Secure` cuando llega `X-Forwarded-Proto: https`.

## 8. Respaldo

```bash
pg_dump -U postgres -Fc autofacebook > autofacebook-$(date +%F).dump
tar czf niro-data-$(date +%F).tgz sistema/data/images sistema/data/uploads
```
`data/browser-profile` se respalda aparte solo si se quiere conservar la sesión en el
**mismo** equipo.

## 9. Comprobaciones después de migrar

| Prueba | Resultado esperado |
| --- | --- |
| `GET /api/status` | `{"ok":true, "storage":{"engine":"postgresql",...}}` |
| `GET /api/db/status` | Conteo por tabla igual al de `LEEME-PRIMERO.md §4` |
| Abrir Grupos / Páginas | Fotos visibles (vienen de `data/images`) |
| Publicaciones → Historial | 47 registros |
| Crear publicación → adjuntar | Sube a `data/uploads` y muestra vista previa |
| Adjuntos antiguos en Programación | Siguen disponibles (se re-ubican solos en `data/uploads`) |
