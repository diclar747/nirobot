# Etapa 1: dependencias (git hace falta solo para instalar baileys-caller desde GitHub).
FROM node:22-bookworm-slim AS deps
WORKDIR /app
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates git \
  && rm -rf /var/lib/apt/lists/*
COPY package*.json ./
COPY patches ./patches
RUN npm ci
COPY prisma ./prisma
RUN npx prisma generate

# Etapa 2: imagen final, sin git ni ffmpeg del sistema (~1 GB menos).
FROM node:22-bookworm-slim
WORKDIR /app
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates openssl \
  && rm -rf /var/lib/apt/lists/*
# ffmpeg: el binario estático de ffmpeg-static (lo usan src/lib/ffmpeg.js y baileys-caller vía FFMPEG_PATH).
ENV FFMPEG_PATH=/app/node_modules/ffmpeg-static/ffmpeg
COPY --from=deps /app/node_modules ./node_modules
COPY . .
EXPOSE 4000
CMD ["sh", "-c", "npx prisma migrate deploy && node prisma/seed.js && exec node src/server.js"]
