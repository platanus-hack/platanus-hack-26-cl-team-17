#!/usr/bin/env bash
# Despliegue de Vigía en Google Cloud Run (Cloud SQL + Cloud Storage + Secret Manager).
#
# ESTE SCRIPT CREA RECURSOS QUE COBRAN DINERO. Revísalo y confírmalo antes de correrlo
# (lee deploy/README.md). Pide confirmación explícita salvo que pases CONFIRM=1.
#
# Es idempotente: cada recurso se consulta (describe) antes de crearlo. Nunca recrea
# recursos existentes, nunca sobrescribe el valor de un secreto que ya tiene versión y
# nunca cambia la clave del usuario de la base si el secreto vigia-database-url ya existe
# con versión. Los valores secretos nunca se imprimen.
#
# Uso (desde cualquier carpeta):
#   bash deploy/cloudrun.sh                    # infraestructura + build + deploy
#   SKIP_INFRA=1 bash deploy/cloudrun.sh       # solo build + deploy
#   IMAGE=<imagen> bash deploy/cloudrun.sh     # despliega esa imagen sin construir
#   ANTHROPIC_API_KEY=sk-... bash deploy/cloudrun.sh   # carga la llave si el secreto está vacío
#   VIGIA_BRIDGE_TOKEN=... bash deploy/cloudrun.sh     # fija el token del puente Zello si el secreto está vacío
set -euo pipefail

# ---------------------------------------------------------------------------
# Parámetros (todos se pueden sobrescribir con variables de entorno).
# Por defecto apuntan a los recursos ya aprovisionados en platanus-515411.
# ---------------------------------------------------------------------------
PROJECT="${PROJECT:-platanus-515411}"
REGION="${REGION:-southamerica-west1}"
SERVICE="${SERVICE:-vigia}"
SQL_INSTANCE="${SQL_INSTANCE:-vigia-db}"
SQL_TIER="${SQL_TIER:-db-g1-small}"
SQL_EDITION="${SQL_EDITION:-ENTERPRISE}"
SQL_VERSION="${SQL_VERSION:-POSTGRES_17}"
DB_NAME="${DB_NAME:-vigia}"
DB_USER="${DB_USER:-vigia}"
BUCKET="${BUCKET:-platanus-515411-vigia-evidencia}"
AR_REPO="${AR_REPO:-vigia}"
SA_NAME="${SA_NAME:-vigia-run}"
VIGIA_ADMIN_EMAIL="${VIGIA_ADMIN_EMAIL:-admin@vigia.local}"

SECRET_DATABASE_URL="${SECRET_DATABASE_URL:-vigia-database-url}"
SECRET_SESSION="${SECRET_SESSION:-vigia-session-secret}"
SECRET_ADMIN_PASSWORD="${SECRET_ADMIN_PASSWORD:-vigia-admin-password}"
SECRET_ANTHROPIC="${SECRET_ANTHROPIC:-anthropic-api-key}"
# Token interno del puente Zello (tools/zello-bridge → Authorization: Bearer). Con
# DATABASE_URL las rutas del mando exigen sesión, así que sin él el puente recibe 401.
SECRET_BRIDGE="${SECRET_BRIDGE:-vigia-bridge-token}"

# Servicio Cloud Run. min-instances=1 sin throttling de CPU es el principal costo fijo.
CPU="${CPU:-2}"
MEMORY="${MEMORY:-2Gi}"
MIN_INSTANCES="${MIN_INSTANCES:-1}"
# Con db-g1-small (≈50 conexiones) y pool de 8 por instancia, 4 instancias = 32 conexiones.
MAX_INSTANCES="${MAX_INSTANCES:-4}"
CONCURRENCY="${CONCURRENCY:-40}"
TIMEOUT="${TIMEOUT:-900}"
DATABASE_POOL_MAX="${DATABASE_POOL_MAX:-8}"

