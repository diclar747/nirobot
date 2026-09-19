#!/bin/sh
# Respaldo de NIRO Enterprise: base de datos Postgres + adjuntos subidos + sesiones de WhatsApp.
# Pensado para correr en el servidor donde vive el docker-compose, con Docker ya instalado — no
# necesita psql ni pg_dump en el host, usa los que ya están adentro del contenedor `db`.
#
# Uso manual:
#   ./scripts/backup-db.sh
#
# Uso automático (cron, todos los días a las 3 AM, conservando los últimos 14 respaldos):
#   0 3 * * * cd /ruta/a/niro-enterprise-inicial && ./scripts/backup-db.sh >> backups/backup.log 2>&1
#
# Variables de entorno opcionales:
#   BACKUP_DIR      Carpeta de destino (default: ./backups)
#   BACKUP_KEEP     Cuántos respaldos conservar, se borran los más viejos (default: 14)
#   COMPOSE_PROJECT Nombre del proyecto docker compose, si no es el de la carpeta actual

set -eu

cd "$(dirname "$0")/.."

if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env
  set +a
fi

BACKUP_DIR="${BACKUP_DIR:-./backups}"
BACKUP_KEEP="${BACKUP_KEEP:-14}"
POSTGRES_DB="${POSTGRES_DB:-niro}"
POSTGRES_USER="${POSTGRES_USER:-niro}"
COMPOSE_PROJECT="${COMPOSE_PROJECT:-$(basename "$(pwd)")}"
STAMP="$(date +%Y%m%d-%H%M%S)"

mkdir -p "$BACKUP_DIR"

echo "[backup] $STAMP — volcando base de datos '$POSTGRES_DB'..."
docker compose exec -T db pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --clean --if-exists \
  | gzip > "$BACKUP_DIR/db-$STAMP.sql.gz"

echo "[backup] $STAMP — respaldando adjuntos subidos (volumen niro_uploads)..."
docker run --rm \
  -v "${COMPOSE_PROJECT}_niro_uploads:/data:ro" \
  -v "$(pwd)/$BACKUP_DIR:/backup" \
  alpine sh -c "cd /data && tar czf /backup/uploads-$STAMP.tar.gz ." 2>/dev/null || \
  echo "[backup] aviso: no se pudo respaldar niro_uploads (¿el volumen no existe todavía?)"

echo "[backup] $STAMP — respaldando sesiones de WhatsApp (volumen niro_whatsapp_sessions)..."
docker run --rm \
  -v "${COMPOSE_PROJECT}_niro_whatsapp_sessions:/data:ro" \
  -v "$(pwd)/$BACKUP_DIR:/backup" \
  alpine sh -c "cd /data && tar czf /backup/whatsapp-sessions-$STAMP.tar.gz ." 2>/dev/null || \
  echo "[backup] aviso: no se pudo respaldar niro_whatsapp_sessions (¿el volumen no existe todavía?)"

echo "[backup] limpiando respaldos con más de $BACKUP_KEEP copias de antigüedad..."
for prefix in db uploads whatsapp-sessions; do
  ls -1t "$BACKUP_DIR"/"$prefix"-*.* 2>/dev/null | tail -n +"$((BACKUP_KEEP + 1))" | while IFS= read -r old; do
    rm -f -- "$old"
    echo "[backup] borrado respaldo viejo: $old"
  done
done

echo "[backup] $STAMP — listo. Archivos en $BACKUP_DIR/"
