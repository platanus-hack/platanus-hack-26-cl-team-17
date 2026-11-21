# Imagen del puente Zello (tools/zello-bridge) para un worker pool de Cloud Run.
#
# No es la app web: es un proceso sin HTTP que mantiene abierta la conexión con Zello
# y le habla a Vigía por HTTPS con su token (VIGIA_BRIDGE_TOKEN). Corre en UNA sola
# instancia: Zello admite una conexión por cuenta. La construye y despliega
# deploy/zello-bridge.sh; la configuración llega por variables y secretos.

ARG NODE_IMAGE=node:24-slim
FROM ${NODE_IMAGE}
WORKDIR /app
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    NEXT_TELEMETRY_DISABLED=1 \
    npm_config_update_notifier=false

# ffmpeg con libopus: la voz de Vigía (PCM 16 kHz de ElevenLabs → Opus de 60 ms).
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
 && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
# Incluye devDependencies: el puente corre con tsx.
RUN npm ci --no-audit --no-fund

# tsconfig.json da el alias @/ → src/ que resuelve tsx.
COPY tsconfig.json ./
COPY src ./src
COPY tools/zello-bridge ./tools/zello-bridge

USER node
# La URL de Vigía sale de VIGIA_URL; las opciones extra (--listen-only, --incident) van
# como args del worker pool.
ENTRYPOINT ["node", "--import", "tsx", "tools/zello-bridge/main.mts"]
