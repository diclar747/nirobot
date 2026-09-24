# Imagen con Chromium ya instalado (misma versión de Playwright que package-lock.json)
# para no tener que bajar/compilar el navegador en cada build.
FROM mcr.microsoft.com/playwright:v1.63.0-noble

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY supervisor.mjs server.mjs db.mjs db-import.mjs ai-replies.mjs crm.mjs groups-explorer.mjs instagram.mjs ./
COPY public ./public

RUN mkdir -p data/images data/uploads data/browser-profile

EXPOSE 8787
# Un panel por organización de Niro (ver supervisor.mjs).
CMD ["node", "supervisor.mjs"]