# URL pública de la app. Vacío → la URL determinista de Cloud Run
# (https://SERVICIO-NUMERODEPROYECTO.REGION.run.app), que se conoce antes del primer deploy.
APP_URL="${APP_URL:-${NEXT_PUBLIC_APP_URL:-}}"
NEXT_PUBLIC_MAP_STYLE_DARK="${NEXT_PUBLIC_MAP_STYLE_DARK:-}"
NEXT_PUBLIC_MAP_STYLE_LIGHT="${NEXT_PUBLIC_MAP_STYLE_LIGHT:-}"

# Opcionales del motor de IA (vacío = valor por defecto de src/lib/config.ts).
# Job de GPU de 3D Gaussian Splatting (deploy/splat-job.sh). Vacío = reconstrucción real desactivada.
SPLAT_JOB="${SPLAT_JOB:-projects/${PROJECT}/locations/europe-west1/jobs/vigia-splat}"
# Iteraciones de entrenamiento 3DGS: 4000 ≈ 2,5 min en una L4 (7000 da algo más de detalle y tarda ~4 min).
SPLAT_ITERATIONS="${SPLAT_ITERATIONS:-4000}"
VIGIA_AI_MODEL="${VIGIA_AI_MODEL:-}"
VIGIA_AI_EFFORT="${VIGIA_AI_EFFORT:-}"
VIGIA_AI_FAST="${VIGIA_AI_FAST:-1}"
# Usuario de Zello del OBAC: lo que dice por Zello es una pregunta para Vigía. Lo lee el
# agente en el servidor; usa el mismo valor que el .env.local del puente. Vacío = solo
# cuenta lo que empieza con «Vigía, …».
ZELLO_OBAC_USERNAME="${ZELLO_OBAC_USERNAME:-}"

# 1 → falla si el secreto de Anthropic no tiene valor (por defecto se despliega con IA simulada).
REQUIRE_ANTHROPIC="${REQUIRE_ANTHROPIC:-0}"
# Build con Cloud Build.
BUILD_REGION="${BUILD_REGION:-global}"
BUILD_MACHINE="${BUILD_MACHINE:-E2_HIGHCPU_8}"
IMAGE="${IMAGE:-}"
SKIP_INFRA="${SKIP_INFRA:-0}"
CONFIRM="${CONFIRM:-0}"

