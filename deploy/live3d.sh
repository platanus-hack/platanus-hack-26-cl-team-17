#!/usr/bin/env bash
# Reconstrucción 3D en vivo (gpu/splat/LIVE3D.md) como servicio PRIVADO de Cloud Run con GPU.
#
# Recibe los cuadros del video en vivo del dron (los reenvía la app) y arma la nube de puntos
# con VGGT mientras el dron vuela. Solo la cuenta de la app (vigia-run) puede llamarlo, con token
# de identidad (VIGIA_LIVE3D_AUTH=gcp en la app).
#
# ESTE SCRIPT CREA RECURSOS QUE COBRAN DINERO: una L4 mientras haya una instancia viva. Con
# MIN_INSTANCES=0 (por defecto) se apaga sola sin tráfico; para la demo, MIN_INSTANCES=1 la deja
# encendida (sin los ~2–3 min de arranque en frío) y cobra todo el rato: vuelve a 0 después.
# Pide confirmación salvo que pases CONFIRM=1. Es idempotente.
#
# Uso:
#   bash deploy/live3d.sh                                  # construye sobre vigia-splat:latest y despliega
#   SKIP_BUILD=1 bash deploy/live3d.sh                     # redespliega la última imagen
#   MIN_INSTANCES=1 SKIP_BUILD=1 CONFIRM=1 bash deploy/live3d.sh   # encendida para la demo
#   MIN_INSTANCES=0 SKIP_BUILD=1 CONFIRM=1 bash deploy/live3d.sh   # después de la demo
#   CONNECT_APP=1 bash deploy/live3d.sh                    # además conecta la app (nueva revisión, misma imagen)
set -euo pipefail

PROJECT="${PROJECT:-platanus-515411}"
REGION="${REGION:-europe-west1}"           # donde hay cuota de L4 (ver deploy/SPLAT.md)
SERVICE="${SERVICE:-vigia-live3d}"
AR_REPO="${AR_REPO:-vigia}"
BASE_IMAGE="${BASE_IMAGE:-${REGION}-docker.pkg.dev/${PROJECT}/${AR_REPO}/vigia-splat:latest}"
RUN_SA="${RUN_SA:-vigia-splat}"            # sin permisos extra: el servicio no toca el storage
APP_SA="${APP_SA:-vigia-run}"
APP_SERVICE="${APP_SERVICE:-vigia}"
APP_REGION="${APP_REGION:-southamerica-west1}"
GPU_TYPE="${GPU_TYPE:-nvidia-l4}"
CPU="${CPU:-8}"
MEMORY="${MEMORY:-32Gi}"
MIN_INSTANCES="${MIN_INSTANCES:-0}"
CONNECT_APP="${CONNECT_APP:-0}"
SKIP_BUILD="${SKIP_BUILD:-0}"
CONFIRM="${CONFIRM:-0}"
BUILD_REGION="${BUILD_REGION:-global}"
BUILD_MACHINE="${BUILD_MACHINE:-E2_HIGHCPU_8}"
BUILD_DISK_GB="${BUILD_DISK_GB:-100}"

