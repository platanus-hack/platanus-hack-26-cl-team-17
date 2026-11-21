#!/usr/bin/env bash
# Job de GPU de Vigía para la reconstrucción 3D Gaussian Splatting (Cloud Run jobs, us-central1).
#
# CREA RECURSOS QUE COBRAN DINERO (la GPU cobra solo mientras corre una ejecución).
# Lee deploy/SPLAT.md. Pide confirmación salvo que pases CONFIRM=1.
#
# Idempotente: consulta cada recurso antes de crearlo, `gcloud run jobs deploy` crea o
# actualiza, y los permisos IAM se agregan sin quitar los existentes. No borra nada.
# Fuera de us-central1 solo agrega un permiso IAM del bucket para la cuenta del job.
#
# Uso:
#   bash deploy/splat-job.sh                         # infraestructura + build + deploy + permisos
#   SKIP_BUILD=1 bash deploy/splat-job.sh            # redepliega la última imagen (:latest)
#   IMAGE=<imagen> bash deploy/splat-job.sh          # despliega esa imagen sin construir
#   GPU_TYPE=nvidia-l4 bash deploy/splat-job.sh      # si no hay cuota de RTX PRO 6000
#   RUN_MANIFEST=gs://<bucket>/<ruta>/manifest.json bash deploy/splat-job.sh run
#                                                    # ejecuta el job con ese manifiesto y espera
set -euo pipefail

PROJECT="${PROJECT:-platanus-515411}"
REGION="${REGION:-europe-west1}"
JOB="${JOB:-vigia-splat}"
AR_REPO="${AR_REPO:-vigia}"
IMAGE_NAME="${IMAGE_NAME:-vigia-splat}"
SA_NAME="${SA_NAME:-vigia-splat}"
APP_SA="${APP_SA:-vigia-run@${PROJECT}.iam.gserviceaccount.com}"
BUCKET="${BUCKET:-platanus-515411-vigia-evidencia}"
GPU_TYPE="${GPU_TYPE:-nvidia-l4}"
# Mínimos que exige cada GPU en Cloud Run (RTX PRO 6000: 20 vCPU / 80 GiB; L4: 4 / 16 GiB,
# aquí 8 / 32 GiB para tener RAM al decodificar videos).
case "$GPU_TYPE" in
  nvidia-rtx-pro-6000) DEFAULT_CPU=20 DEFAULT_MEMORY=80Gi ;;
  nvidia-l4) DEFAULT_CPU=8 DEFAULT_MEMORY=32Gi ;;
  *) DEFAULT_CPU=8 DEFAULT_MEMORY=32Gi ;;
esac
CPU="${CPU:-$DEFAULT_CPU}"
MEMORY="${MEMORY:-$DEFAULT_MEMORY}"
TASK_TIMEOUT="${TASK_TIMEOUT:-2700s}"
# Cloud Build regional (us-central1) no ofrece máquinas grandes en este proyecto: el pool global sí.
BUILD_REGION="${BUILD_REGION:-global}"
BUILD_MACHINE="${BUILD_MACHINE:-E2_HIGHCPU_32}"
BUILD_DISK_GB="${BUILD_DISK_GB:-300}"
IMAGE="${IMAGE:-}"
SKIP_BUILD="${SKIP_BUILD:-0}"
CONFIRM="${CONFIRM:-0}"
ACTION="${1:-deploy}"

