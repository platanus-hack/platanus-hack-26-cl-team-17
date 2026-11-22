#!/usr/bin/env bash
# Detector YOLO de Vigía (vigia/detector) como servicio PRIVADO de Cloud Run.
#
# Con él, el video en vivo del dron dibuja las cajas (personas, humo, fuego…) también en la
# nube, y el análisis de videos de vecinos usa YOLO antes que Claude. El servicio exige IAM:
# solo la cuenta de la app (vigia-run) puede llamarlo, con token de identidad
# (VIGIA_DETECTOR_AUTH=gcp en la app).
#
# ESTE SCRIPT CREA RECURSOS QUE COBRAN DINERO (solo mientras atiende cuadros con MIN_INSTANCES=0).
# Pide confirmación salvo que pases CONFIRM=1. Es idempotente.
#
# Requisitos: haber desplegado la app con deploy/cloudrun.sh (cuenta de servicio y repositorio
# de imágenes) y tener los ONNX exportados en detector/models/ (ver detector/README.md).
#
# Uso (desde cualquier carpeta):
#   bash deploy/detector.sh                         # construye, despliega y conecta la app
#   SKIP_BUILD=1 bash deploy/detector.sh            # redespliega la última imagen (p. ej. otros recursos)
#   CPU=4 MEMORY=2Gi bash deploy/detector.sh        # menos CPU = más barato, YOLO más lento por cuadro
#   MIN_INSTANCES=1 SKIP_BUILD=1 bash deploy/detector.sh   # una instancia siempre lista (sin arranque en frío)
#   CONNECT_APP=0 bash deploy/detector.sh           # no toca el servicio de la app
#
# Conectar la app = `gcloud run services update vigia --update-env-vars` (nueva revisión con la
# MISMA imagen). deploy/cloudrun.sh también encuentra este servicio solo en cada despliegue.
set -euo pipefail

# ---------------------------------------------------------------------------
# Parámetros
# ---------------------------------------------------------------------------
PROJECT="${PROJECT:-platanus-515411}"
REGION="${REGION:-southamerica-west1}"
DETECTOR_SERVICE="${DETECTOR_SERVICE:-vigia-detector}"
APP_SERVICE="${APP_SERVICE:-vigia}"
AR_REPO="${AR_REPO:-vigia}"
SA_NAME="${SA_NAME:-vigia-run}"
# Un cuadro de 640 px con personas tarda ~120 ms en 4 núcleos de un notebook; en Cloud Run algo más.
# 8 vCPU es el máximo de Cloud Run sin GPU y exige al menos 4 GiB.
CPU="${CPU:-8}"
MEMORY="${MEMORY:-4Gi}"
# 0 = se apaga sin tráfico: el primer cuadro tras un rato sin uso espera el arranque en frío
# (mientras tanto la app sigue sin cajas, con Claude con visión). 1 = siempre lista.
MIN_INSTANCES="${MIN_INSTANCES:-0}"
MAX_INSTANCES="${MAX_INSTANCES:-2}"
# Las inferencias se serializan dentro de la instancia: pocas peticiones a la vez por instancia.
CONCURRENCY="${CONCURRENCY:-4}"
THREADS="${THREADS:-$CPU}"
CONNECT_APP="${CONNECT_APP:-1}"
IMAGE="${IMAGE:-}"
SKIP_BUILD="${SKIP_BUILD:-0}"
CONFIRM="${CONFIRM:-0}"