# ---------------------------------------------------------------------------
# Utilidades
# ---------------------------------------------------------------------------
info() { printf '\n\033[1;34m==>\033[0m %s\n' "$*"; }
ok() { printf '    \033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '\n\033[1;33m[AVISO]\033[0m %s\n' "$*" >&2; }
die() { printf '\n\033[1;31m[ERROR]\033[0m %s\n' "$*" >&2; exit 1; }

gc() { gcloud --project="$PROJECT" --quiet "$@"; }

# Codifica un texto para usarlo dentro de una URL (RFC 3986, sin dependencias).
urlencode() {
  local LC_ALL=C s="$1" out="" c i
  for ((i = 0; i < ${#s}; i++)); do
    c="${s:i:1}"
    case "$c" in
      [a-zA-Z0-9.~_-]) out+="$c" ;;
      *) out+=$(printf '%%%02X' "'$c") ;;
    esac
  done
  printf '%s' "$out"
}

# Cadena YAML entre comillas simples. Con dollar=1 también duplica "$" (Cloud Build
# interpreta $VAR como sustitución en los argumentos de un paso).
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
  if secret_exists "$1"; then
    ok "Secreto $1 ya existe"
  else
    gc secrets create "$1" --replication-policy=automatic >/dev/null
    ok "Secreto $1 creado (sin valor todavía)"
  fi
}

# Agrega la primera versión de un secreto leyendo el valor por stdin (no queda en argv).
add_secret_version() {
  printf '%s' "$2" | gc secrets versions add "$1" --data-file=- >/dev/null
  ok "Secreto $1: primera versión guardada"
}

grant_secret_access() {
  gc secrets add-iam-policy-binding "$1" \
    --member="serviceAccount:${SA_EMAIL}" --role=roles/secretmanager.secretAccessor \
    --condition=None >/dev/null
  ok "Acceso de ${SA_NAME} al secreto $1"
}

# ---------------------------------------------------------------------------
# Comprobaciones previas (antes de tocar nada)
# ---------------------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
CORS_FILE="$SCRIPT_DIR/cors.json"

command -v gcloud >/dev/null 2>&1 || die "No encontré gcloud. Instala Google Cloud SDK: https://cloud.google.com/sdk/docs/install"
command -v openssl >/dev/null 2>&1 || die "No encontré openssl (se usa para generar claves)."
[[ -f "$CORS_FILE" ]] || die "Falta deploy/cors.json (configuración CORS del bucket). Sin ella el navegador no puede subir evidencia directo a Cloud Storage."
[[ -f "$APP_DIR/Dockerfile" ]] || die "Falta el Dockerfile en $APP_DIR."
if [[ -z "$IMAGE" ]]; then
  compgen -G "$APP_DIR/db/migrations/*.sql" >/dev/null || die "No hay migraciones en db/migrations/*.sql: la imagen las necesita."
fi

ACCOUNT="$(gcloud auth list --filter=status:ACTIVE --format='value(account)' 2>/dev/null | head -n1 || true)"
[[ -n "$ACCOUNT" ]] || die "No hay una cuenta activa en gcloud. Corre: gcloud auth login"

PROJECT_NUMBER="$(gc projects describe "$PROJECT" --format='value(projectNumber)' 2>/dev/null || true)"
[[ -n "$PROJECT_NUMBER" ]] || die "No pude leer el proyecto $PROJECT con la cuenta $ACCOUNT (¿existe? ¿tienes permisos?)."

SA_EMAIL="${SA_NAME}@${PROJECT}.iam.gserviceaccount.com"
SQL_CONNECTION="${PROJECT}:${REGION}:${SQL_INSTANCE}"
AR_HOST="${REGION}-docker.pkg.dev"
DETERMINISTIC_URL="https://${SERVICE}-${PROJECT_NUMBER}.${REGION}.run.app"
APP_URL_WAS_DEFAULT=0
if [[ -z "$APP_URL" ]]; then
  APP_URL="$DETERMINISTIC_URL"
  APP_URL_WAS_DEFAULT=1
fi
APP_URL="${APP_URL%/}"

cat <<EOF

Vigía → Cloud Run. Esto es lo que se va a usar o crear:
  Cuenta gcloud        $ACCOUNT
  Proyecto / región    $PROJECT ($PROJECT_NUMBER) / $REGION
  Servicio Cloud Run   $SERVICE  (cpu=$CPU mem=$MEMORY min=$MIN_INSTANCES max=$MAX_INSTANCES concurrencia=$CONCURRENCY timeout=${TIMEOUT}s, sin throttling de CPU)
  Cloud SQL            $SQL_INSTANCE ($SQL_VERSION, $SQL_EDITION, $SQL_TIER) · base $DB_NAME · usuario $DB_USER
  Bucket               gs://$BUCKET (CORS desde deploy/cors.json)
  Artifact Registry    $AR_HOST/$PROJECT/$AR_REPO
  Cuenta de servicio   $SA_EMAIL
  Secretos             $SECRET_DATABASE_URL, $SECRET_SESSION, $SECRET_ADMIN_PASSWORD, $SECRET_ANTHROPIC, $SECRET_BRIDGE
  Admin inicial       $VIGIA_ADMIN_EMAIL
  URL de la app        $APP_URL
  Infraestructura      $([[ "$SKIP_INFRA" == "1" ]] && echo "se omite (SKIP_INFRA=1)" || echo "se revisa y se crea lo que falte")
  Imagen               ${IMAGE:-se construye con Cloud Build ($BUILD_MACHINE)}

Costo fijo aproximado: Cloud Run con min-instances=$MIN_INSTANCES siempre encendido + Cloud SQL $SQL_TIER.
Confírmalo en https://cloud.google.com/products/calculator antes de seguir.
EOF

if [[ "$CONFIRM" != "1" ]]; then
  if [[ -t 0 ]]; then
    read -r -p $'\nEscribe "si" para continuar: ' answer
    [[ "$answer" == "si" || "$answer" == "sí" ]] || die "Cancelado. No se tocó nada."
  else
    die "Sin terminal interactiva: confirma con CONFIRM=1 si de verdad quieres desplegar."
  fi
fi

WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT

# ---------------------------------------------------------------------------
# Infraestructura
# ---------------------------------------------------------------------------
if [[ "$SKIP_INFRA" != "1" ]]; then
  info "Habilitando APIs"
  gc services enable \
    run.googleapis.com sqladmin.googleapis.com artifactregistry.googleapis.com \
    cloudbuild.googleapis.com secretmanager.googleapis.com storage.googleapis.com \
    iamcredentials.googleapis.com iam.googleapis.com
  ok "APIs habilitadas"

  info "Artifact Registry"
  if gc artifacts repositories describe "$AR_REPO" --location="$REGION" >/dev/null 2>&1; then
    ok "Repositorio $AR_REPO ya existe"
  else
    gc artifacts repositories create "$AR_REPO" --location="$REGION" \
      --repository-format=docker --description="Imágenes de Vigía"
    ok "Repositorio $AR_REPO creado"
  fi

  info "Cloud SQL"
  if gc sql instances describe "$SQL_INSTANCE" >/dev/null 2>&1; then
    ok "Instancia $SQL_INSTANCE ya existe (no se modifica)"
  else
    echo "    Creando instancia $SQL_INSTANCE (toma ~10 minutos)…"
    # IP pública sin redes autorizadas: solo se entra por el conector de Cloud SQL.
    gc sql instances create "$SQL_INSTANCE" \
      --database-version="$SQL_VERSION" --edition="$SQL_EDITION" --tier="$SQL_TIER" \
      --region="$REGION" --storage-type=SSD --storage-size=10 --storage-auto-increase \
      --availability-type=zonal --backup-start-time=07:00 --deletion-protection
    ok "Instancia $SQL_INSTANCE creada"
  fi

  if gc sql databases describe "$DB_NAME" --instance="$SQL_INSTANCE" >/dev/null 2>&1; then
    ok "Base $DB_NAME ya existe"
  else
    gc sql databases create "$DB_NAME" --instance="$SQL_INSTANCE" >/dev/null
    ok "Base $DB_NAME creada"
  fi

  info "Secretos"
  for s in "$SECRET_DATABASE_URL" "$SECRET_SESSION" "$SECRET_ADMIN_PASSWORD" "$SECRET_ANTHROPIC" "$SECRET_BRIDGE"; do
    ensure_secret "$s"
  done

  # Usuario de la base + DATABASE_URL. La clave solo se genera si el secreto aún no tiene valor.
  user_exists=0
  if [[ -n "$(gc sql users list --instance="$SQL_INSTANCE" --filter="name=$DB_USER" --format='value(name)' 2>/dev/null || true)" ]]; then
    user_exists=1
  fi
  if secret_has_version "$SECRET_DATABASE_URL"; then
    [[ "$user_exists" == "1" ]] || die "El secreto $SECRET_DATABASE_URL tiene valor pero el usuario $DB_USER no existe en $SQL_INSTANCE. Revisa a mano: crea el usuario con la clave que guarda el secreto, o deshabilita esa versión del secreto y vuelve a correr el script."
    ok "Usuario $DB_USER y $SECRET_DATABASE_URL ya existen (no se toca la clave)"
  else
    db_password="$(openssl rand -hex 24)"
    if [[ "$user_exists" == "1" ]]; then
      warn "El usuario $DB_USER existe pero $SECRET_DATABASE_URL no tiene valor: se le asigna una clave nueva."
      gc sql users set-password "$DB_USER" --instance="$SQL_INSTANCE" --password="$db_password" >/dev/null
    else
      gc sql users create "$DB_USER" --instance="$SQL_INSTANCE" --password="$db_password" >/dev/null
    fi
    database_url="postgresql://$(urlencode "$DB_USER"):$(urlencode "$db_password")@/$(urlencode "$DB_NAME")?host=/cloudsql/${SQL_CONNECTION}"
    add_secret_version "$SECRET_DATABASE_URL" "$database_url"
    unset db_password database_url
  fi

  if secret_has_version "$SECRET_SESSION"; then
    ok "$SECRET_SESSION ya tiene valor (se conserva)"
  else
    add_secret_version "$SECRET_SESSION" "$(openssl rand -base64 48 | tr -d '\n')"
  fi

  if secret_has_version "$SECRET_ADMIN_PASSWORD"; then
    ok "$SECRET_ADMIN_PASSWORD ya tiene valor (se conserva)"
  elif [[ -n "${VIGIA_ADMIN_PASSWORD:-}" ]]; then
    [[ "${#VIGIA_ADMIN_PASSWORD}" -ge 10 ]] || die "VIGIA_ADMIN_PASSWORD debe tener al menos 10 caracteres."
    add_secret_version "$SECRET_ADMIN_PASSWORD" "$VIGIA_ADMIN_PASSWORD"
  else
    # Se genera y NO se imprime: se lee después con gcloud (ver mensaje final).
    admin_password="$(openssl rand -base64 48 | tr -dc 'A-Za-z0-9')"
    add_secret_version "$SECRET_ADMIN_PASSWORD" "${admin_password:0:24}"
    unset admin_password
    ADMIN_PASSWORD_GENERATED=1
  fi

  if secret_has_version "$SECRET_ANTHROPIC"; then
    ok "$SECRET_ANTHROPIC ya tiene valor (se conserva)"
  elif [[ -n "${ANTHROPIC_API_KEY:-}" ]]; then
    add_secret_version "$SECRET_ANTHROPIC" "$ANTHROPIC_API_KEY"
  fi

  # Token del puente Zello: el mismo valor va en el .env.local de quien corre el puente.
  # Se toma VIGIA_BRIDGE_TOKEN si lo defines (para que calce con un puente ya configurado);
  # si no, se genera uno. Nunca se imprime.
  if secret_has_version "$SECRET_BRIDGE"; then
    ok "$SECRET_BRIDGE ya tiene valor (se conserva)"
  elif [[ -n "${VIGIA_BRIDGE_TOKEN:-}" ]]; then
    add_secret_version "$SECRET_BRIDGE" "$VIGIA_BRIDGE_TOKEN"
  else
    add_secret_version "$SECRET_BRIDGE" "$(openssl rand -hex 32)"
  fi

  info "Cloud Storage"
  if gc storage buckets describe "gs://$BUCKET" >/dev/null 2>&1; then
    ok "Bucket gs://$BUCKET ya existe"
  else
    gc storage buckets create "gs://$BUCKET" --location="$REGION" \
      --default-storage-class=STANDARD --uniform-bucket-level-access --public-access-prevention
    ok "Bucket gs://$BUCKET creado"
  fi
  # cors.json puede traer un marcador de origen (https://REEMPLAZA-CON-TU-ORIGEN o __APP_URL__):
  # se reemplaza por la URL de la app para no fijarla a mano.
  cors_json="$(<"$CORS_FILE")"
  cors_json="${cors_json//https:\/\/REEMPLAZA-CON-TU-ORIGEN/"$APP_URL"}"
  printf '%s\n' "${cors_json//__APP_URL__/"$APP_URL"}" >"$WORK_DIR/cors.json"
  if ! grep -qF "\"$APP_URL\"" "$WORK_DIR/cors.json" && ! grep -qF '"*"' "$WORK_DIR/cors.json"; then
    warn "deploy/cors.json no incluye el origen $APP_URL: el navegador no podrá subir evidencia. Agrega ese origen (o el marcador __APP_URL__) y vuelve a correr el script."
  fi
  gc storage buckets update "gs://$BUCKET" \
    --uniform-bucket-level-access --public-access-prevention --cors-file="$WORK_DIR/cors.json" >/dev/null
  ok "Acceso uniforme, sin acceso público y CORS aplicados"

  info "Cuenta de servicio y permisos mínimos"
  if gc iam service-accounts describe "$SA_EMAIL" >/dev/null 2>&1; then
    ok "Cuenta $SA_EMAIL ya existe"
  else
    gc iam service-accounts create "$SA_NAME" --display-name="Vigía (Cloud Run)"
    ok "Cuenta $SA_EMAIL creada"
  fi
  gc projects add-iam-policy-binding "$PROJECT" \
    --member="serviceAccount:${SA_EMAIL}" --role=roles/cloudsql.client --condition=None >/dev/null
  ok "roles/cloudsql.client en el proyecto"
  gc storage buckets add-iam-policy-binding "gs://$BUCKET" \
    --member="serviceAccount:${SA_EMAIL}" --role=roles/storage.objectAdmin >/dev/null
  ok "roles/storage.objectAdmin solo sobre gs://$BUCKET"
  # Firmar URLs V4 sin llave usa IAM signBlob sobre la propia cuenta.
  gc iam service-accounts add-iam-policy-binding "$SA_EMAIL" \
    --member="serviceAccount:${SA_EMAIL}" --role=roles/iam.serviceAccountTokenCreator \
    --condition=None >/dev/null
  ok "roles/iam.serviceAccountTokenCreator sobre sí misma (signBlob)"
  for s in "$SECRET_DATABASE_URL" "$SECRET_SESSION" "$SECRET_ADMIN_PASSWORD" "$SECRET_ANTHROPIC" "$SECRET_BRIDGE"; do
    grant_secret_access "$s"
  done
fi

# ---------------------------------------------------------------------------
# Secretos que se montan (los obligatorios deben tener valor)
# ---------------------------------------------------------------------------
info "Revisando secretos"
for s in "$SECRET_DATABASE_URL" "$SECRET_SESSION" "$SECRET_ADMIN_PASSWORD"; do
  secret_has_version "$s" || die "El secreto $s no tiene ninguna versión habilitada. Corre el script sin SKIP_INFRA para crearlo."
done
SECRETS="DATABASE_URL=${SECRET_DATABASE_URL}:latest,VIGIA_SESSION_SECRET=${SECRET_SESSION}:latest,VIGIA_ADMIN_PASSWORD=${SECRET_ADMIN_PASSWORD}:latest"
ANTHROPIC_MOUNTED=0
if secret_has_version "$SECRET_ANTHROPIC"; then
  SECRETS+=",ANTHROPIC_API_KEY=${SECRET_ANTHROPIC}:latest"
  ANTHROPIC_MOUNTED=1
  ok "Se monta $SECRET_ANTHROPIC (IA con Claude)"
elif [[ "$REQUIRE_ANTHROPIC" == "1" ]]; then
  die "El secreto $SECRET_ANTHROPIC no tiene valor. Cárgalo con: printf '%s' \"\$ANTHROPIC_API_KEY\" | gcloud secrets versions add $SECRET_ANTHROPIC --data-file=- --project=$PROJECT"
else
  warn "El secreto $SECRET_ANTHROPIC no tiene valor: se despliega SIN llave de Anthropic y la IA funcionará en modo SIMULADO (rotulado así en la interfaz)."
fi
BRIDGE_MOUNTED=0
if secret_has_version "$SECRET_BRIDGE"; then
  SECRETS+=",VIGIA_BRIDGE_TOKEN=${SECRET_BRIDGE}:latest"
  BRIDGE_MOUNTED=1
  ok "Se monta $SECRET_BRIDGE (puente Zello)"
else
  warn "El secreto $SECRET_BRIDGE no tiene valor: se despliega SIN token del puente Zello y el puente recibirá 401. Corre el script sin SKIP_INFRA para crearlo."
fi
ok "Secretos listos"

# ---------------------------------------------------------------------------
# Build con Cloud Build (gcloud builds submit --tag no acepta build args → config propia)
# ---------------------------------------------------------------------------
if [[ -z "$IMAGE" ]]; then
  info "Construyendo la imagen con Cloud Build"
  tag="$(date -u +%Y%m%d-%H%M%S)"
  if git -C "$APP_DIR" rev-parse --short HEAD >/dev/null 2>&1; then
    tag+="-$(git -C "$APP_DIR" rev-parse --short HEAD)"
  fi
  IMAGE="${AR_HOST}/${PROJECT}/${AR_REPO}/${SERVICE}:${tag}"
  cat >"$WORK_DIR/cloudbuild.yaml" <<EOF
steps:
  - name: gcr.io/cloud-builders/docker
    env: ['DOCKER_BUILDKIT=1']
    args:
      - build
      - --build-arg
      - $(yaml_quote "NEXT_PUBLIC_APP_URL=${APP_URL}" 1)
      - --build-arg
      - $(yaml_quote "NEXT_PUBLIC_MAP_STYLE_DARK=${NEXT_PUBLIC_MAP_STYLE_DARK}" 1)
      - --build-arg
      - $(yaml_quote "NEXT_PUBLIC_MAP_STYLE_LIGHT=${NEXT_PUBLIC_MAP_STYLE_LIGHT}" 1)
      - --tag
      - $(yaml_quote "$IMAGE" 1)
      - .
images:
  - $(yaml_quote "$IMAGE" 1)
options:
  machineType: ${BUILD_MACHINE}
timeout: 1800s
EOF
  gc builds submit "$APP_DIR" --region="$BUILD_REGION" \
    --config="$WORK_DIR/cloudbuild.yaml" --ignore-file="$APP_DIR/.dockerignore"
  ok "Imagen $IMAGE"
else
  ok "Se usa la imagen dada: $IMAGE"
fi

# ---------------------------------------------------------------------------
# Deploy en Cloud Run
# ---------------------------------------------------------------------------
info "Desplegando $SERVICE en Cloud Run"
# Archivo YAML de variables (evita problemas con comas en los valores).
{
  printf 'GCS_BUCKET: %s\n' "$(yaml_quote "$BUCKET")"
  printf 'GOOGLE_CLOUD_PROJECT: %s\n' "$(yaml_quote "$PROJECT")"
  printf 'VIGIA_ADMIN_EMAIL: %s\n' "$(yaml_quote "$VIGIA_ADMIN_EMAIL")"
  printf 'NEXT_PUBLIC_APP_URL: %s\n' "$(yaml_quote "$APP_URL")"
  printf 'DATABASE_POOL_MAX: %s\n' "$(yaml_quote "$DATABASE_POOL_MAX")"
  [[ -n "$NEXT_PUBLIC_MAP_STYLE_DARK" ]] && printf 'NEXT_PUBLIC_MAP_STYLE_DARK: %s\n' "$(yaml_quote "$NEXT_PUBLIC_MAP_STYLE_DARK")"
  [[ -n "$NEXT_PUBLIC_MAP_STYLE_LIGHT" ]] && printf 'NEXT_PUBLIC_MAP_STYLE_LIGHT: %s\n' "$(yaml_quote "$NEXT_PUBLIC_MAP_STYLE_LIGHT")"
  [[ -n "$SPLAT_JOB" ]] && printf 'SPLAT_JOB: %s\n' "$(yaml_quote "$SPLAT_JOB")"
  [[ -n "$SPLAT_ITERATIONS" ]] && printf 'SPLAT_ITERATIONS: %s\n' "$(yaml_quote "$SPLAT_ITERATIONS")"
  [[ -n "$VIGIA_AI_MODEL" ]] && printf 'VIGIA_AI_MODEL: %s\n' "$(yaml_quote "$VIGIA_AI_MODEL")"
  [[ -n "$VIGIA_AI_EFFORT" ]] && printf 'VIGIA_AI_EFFORT: %s\n' "$(yaml_quote "$VIGIA_AI_EFFORT")"
  [[ -n "$VIGIA_AI_FAST" ]] && printf 'VIGIA_AI_FAST: %s\n' "$(yaml_quote "$VIGIA_AI_FAST")"
  [[ -n "$ZELLO_OBAC_USERNAME" ]] && printf 'ZELLO_OBAC_USERNAME: %s\n' "$(yaml_quote "$ZELLO_OBAC_USERNAME")"
  true
} >"$WORK_DIR/env.yaml"

gc run deploy "$SERVICE" \
  --region="$REGION" \
  --image="$IMAGE" \
  --service-account="$SA_EMAIL" \
  --add-cloudsql-instances="$SQL_CONNECTION" \
  --execution-environment=gen2 \
  --no-cpu-throttling \
  --cpu-boost \
  --cpu="$CPU" \
  --memory="$MEMORY" \
  --min-instances="$MIN_INSTANCES" \
  --max-instances="$MAX_INSTANCES" \
  --concurrency="$CONCURRENCY" \
  --timeout="$TIMEOUT" \
  --port=8080 \
  --allow-unauthenticated \
  --env-vars-file="$WORK_DIR/env.yaml" \
  --set-secrets="$SECRETS"

STATUS_URL="$(gc run services describe "$SERVICE" --region="$REGION" --format='value(status.url)' 2>/dev/null || true)"

# ---------------------------------------------------------------------------
# Resumen y próximos pasos
# ---------------------------------------------------------------------------
info "Listo"
cat <<EOF
  URL de la app      $APP_URL
  URL de Cloud Run   ${STATUS_URL:-(no se pudo leer)}
  Imagen             $IMAGE
  IA                 $([[ "$ANTHROPIC_MOUNTED" == "1" ]] && echo "Claude (llave montada)" || echo "SIMULADA (falta valor en $SECRET_ANTHROPIC)")
  Puente Zello       $([[ "$BRIDGE_MOUNTED" == "1" ]] && echo "token montado ($SECRET_BRIDGE)" || echo "SIN token (falta valor en $SECRET_BRIDGE)")

Próximos pasos:
  1. Revisa que responda:  curl -fsS $APP_URL/api/status
  2. Entra a $APP_URL/login con $VIGIA_ADMIN_EMAIL. La clave inicial está en Secret Manager:
       gcloud secrets versions access latest --secret=$SECRET_ADMIN_PASSWORD --project=$PROJECT
     La cuenta admin se crea en el primer inicio de sesión con esas credenciales.
EOF
if [[ "${ADMIN_PASSWORD_GENERATED:-0}" == "1" ]]; then
  warn "La clave del admin se generó recién y NO se imprimió. Léela con el comando de arriba y cámbiala o guárdala en un lugar seguro."
fi
if [[ "$ANTHROPIC_MOUNTED" != "1" ]]; then
  cat <<EOF
  3. Para activar Claude carga la llave y vuelve a desplegar:
       printf '%s' "\$ANTHROPIC_API_KEY" | gcloud secrets versions add $SECRET_ANTHROPIC --data-file=- --project=$PROJECT
       SKIP_INFRA=1 IMAGE=$IMAGE bash deploy/cloudrun.sh
EOF
fi
if [[ "$BRIDGE_MOUNTED" == "1" ]]; then
  cat <<EOF

  Puente Zello (corre aparte, en un notebook o la Jetson). En su .env.local pon:
       VIGIA_URL=$APP_URL
       VIGIA_BRIDGE_TOKEN=<el valor de: gcloud secrets versions access latest --secret=$SECRET_BRIDGE --project=$PROJECT>
     y córrelo con: npm run zello
EOF
fi
# Huevo y gallina: la URL que se usó en el build y en CORS debe ser una URL real del servicio.
if [[ "$APP_URL_WAS_DEFAULT" == "1" && -n "$STATUS_URL" && "$STATUS_URL" != "$DETERMINISTIC_URL" ]]; then
  cat <<EOF

  Nota sobre la URL: se usó la URL determinista $DETERMINISTIC_URL (CORS y NEXT_PUBLIC_APP_URL).
  Cloud Run también publica $STATUS_URL; ambas apuntan al mismo servicio. Si $DETERMINISTIC_URL
  no abre (proyectos antiguos), vuelve a correr con la URL que sí funciona:
       APP_URL=$STATUS_URL bash deploy/cloudrun.sh
  Eso reconstruye la imagen (NEXT_PUBLIC_* se fija en el build) y actualiza CORS.
EOF
fi
if [[ "$APP_URL_WAS_DEFAULT" != "1" ]]; then
  cat <<EOF

  Usaste APP_URL=$APP_URL. Si es un dominio propio, mapéalo al servicio
  (gcloud beta run domain-mappings create o un balanceador) y confirma que cors.json lo incluya.
EOF
fi