info() { printf '\n\033[1;34m==>\033[0m %s\n' "$*"; }
ok() { printf '    \033[32m✓\033[0m %s\n' "$*"; }
die() { printf '\n\033[1;31m[ERROR]\033[0m %s\n' "$*" >&2; exit 1; }
gc() { gcloud --project="$PROJECT" --quiet "$@"; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC_DIR="$(cd "$SCRIPT_DIR/../gpu/splat" && pwd)"
IMAGE_BASE="${REGION}-docker.pkg.dev/${PROJECT}/${AR_REPO}/${SERVICE}"
RUN_SA_EMAIL="${RUN_SA}@${PROJECT}.iam.gserviceaccount.com"
APP_SA_EMAIL="${APP_SA}@${PROJECT}.iam.gserviceaccount.com"

command -v gcloud >/dev/null 2>&1 || die "No encontré gcloud."

cat <<EOF

Reconstrucción 3D en vivo → Cloud Run (privado, con GPU):
  Proyecto / región   $PROJECT / $REGION
  Servicio            $SERVICE (1 × $GPU_TYPE, $CPU vCPU, $MEMORY, máx. 1 instancia, mín. $MIN_INSTANCES)
  Imagen base         $BASE_IMAGE
  Acceso              solo $APP_SA_EMAIL (roles/run.invoker)
  Conectar la app     $([[ "$CONNECT_APP" == "1" ]] && echo "sí ($APP_SERVICE en $APP_REGION)" || echo no)
EOF
if [[ "$CONFIRM" != "1" ]]; then
  read -r -p $'\nEsto cobra mientras haya una instancia con GPU encendida. ¿Seguir? (si/no) ' ans
  [[ "$ans" == "si" || "$ans" == "sí" ]] || die "Cancelado."
fi

if [[ "$SKIP_BUILD" == "1" ]]; then
  IMAGE="${IMAGE:-${IMAGE_BASE}:latest}"
  ok "Se usa la imagen $IMAGE"
else
  info "Construyendo la imagen (capa delgada sobre vigia-splat; baja la base, sube solo el código)"
  tag="$(date -u +%Y%m%d-%H%M%S)"
  IMAGE="${IMAGE_BASE}:${tag}"
  WORK_DIR="$(mktemp -d)"
  trap 'rm -rf "$WORK_DIR"' EXIT
  cat >"$WORK_DIR/cloudbuild.yaml" <<EOF
steps:
  - name: gcr.io/cloud-builders/docker
    args: ['build', '-f', 'Dockerfile.live3d', '--build-arg', 'BASE=${BASE_IMAGE}', '--tag', '${IMAGE}', '--tag', '${IMAGE_BASE}:latest', '.']
images: ['${IMAGE}', '${IMAGE_BASE}:latest']
options:
  machineType: ${BUILD_MACHINE}
  diskSizeGb: ${BUILD_DISK_GB}
timeout: 3600s
EOF
  gc builds submit "$SRC_DIR" --region="$BUILD_REGION" --config="$WORK_DIR/cloudbuild.yaml" \
    --ignore-file=.dockerignore
  ok "Imagen $IMAGE"
fi

info "Desplegando $SERVICE"
gc run deploy "$SERVICE" \
  --region="$REGION" \
  --image="$IMAGE" \
  --service-account="$RUN_SA_EMAIL" \
  --gpu=1 --gpu-type="$GPU_TYPE" --no-gpu-zonal-redundancy \
  --cpu="$CPU" --memory="$MEMORY" --no-cpu-throttling \
  --min-instances="$MIN_INSTANCES" --max-instances=1 \
  --concurrency=40 --timeout=60 --port=8080 \
  --no-allow-unauthenticated \
  --labels="app=vigia,component=live3d"
URL="$(gc run services describe "$SERVICE" --region="$REGION" --format='value(status.url)')"
ok "$URL"

gc run services add-iam-policy-binding "$SERVICE" --region="$REGION" \
  --member="serviceAccount:${APP_SA_EMAIL}" --role=roles/run.invoker >/dev/null
ok "roles/run.invoker para $APP_SA_EMAIL"

if [[ "$CONNECT_APP" == "1" ]]; then
  info "Conectando la app ($APP_SERVICE)"
  gc run services update "$APP_SERVICE" --region="$APP_REGION" \
    --update-env-vars="VIGIA_LIVE3D_URL=${URL},VIGIA_LIVE3D_AUTH=gcp" >/dev/null
  ok "VIGIA_LIVE3D_URL=$URL en $APP_SERVICE"
fi

cat <<EOF

Listo. Probar con tu cuenta:
  curl -s -H "Authorization: Bearer \$(gcloud auth print-identity-token)" $URL/health
  gpu/splat/.venv/bin/python gpu/splat/tools/live3d_replay.py --url $URL --gcp VIDEO.mp4
EOF
