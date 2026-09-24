#!/bin/sh
# Despliega NiroBot (db + api + web) y publica niro.com.py (principal, www → apex) y nirobot.cnid.com.py vía Traefik de Dokploy.
set -e
cd /root/nirobot/niro-enterprise-inicial
git pull -q --ff-only || true
docker compose -p nirobot -f docker-compose.dokploy.yml -f docker-compose.server.yml up -d --build
cat > /etc/dokploy/traefik/dynamic/nirobot.yml <<'YML'
http:
  routers:
    nirobot-router:
      rule: Host(`nirobot.cnid.com.py`)
      service: nirobot-service
      middlewares:
        - redirect-to-https
      entryPoints:
        - web
    nirobot-router-websecure:
      rule: Host(`nirobot.cnid.com.py`)
      service: nirobot-service
      middlewares: []
      entryPoints:
        - websecure
      tls:
        certResolver: letsencrypt
    niro-com-py-router:
      rule: Host(`niro.com.py`)
      service: nirobot-service
      priority: 1000
      middlewares:
        - redirect-to-https
      entryPoints:
        - web
    niro-com-py-router-websecure:
      rule: Host(`niro.com.py`)
      service: nirobot-service
      priority: 1000
      middlewares: []
      entryPoints:
        - websecure
      tls:
        certResolver: letsencrypt
    niro-www-router:
      rule: Host(`www.niro.com.py`)
      service: nirobot-service
      priority: 1000
      middlewares:
        - niro-www-redirect
      entryPoints:
        - web
    niro-www-router-websecure:
      rule: Host(`www.niro.com.py`)
      service: nirobot-service
      priority: 1000
      middlewares:
        - niro-www-redirect
      entryPoints:
        - websecure
      tls:
        certResolver: letsencrypt
  middlewares:
    niro-www-redirect:
      redirectRegex:
        regex: "^https?://www\\.niro\\.com\\.py/(.*)"
        replacement: "https://niro.com.py/${1}"
        permanent: true
  services:
    nirobot-service:
      loadBalancer:
        servers:
          - url: http://nirobot-web:80
        passHostHeader: true
YML
echo "Esperando que levante la API..."
for i in $(seq 1 40); do
  code=$(curl -s -o /dev/null -w '%{http_code}' https://niro.com.py/health --resolve niro.com.py:443:127.0.0.1 || true)
  [ "$code" = 200 ] && break; sleep 3
done
docker compose -p nirobot ps
echo "health: $code"
