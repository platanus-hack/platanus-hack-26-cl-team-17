# Imagen de Vigía para Google Cloud Run.
# Etapas: deps (npm ci) → build (next build, salida standalone) → runner (node + ffmpeg).
#
# Las variables NEXT_PUBLIC_* se incrustan en el JavaScript del navegador durante
# `next build`, por eso entran como build args (deploy/cloudrun.sh las pasa vía
# Cloud Build). El resto de la configuración se lee en tiempo de ejecución
# (variables de entorno y secretos de Cloud Run).
#
# Construir a mano:
#   docker build -t vigia \
#     --build-arg NEXT_PUBLIC_APP_URL=https://vigia.ejemplo.cl .

ARG NODE_IMAGE=node:24-slim

# ---------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS deps
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1 \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    npm_config_update_notifier=false
COPY package.json package-lock.json ./
# Incluye devDependencies: next build las necesita (TypeScript, Tailwind).
RUN npm ci --no-audit --no-fund

# ---------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS build
WORKDIR /app
ARG NEXT_PUBLIC_APP_URL=""
ARG NEXT_PUBLIC_MAP_STYLE_DARK=""
ARG NEXT_PUBLIC_MAP_STYLE_LIGHT=""
ENV NEXT_TELEMETRY_DISABLED=1 \
    NODE_ENV=production \
    NEXT_PUBLIC_APP_URL=${NEXT_PUBLIC_APP_URL} \
    NEXT_PUBLIC_MAP_STYLE_DARK=${NEXT_PUBLIC_MAP_STYLE_DARK} \
    NEXT_PUBLIC_MAP_STYLE_LIGHT=${NEXT_PUBLIC_MAP_STYLE_LIGHT}
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

# ---------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS runner
WORKDIR /app

# ffmpeg: extracción de fotogramas en el servidor cuando un medio llega sin cuadros.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# TZ: Vigía cita horas con la hora local del proceso (formatClock); sin esto las dice en UTC.
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=8080 \
    HOSTNAME=0.0.0.0 \
    FFMPEG_PATH=/usr/bin/ffmpeg \
    TZ=America/Santiago

# Usuario sin privilegios (el usuario "node", uid 1000, ya viene en la imagen base).
# .data solo se usa en modo local sin DATABASE_URL/GCS_BUCKET (disco efímero en Cloud Run).
RUN mkdir -p /app/.data && chown node:node /app/.data

# .next debe ser escribible por el proceso (caché de Next en tiempo de ejecución).
COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static ./.next/static
COPY --from=build /app/public ./public
# Las migraciones se leen desde process.cwd()/db/migrations: db/ va junto a server.js.
COPY --from=build /app/db ./db

USER node
EXPOSE 8080
CMD ["node", "server.js"]
