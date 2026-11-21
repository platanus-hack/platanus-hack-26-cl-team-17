#!/usr/bin/env bash
# Puente Zello de Vigía en la nube: un worker pool de Cloud Run con UNA instancia.
#
# El puente (tools/zello-bridge) no atiende HTTP: mantiene abierta la conexión con Zello,
# registra cada transmisión en la bitácora de Vigía y dice en el canal lo que Vigía
# tiene que decir. Un worker pool es justo eso: instancias fijas sin tráfico entrante.
# Zello admite UNA conexión por cuenta: mientras este puente corre, no corras otro con
# la misma cuenta (en un notebook o la Jetson), o se expulsan el uno al otro.
#
# ESTE SCRIPT CREA RECURSOS QUE COBRAN DINERO (una instancia siempre encendida).
# Pide confirmación salvo que pases CONFIRM=1. Es idempotente y nunca imprime secretos.
#
# Requisitos: haber desplegado la app con deploy/cloudrun.sh (crea la cuenta de servicio,
# el repositorio de imágenes y el secreto vigia-bridge-token).
#
# Uso (desde cualquier carpeta):
#   ENV_FILE=.env.local bash deploy/zello-bridge.sh   # toma ZELLO_*, ELEVENLABS_* de ese archivo
#   LISTEN_ONLY=1 ENV_FILE=.env.local bash deploy/zello-bridge.sh   # solo escucha, Vigía no habla
#   INSTANCES=0 SKIP_BUILD=1 bash deploy/zello-bridge.sh            # apaga el puente (no cobra)
set -euo pipefail

# ---------------------------------------------------------------------------
# Parámetros
# ---------------------------------------------------------------------------
PROJECT="${PROJECT:-platanus-515411}"
REGION="${REGION:-southamerica-west1}"
POOL="${POOL:-vigia-zello}"
SERVICE="${SERVICE:-vigia}"        # servicio de la app (para la URL por defecto)
AR_REPO="${AR_REPO:-vigia}"
SA_NAME="${SA_NAME:-vigia-run}"
CPU="${CPU:-1}"
MEMORY="${MEMORY:-1Gi}"
# 1 = encendido; 0 = apagado sin borrar nada. Nunca más de 1 (una conexión por cuenta).
INSTANCES="${INSTANCES:-1}"
LISTEN_ONLY="${LISTEN_ONLY:-0}"
# Código o id de una emergencia: el puente registra solo en esa. Vacío = todas las abiertas.
PIN_INCIDENT="${PIN_INCIDENT:-}"
IMAGE="${IMAGE:-}"
SKIP_BUILD="${SKIP_BUILD:-0}"
CONFIRM="${CONFIRM:-0}"
# Archivo .env del que se leen las variables que no estén en el entorno (p. ej. .env.local).
ENV_FILE="${ENV_FILE:-}"

SECRET_BRIDGE="${SECRET_BRIDGE:-vigia-bridge-token}"
SECRET_ZELLO_PASSWORD="${SECRET_ZELLO_PASSWORD:-zello-password}"
SECRET_ZELLO_KEY="${SECRET_ZELLO_KEY:-zello-private-key}"
SECRET_ELEVENLABS="${SECRET_ELEVENLABS:-elevenlabs-api-key}"