info() { printf '\n\033[1;34m==>\033[0m %s\n' "$*"; }
ok() { printf '    \033[32m✓\033[0m %s\n' "$*"; }
die() { printf '\n\033[1;31m[ERROR]\033[0m %s\n' "$*" >&2; exit 1; }
gc() { gcloud --project="$PROJECT" --quiet "$@"; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DETECTOR_DIR="$(cd "$SCRIPT_DIR/../detector" && pwd)"

command -v gcloud >/dev/null 2>&1 || die "No encontré gcloud."
if [[ "$SKIP_BUILD" != "1" && -z "$IMAGE" ]]; then
  for f in vigia-yoloe-26s.onnx vigia-yoloe-26s.json yolo26n-pose.onnx yolo26n-pose.json; do
    [[ -f "$DETECTOR_DIR/models/$f" ]] || die "Falta detector/models/$f. Expórtalo primero (detector/README.md)."
  done
fi

ACCOUNT="$(gcloud auth list --filter=status:ACTIVE --format='value(account)' 2>/dev/null | head -n1 || true)"
[[ -n "$ACCOUNT" ]] || die "No hay una cuenta activa en gcloud. Corre: gcloud auth login"
SA_EMAIL="${SA_NAME}@${PROJECT}.iam.gserviceaccount.com"
gc iam service-accounts describe "$SA_EMAIL" >/dev/null 2>&1 || die "No existe $SA_EMAIL: despliega la app primero (deploy/cloudrun.sh)."
AR_HOST="${REGION}-docker.pkg.dev"

if [[ -z "$IMAGE" && "$SKIP_BUILD" == "1" ]]; then
  IMAGE="$(gc run services describe "$DETECTOR_SERVICE" --region="$REGION" \
    --format='value(spec.template.spec.containers[0].image)' 2>/dev/null || true)"
  [[ -n "$IMAGE" ]] || die "SKIP_BUILD=1 pero $DETECTOR_SERVICE no está desplegado: corre sin SKIP_BUILD."
fi

cat <<EOF

Detector YOLO → Cloud Run (privado). Esto es lo que se va a usar o crear:
  Cuenta gcloud        $ACCOUNT
  Proyecto / región    $PROJECT / $REGION
  Servicio             $DETECTOR_SERVICE  (cpu=$CPU mem=$MEMORY min=$MIN_INSTANCES max=$MAX_INSTANCES concurrencia=$CONCURRENCY hilos=$THREADS)
  Acceso               solo $SA_EMAIL (roles/run.invoker)
  Imagen               ${IMAGE:-se construye con Cloud Build desde detector/}
  App                  $([[ "$CONNECT_APP" == "1" ]] && echo "$APP_SERVICE recibe VIGIA_DETECTOR_URL y VIGIA_DETECTOR_AUTH=gcp (misma imagen)" || echo "no se toca")

Costo: $([[ "$MIN_INSTANCES" == "0" ]] && echo "sin tráfico se apaga y no cobra CPU; cobra mientras atiende cuadros" || echo "con MIN_INSTANCES=$MIN_INSTANCES queda una instancia lista (cobra en reposo a tarifa reducida)").
Confírmalo en https://cloud.google.com/products/calculator
EOF

if [[ "$CONFIRM" != "1" ]]; then
  if [[ -t 0 ]]; then
    read -r -p $'\nEscribe "si" para continuar: ' answer
    [[ "$answer" == "si" || "$answer" == "sí" ]] || die "Cancelado. No se tocó nada."
  else
    die "Sin terminal interactiva: confirma con CONFIRM=1."
  fi
fi

if [[ -z "$IMAGE" ]]; then
  info "Construyendo la imagen con Cloud Build"
  IMAGE="${AR_HOST}/${PROJECT}/${AR_REPO}/${DETECTOR_SERVICE}:$(date -u +%Y%m%d-%H%M%S)"
  gc builds submit "$DETECTOR_DIR" --region=global --tag="$IMAGE" --ignore-file="$DETECTOR_DIR/.gcloudignore"
  ok "Imagen $IMAGE"
fi

info "Desplegando $DETECTOR_SERVICE"
gc run deploy "$DETECTOR_SERVICE" \
  --region="$REGION" \
  --image="$IMAGE" \
  --service-account="$SA_EMAIL" \
  --cpu="$CPU" \
  --memory="$MEMORY" \
  --min-instances="$MIN_INSTANCES" \
  --max-instances="$MAX_INSTANCES" \
  --concurrency="$CONCURRENCY" \
  --cpu-boost \
  --timeout=60 \
  --port=8080 \
  --no-allow-unauthenticated \
  --set-env-vars="VIGIA_DETECTOR_THREADS=${THREADS}"

gc run services add-iam-policy-binding "$DETECTOR_SERVICE" --region="$REGION" \
  --member="serviceAccount:${SA_EMAIL}" --role=roles/run.invoker >/dev/null
ok "roles/run.invoker para $SA_EMAIL"

DETECTOR_URL="$(gc run services describe "$DETECTOR_SERVICE" --region="$REGION" --format='value(status.url)')"
[[ -n "$DETECTOR_URL" ]] || die "No pude leer la URL de $DETECTOR_SERVICE."
ok "Detector en $DETECTOR_URL"

if [[ "$CONNECT_APP" == "1" ]]; then
  info "Conectando $APP_SERVICE al detector"
  gc run services update "$APP_SERVICE" --region="$REGION" \
    --update-env-vars="VIGIA_DETECTOR_URL=${DETECTOR_URL},VIGIA_DETECTOR_AUTH=gcp"
  ok "$APP_SERVICE usa el detector (nueva revisión, misma imagen)"
fi

cat <<EOF

Probar (con tu cuenta, que debe tener roles/run.invoker o ser dueña del proyecto):
  curl -s -H "Authorization: Bearer \$(gcloud auth print-identity-token)" $DETECTOR_URL/health
EOF