info() { printf '\n\033[1;34m==>\033[0m %s\n' "$*"; }
ok() { printf '    \033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '\n\033[1;33m[AVISO]\033[0m %s\n' "$*" >&2; }
die() { printf '\n\033[1;31m[ERROR]\033[0m %s\n' "$*" >&2; exit 1; }

# Siempre con --project explícito: no depende del proyecto activo de gcloud.
gc() { gcloud --project="$PROJECT" --quiet "$@"; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
SRC_DIR="$APP_DIR/gpu/splat"
SA_EMAIL="${SA_NAME}@${PROJECT}.iam.gserviceaccount.com"
AR_HOST="${REGION}-docker.pkg.dev"
IMAGE_BASE="${AR_HOST}/${PROJECT}/${AR_REPO}/${IMAGE_NAME}"
JOB_RESOURCE="projects/${PROJECT}/locations/${REGION}/jobs/${JOB}"

command -v gcloud >/dev/null 2>&1 || die "No encontré gcloud. Instala Google Cloud SDK."
ACCOUNT="$(gcloud auth list --filter=status:ACTIVE --format='value(account)' 2>/dev/null | head -n1 || true)"
[[ -n "$ACCOUNT" ]] || die "No hay una cuenta activa en gcloud. Corre: gcloud auth login"

# ---------------------------------------------------------------------------
# Ejecución de prueba: corre el job con un manifiesto (mismo camino que usa la app:
# overrides de variables de entorno) y espera a que termine.
# ---------------------------------------------------------------------------
if [[ "$ACTION" == "run" ]]; then
  [[ -n "${RUN_MANIFEST:-}" ]] || die "Falta RUN_MANIFEST=gs://<bucket>/<ruta>/manifest.json"
  token="${RUN_TOKEN:-prueba-sin-callback}"
  info "Ejecutando $JOB con $RUN_MANIFEST"
  gc run jobs execute "$JOB" --region="$REGION" --wait \
    --update-env-vars="SPLAT_MANIFEST_URI=${RUN_MANIFEST},SPLAT_CALLBACK_TOKEN=${token}" \
    || warn "La ejecución terminó con error: revisa los logs (abajo)."
  exec_name="$(gc run jobs executions list --job="$JOB" --region="$REGION" --limit=1 --format='value(name)')"
  ok "Ejecución $exec_name"
  cat <<EOF
  Logs:     gcloud logging read 'resource.type="cloud_run_job" AND resource.labels.job_name="$JOB" AND labels."run.googleapis.com/execution_name"="$exec_name"' --project=$PROJECT --limit=200 --order=asc --format='value(textPayload)'
  Salida:   gcloud storage ls ${RUN_MANIFEST%manifest.json} --project=$PROJECT
EOF
  exit 0
fi
[[ "$ACTION" == "deploy" ]] || die "Acción desconocida: $ACTION (usa deploy o run)."

[[ -f "$SRC_DIR/Dockerfile" ]] || die "Falta $SRC_DIR/Dockerfile."

cat <<EOF

Job de GPU 3D Gaussian Splatting → Cloud Run jobs. Esto es lo que se usa o se crea:
  Cuenta gcloud        $ACCOUNT
  Proyecto / región    $PROJECT / $REGION
  Job                  $JOB  (1 GPU $GPU_TYPE, cpu=$CPU, mem=$MEMORY, timeout=$TASK_TIMEOUT, sin reintentos)
  Imagen               ${IMAGE:-$([[ "$SKIP_BUILD" == "1" ]] && echo "$IMAGE_BASE:latest" || echo "se construye con Cloud Build ($BUILD_MACHINE, disco ${BUILD_DISK_GB} GB) → $IMAGE_BASE")}
  Cuenta del job       $SA_EMAIL (lee y escribe objetos en gs://$BUCKET)
  Quién lo ejecuta     $APP_SA (ejecutar con overrides + ver ejecuciones, solo este job)

Costo: la GPU cobra por segundo mientras corre una ejecución (≈ 15–30 min por reconstrucción);
sin ejecuciones no hay costo fijo. Cada build cobra minutos de Cloud Build.
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

info "APIs"
gc services enable run.googleapis.com artifactregistry.googleapis.com cloudbuild.googleapis.com \
  storage.googleapis.com iam.googleapis.com logging.googleapis.com
ok "APIs habilitadas"

info "Artifact Registry ($REGION)"
if gc artifacts repositories describe "$AR_REPO" --location="$REGION" >/dev/null 2>&1; then
  ok "Repositorio $AR_REPO ya existe en $REGION"
else
  gc artifacts repositories create "$AR_REPO" --location="$REGION" \
    --repository-format=docker --description="Imágenes de Vigía (GPU)"
  ok "Repositorio $AR_REPO creado en $REGION"
fi

info "Cuenta de servicio del job"
if gc iam service-accounts describe "$SA_EMAIL" >/dev/null 2>&1; then
  ok "Cuenta $SA_EMAIL ya existe"
else
  gc iam service-accounts create "$SA_NAME" --display-name="Vigía (job GPU 3DGS)"
  ok "Cuenta $SA_EMAIL creada"
  # La cuenta recién creada tarda unos segundos en propagarse para IAM.
  sleep 10
fi
# objectUser: leer los medios del incidente y escribir (o reescribir) scene.splat y preview.jpg.
gc storage buckets add-iam-policy-binding "gs://$BUCKET" \
  --member="serviceAccount:${SA_EMAIL}" --role=roles/storage.objectUser >/dev/null
ok "roles/storage.objectUser solo sobre gs://$BUCKET"

if [[ -z "$IMAGE" && "$SKIP_BUILD" == "1" ]]; then
  IMAGE="${IMAGE_BASE}:latest"
fi
if [[ -z "$IMAGE" ]]; then
  info "Construyendo la imagen con Cloud Build (la primera vez ~30–40 min: compila gsplat y baja 5 GB de pesos)"
  tag="$(date -u +%Y%m%d-%H%M%S)"
  IMAGE="${IMAGE_BASE}:${tag}"
  # Caché en línea de BuildKit desde :latest: sin cambios en las capas pesadas, el build
  # solo rehace la del código (~minutos).
  cat >"$WORK_DIR/cloudbuild.yaml" <<EOF
steps:
  - name: gcr.io/cloud-builders/docker
    env: ['DOCKER_BUILDKIT=1']
    args:
      - build
      - --cache-from
      - '${IMAGE_BASE}:latest'
      - --build-arg
      - BUILDKIT_INLINE_CACHE=1
      - --tag
      - '${IMAGE}'
      - --tag
      - '${IMAGE_BASE}:latest'
      - .
images:
  - '${IMAGE}'
  - '${IMAGE_BASE}:latest'
options:
  machineType: ${BUILD_MACHINE}
  diskSizeGb: ${BUILD_DISK_GB}
timeout: 7200s
EOF
  gc builds submit "$SRC_DIR" --region="$BUILD_REGION" --config="$WORK_DIR/cloudbuild.yaml"
  ok "Imagen $IMAGE"
else
  ok "Se usa la imagen $IMAGE"
fi

info "Desplegando el job $JOB"
DEPLOY_OK=1
if ! gc run jobs deploy "$JOB" \
  --region="$REGION" \
  --image="$IMAGE" \
  --service-account="$SA_EMAIL" \
  --gpu=1 --gpu-type="$GPU_TYPE" --no-gpu-zonal-redundancy \
  --cpu="$CPU" --memory="$MEMORY" \
  --tasks=1 --parallelism=1 --max-retries=0 --task-timeout="$TASK_TIMEOUT" \
  --set-env-vars="SPLAT_GPU_TYPE=${GPU_TYPE}" \
  --labels="app=vigia,component=splat"; then
  # Cloud Run guarda la especificación aunque el job quede sin "Ready": si el recurso existe,
  # se siguen aplicando los permisos para que funcione apenas se resuelva la cuota.
  gc run jobs describe "$JOB" --region="$REGION" >/dev/null 2>&1 \
    || die "No se pudo crear el job. Revisa el error de arriba."
  DEPLOY_OK=0
  warn "El job quedó guardado pero sin \"Ready\". \"Project failed to initialize in this region due to quota exceeded\" es la cuota MaxRegionsPerProject de Cloud Run (regiones usadas por el proyecto), no la de GPU: pide más en IAM y administración → Cuotas (servicio Cloud Run, \"Number of regions\") y vuelve a correr este script con SKIP_BUILD=1. Si el error es de cuota de GPU, pide cuota de $GPU_TYPE en $REGION o usa GPU_TYPE=nvidia-l4."
else
  ok "Job $JOB_RESOURCE"
fi

info "Permisos de $APP_SA sobre el job"
# jobsExecutorWithOverrides: run + runWithOverrides (+ cancelar ejecuciones). run.viewer a nivel
# del job: leer el job y sus ejecuciones (estado si el callback nunca llega).
gc run jobs add-iam-policy-binding "$JOB" --region="$REGION" \
  --member="serviceAccount:${APP_SA}" --role=roles/run.jobsExecutorWithOverrides >/dev/null
ok "roles/run.jobsExecutorWithOverrides en $JOB"
gc run jobs add-iam-policy-binding "$JOB" --region="$REGION" \
  --member="serviceAccount:${APP_SA}" --role=roles/run.viewer >/dev/null
ok "roles/run.viewer en $JOB"

if [[ "$DEPLOY_OK" != "1" ]]; then
  die "Permisos aplicados, pero el job no se puede ejecutar hasta resolver la cuota (ver aviso arriba)."
fi

info "Listo"
cat <<EOF
  Job        $JOB_RESOURCE
  Imagen     $IMAGE
  GPU        $GPU_TYPE

En el servicio de la app define SPLAT_JOB=$JOB_RESOURCE (lo lee src/lib/config.ts).
Prueba manual:
  RUN_MANIFEST=gs://$BUCKET/test/splat/<caso>/manifest.json bash deploy/splat-job.sh run
EOF