# ---------------------------------------------------------------------------
# Utilidades
# ---------------------------------------------------------------------------
info() { printf '\n\033[1;34m==>\033[0m %s\n' "$*"; }
ok() { printf '    \033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '\n\033[1;33m[AVISO]\033[0m %s\n' "$*" >&2; }
die() { printf '\n\033[1;31m[ERROR]\033[0m %s\n' "$*" >&2; exit 1; }
gc() { gcloud --project="$PROJECT" --quiet "$@"; }

yaml_quote() {
  local s="$1" dollar="${2:-0}"
  s="${s//\'/\'\'}"
  if [[ "$dollar" == "1" ]]; then s="${s//\$/\$\$}"; fi
  printf "'%s'" "$s"
}

secret_exists() { gc secrets describe "$1" >/dev/null 2>&1; }
secret_has_version() {
  local v
  v="$(gc secrets versions list "$1" --filter='state=ENABLED' --limit=1 --format='value(name)' 2>/dev/null || true)"
  [[ -n "$v" ]]
}
ensure_secret() {
  secret_exists "$1" && return 0
  gc secrets create "$1" --replication-policy=automatic >/dev/null
  ok "Secreto $1 creado (sin valor todavía)"
}
# Primera versión por stdin (el valor no queda en argv ni se imprime).
add_secret_version() {
  printf '%s' "$2" | gc secrets versions add "$1" --data-file=- >/dev/null
  ok "Secreto $1: primera versión guardada"
}
grant_secret_access() {
  gc secrets add-iam-policy-binding "$1" \
    --member="serviceAccount:${SA_EMAIL}" --role=roles/secretmanager.secretAccessor \
    --condition=None >/dev/null
}

# Valor de una variable: primero el entorno, luego ENV_FILE (lo lee Node, igual que el
# puente en local). No imprime nada.
from_env_file() {
  [[ -n "$ENV_FILE" ]] || return 0
  node --env-file="$ENV_FILE" -e 'process.stdout.write(process.env[process.argv[1]] ?? "")' "$1"
}
load() {
  local name="$1"
  if [[ -z "${!name:-}" ]]; then
    printf -v "$name" '%s' "$(from_env_file "$name")"
  fi
}

# Secreto obligatorio u opcional: lo crea, carga la primera versión si hay valor y no lo
# sobrescribe si ya tiene. Devuelve 0 si queda con valor.
provision_secret() {
  local secret="$1" value="$2"
  ensure_secret "$secret"
  if secret_has_version "$secret"; then
    ok "$secret ya tiene valor (se conserva)"
  elif [[ -n "$value" ]]; then
    add_secret_version "$secret" "$value"
  else
    return 1
  fi
  grant_secret_access "$secret"
}

# ---------------------------------------------------------------------------
# Comprobaciones y configuración
# ---------------------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
command -v gcloud >/dev/null 2>&1 || die "No encontré gcloud."
[[ "$INSTANCES" == "0" || "$INSTANCES" == "1" ]] || die "INSTANCES debe ser 0 o 1: Zello admite una sola conexión por cuenta."
if [[ -n "$ENV_FILE" ]]; then
  [[ "$ENV_FILE" = /* ]] || ENV_FILE="$PWD/$ENV_FILE"
  [[ -f "$ENV_FILE" ]] || die "No existe ENV_FILE=$ENV_FILE."
  command -v node >/dev/null 2>&1 || die "ENV_FILE necesita node (≥ 20) para leer el archivo."
fi

for v in ZELLO_USERNAME ZELLO_PASSWORD ZELLO_ISSUER ZELLO_PRIVATE_KEY ZELLO_CHANNEL ZELLO_OBAC_USERNAME \
  ZELLO_WS_URL ELEVENLABS_API_KEY ELEVENLABS_VOICE_ID VIGIA_STT_MODEL VIGIA_TTS_MODEL; do
  load "$v"
done
# VIGIA_URL NO se lee de ENV_FILE: en un .env.local suele apuntar a localhost.
VIGIA_URL="${VIGIA_URL:-}"

ACCOUNT="$(gcloud auth list --filter=status:ACTIVE --format='value(account)' 2>/dev/null | head -n1 || true)"
[[ -n "$ACCOUNT" ]] || die "No hay una cuenta activa en gcloud. Corre: gcloud auth login"
PROJECT_NUMBER="$(gc projects describe "$PROJECT" --format='value(projectNumber)' 2>/dev/null || true)"
[[ -n "$PROJECT_NUMBER" ]] || die "No pude leer el proyecto $PROJECT con la cuenta $ACCOUNT."
SA_EMAIL="${SA_NAME}@${PROJECT}.iam.gserviceaccount.com"
AR_HOST="${REGION}-docker.pkg.dev"
VIGIA_URL="${VIGIA_URL:-https://${SERVICE}-${PROJECT_NUMBER}.${REGION}.run.app}"
VIGIA_URL="${VIGIA_URL%/}"

if [[ "$INSTANCES" == "1" ]]; then
  [[ -n "$ZELLO_USERNAME" ]] || die "Falta ZELLO_USERNAME (usuario de Zello del bot). Pásalo o usa ENV_FILE=.env.local."
  [[ -n "$ZELLO_ISSUER" ]] || die "Falta ZELLO_ISSUER (developers.zello.com)."
fi

ARGS="--channel=${ZELLO_CHANNEL:-demo-platanus}"
[[ "$LISTEN_ONLY" == "1" ]] && ARGS+=",--listen-only"
[[ -n "$PIN_INCIDENT" ]] && ARGS+=",--incident=${PIN_INCIDENT}"

cat <<EOF

Puente Zello → Cloud Run (worker pool). Esto es lo que se va a usar o crear:
  Cuenta gcloud        $ACCOUNT
  Proyecto / región    $PROJECT / $REGION
  Worker pool          $POOL  (instancias=$INSTANCES cpu=$CPU mem=$MEMORY)
  Vigía                $VIGIA_URL
  Zello                ${ZELLO_USERNAME:-?} en el canal «${ZELLO_CHANNEL:-demo-platanus}»$([[ "$LISTEN_ONLY" == "1" ]] && echo " · solo escucha")$([[ -n "$PIN_INCIDENT" ]] && echo " · solo $PIN_INCIDENT")
  Secretos             $SECRET_BRIDGE, $SECRET_ZELLO_PASSWORD, $SECRET_ZELLO_KEY, $SECRET_ELEVENLABS
  Imagen               ${IMAGE:-$([[ "$SKIP_BUILD" == "1" ]] && echo "la del último despliegue" || echo "se construye con Cloud Build")}

Costo: una instancia siempre encendida mientras INSTANCES=1 (del orden de US\$2 al día con
cpu=1 y 1 GiB; confírmalo en https://cloud.google.com/products/calculator).
Mientras corra, NO corras otro puente con la cuenta ${ZELLO_USERNAME:-del bot}.
EOF

if [[ "$CONFIRM" != "1" ]]; then
  if [[ -t 0 ]]; then
    read -r -p $'\nEscribe "si" para continuar: ' answer
    [[ "$answer" == "si" || "$answer" == "sí" ]] || die "Cancelado. No se tocó nada."
  else
    die "Sin terminal interactiva: confirma con CONFIRM=1."
  fi
fi

WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT

# ---------------------------------------------------------------------------
# Apagar: solo se baja a 0 instancias (no cobra y se puede volver a encender).
# ---------------------------------------------------------------------------
if [[ "$INSTANCES" == "0" ]]; then
  info "Apagando $POOL"
  gc run worker-pools update "$POOL" --region="$REGION" --instances=0 >/dev/null
  ok "$POOL quedó en 0 instancias. Para encenderlo: INSTANCES=1 SKIP_BUILD=1 bash deploy/zello-bridge.sh"
  exit 0
fi

# ---------------------------------------------------------------------------
# Secretos
# ---------------------------------------------------------------------------
info "Secretos"
gc iam service-accounts describe "$SA_EMAIL" >/dev/null 2>&1 || die "No existe la cuenta de servicio $SA_EMAIL. Despliega primero la app con deploy/cloudrun.sh."
secret_has_version "$SECRET_BRIDGE" || die "El secreto $SECRET_BRIDGE no tiene valor. Corre deploy/cloudrun.sh (sin SKIP_INFRA) para crearlo."
grant_secret_access "$SECRET_BRIDGE"
ok "$SECRET_BRIDGE listo (el mismo token que monta la app)"
provision_secret "$SECRET_ZELLO_PASSWORD" "$ZELLO_PASSWORD" || die "Falta ZELLO_PASSWORD para el secreto $SECRET_ZELLO_PASSWORD."
provision_secret "$SECRET_ZELLO_KEY" "$ZELLO_PRIVATE_KEY" || die "Falta ZELLO_PRIVATE_KEY (PEM de developers.zello.com) para el secreto $SECRET_ZELLO_KEY."
SECRETS="VIGIA_BRIDGE_TOKEN=${SECRET_BRIDGE}:latest,ZELLO_PASSWORD=${SECRET_ZELLO_PASSWORD}:latest,ZELLO_PRIVATE_KEY=${SECRET_ZELLO_KEY}:latest"
if provision_secret "$SECRET_ELEVENLABS" "$ELEVENLABS_API_KEY"; then
  SECRETS+=",ELEVENLABS_API_KEY=${SECRET_ELEVENLABS}:latest"
else
  warn "Sin ELEVENLABS_API_KEY: el puente solo escucha, las transmisiones quedan «sin transcribir» y Vigía no habla."
fi

# ---------------------------------------------------------------------------
# Imagen
# ---------------------------------------------------------------------------
if [[ -z "$IMAGE" && "$SKIP_BUILD" == "1" ]]; then
  IMAGE="$(gc run worker-pools describe "$POOL" --region="$REGION" --format='value(spec.template.spec.containers[0].image)' 2>/dev/null || true)"
  [[ -n "$IMAGE" ]] || die "SKIP_BUILD=1 pero $POOL no existe todavía: corre sin SKIP_BUILD."
  ok "Se usa la imagen del último despliegue: $IMAGE"
elif [[ -z "$IMAGE" ]]; then
  info "Construyendo la imagen del puente con Cloud Build"
  tag="$(date -u +%Y%m%d-%H%M%S)"
  if git -C "$APP_DIR" rev-parse --short HEAD >/dev/null 2>&1; then
    tag+="-$(git -C "$APP_DIR" rev-parse --short HEAD)"
  fi
  IMAGE="${AR_HOST}/${PROJECT}/${AR_REPO}/zello-bridge:${tag}"
  cat >"$WORK_DIR/cloudbuild.yaml" <<EOF
steps:
  - name: gcr.io/cloud-builders/docker
    env: ['DOCKER_BUILDKIT=1']
    args: ['build', '-f', 'deploy/zello-bridge.Dockerfile', '--tag', $(yaml_quote "$IMAGE" 1), '.']
images:
  - $(yaml_quote "$IMAGE" 1)
options:
  machineType: E2_HIGHCPU_8
timeout: 1200s
EOF
  gc builds submit "$APP_DIR" --region=global --config="$WORK_DIR/cloudbuild.yaml" --ignore-file="$APP_DIR/.dockerignore"
  ok "Imagen $IMAGE"
else
  ok "Se usa la imagen dada: $IMAGE"
fi

# ---------------------------------------------------------------------------
# Worker pool
# ---------------------------------------------------------------------------
info "Desplegando el worker pool $POOL"
{
  printf 'VIGIA_URL: %s\n' "$(yaml_quote "$VIGIA_URL")"
  printf 'ZELLO_USERNAME: %s\n' "$(yaml_quote "$ZELLO_USERNAME")"
  printf 'ZELLO_ISSUER: %s\n' "$(yaml_quote "$ZELLO_ISSUER")"
  printf 'ZELLO_CHANNEL: %s\n' "$(yaml_quote "${ZELLO_CHANNEL:-demo-platanus}")"
  [[ -n "$ZELLO_OBAC_USERNAME" ]] && printf 'ZELLO_OBAC_USERNAME: %s\n' "$(yaml_quote "$ZELLO_OBAC_USERNAME")"
  [[ -n "$ZELLO_WS_URL" ]] && printf 'ZELLO_WS_URL: %s\n' "$(yaml_quote "$ZELLO_WS_URL")"
  [[ -n "$ELEVENLABS_VOICE_ID" ]] && printf 'ELEVENLABS_VOICE_ID: %s\n' "$(yaml_quote "$ELEVENLABS_VOICE_ID")"
  [[ -n "$VIGIA_STT_MODEL" ]] && printf 'VIGIA_STT_MODEL: %s\n' "$(yaml_quote "$VIGIA_STT_MODEL")"
  [[ -n "$VIGIA_TTS_MODEL" ]] && printf 'VIGIA_TTS_MODEL: %s\n' "$(yaml_quote "$VIGIA_TTS_MODEL")"
  true
} >"$WORK_DIR/env.yaml"

gc run worker-pools deploy "$POOL" \
  --region="$REGION" \
  --image="$IMAGE" \
  --service-account="$SA_EMAIL" \
  --instances=1 \
  --cpu="$CPU" \
  --memory="$MEMORY" \
  --args="$ARGS" \
  --env-vars-file="$WORK_DIR/env.yaml" \
  --set-secrets="$SECRETS"

info "Listo"
cat <<EOF
  Worker pool        $POOL (1 instancia, $REGION)
  Vigía              $VIGIA_URL
  Imagen             $IMAGE

  Ver lo que hace:   gcloud logging read 'resource.type="cloud_run_worker_pool" AND resource.labels.worker_pool_name="$POOL"' --project=$PROJECT --limit=50 --format='value(textPayload)'
  Estado en la mesa: el panel de radio de cualquier emergencia muestra «Zello: conectado».
  Apagarlo:          INSTANCES=0 bash deploy/zello-bridge.sh   (no cobra; se enciende con INSTANCES=1 SKIP_BUILD=1)
EOF
