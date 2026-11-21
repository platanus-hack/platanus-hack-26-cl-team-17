# Despliegue de Vigía en Google Cloud Run

> **Importante:** `deploy/cloudrun.sh` crea y modifica recursos que **cobran dinero**.
> Léelo completo y confírmalo antes de correrlo. El script muestra un resumen y pide que
> escribas `si`; en una terminal no interactiva solo avanza con `CONFIRM=1`.

Arquitectura: un contenedor Next.js (`output: "standalone"`, con ffmpeg) en **Cloud Run**,
datos en **Cloud SQL (Postgres 17)** por el conector `/cloudsql/...`, evidencia (videos y
fotogramas) en **Cloud Storage** con URLs firmadas V4, y secretos en **Secret Manager**.

## Recursos (nombres reales, ya aprovisionados)

| Recurso | Nombre |
|---|---|
| Proyecto / región | `platanus-515411` / `southamerica-west1` |
| Servicio Cloud Run | `vigia` |
| Cloud SQL | instancia `vigia-db` (Postgres 17, edición Enterprise, `db-g1-small`, IP pública **sin** redes autorizadas: solo se entra por el conector), base `vigia`, usuario `vigia` · conexión `platanus-515411:southamerica-west1:vigia-db` |
| Bucket | `gs://platanus-515411-vigia-evidencia` (acceso uniforme, prevención de acceso público, CORS desde `deploy/cors.json`) |
| Artifact Registry | `southamerica-west1-docker.pkg.dev/platanus-515411/vigia` (repositorio Docker `vigia`) |
| Cuenta de servicio | `vigia-run@platanus-515411.iam.gserviceaccount.com` |
| Secretos | `vigia-database-url` (→ `DATABASE_URL`), `vigia-session-secret` (→ `VIGIA_SESSION_SECRET`), `vigia-admin-password` (→ `VIGIA_ADMIN_PASSWORD`), `anthropic-api-key` (→ `ANTHROPIC_API_KEY`, puede estar sin valor), `vigia-bridge-token` (→ `VIGIA_BRIDGE_TOKEN`, token del puente Zello) |
| Admin inicial | `VIGIA_ADMIN_EMAIL=admin@vigia.local` |

Todos son los valores por defecto de `cloudrun.sh` y se pueden cambiar con variables de
entorno (`PROJECT`, `REGION`, `SERVICE`, `SQL_INSTANCE`, `DB_NAME`, `DB_USER`, `BUCKET`,
`AR_REPO`, `SA_NAME`, `VIGIA_ADMIN_EMAIL`, …; mira el bloque de parámetros al inicio del script).

## Qué hace `cloudrun.sh`

Es **idempotente**: consulta cada recurso antes de crearlo y nunca recrea lo que ya existe.

1. Habilita las APIs: `run`, `sqladmin`, `artifactregistry`, `cloudbuild`, `secretmanager`,
   `storage`, `iamcredentials` (y `iam`, necesaria para crear la cuenta de servicio).
2. Repositorio Docker en Artifact Registry.
3. Cloud SQL Postgres 17 `db-g1-small` `--edition=ENTERPRISE`, zonal, SSD de 10 GB con
   crecimiento automático, respaldo diario y protección contra borrado. Si la instancia ya
   existe **no la modifica**.
4. Base `vigia` y usuario `vigia`. La clave del usuario se genera solo si el secreto
   `vigia-database-url` todavía no tiene valor; si ya lo tiene, **no toca la clave**. Se guarda
   `DATABASE_URL` en forma de socket:
   `postgresql://vigia:CLAVE@/vigia?host=/cloudsql/platanus-515411:southamerica-west1:vigia-db`
   (clave codificada para URL). La clave nunca se imprime.
5. Secretos. Crea los que falten y solo agrega una **primera** versión a los que no tienen
   valor; nunca sobrescribe uno existente:
   - `vigia-session-secret`: `openssl rand -base64 48`.
   - `vigia-admin-password`: usa `VIGIA_ADMIN_PASSWORD` si la defines (≥ 10 caracteres); si no,
     genera una de 24 caracteres y **no la imprime** (para que no quede en el historial de la
     terminal ni en registros). Léela con
     `gcloud secrets versions access latest --secret=vigia-admin-password --project=platanus-515411`.
   - `anthropic-api-key`: si está vacío y defines `ANTHROPIC_API_KEY` al correr el script, la
     carga. Ojo: si tienes esa variable exportada en tu terminal por desarrollo local, se usará.
   - `vigia-bridge-token`: token interno del puente Zello (`tools/zello-bridge`). Usa
     `VIGIA_BRIDGE_TOKEN` si la defines (para que calce con el `.env.local` del puente); si no,
     genera uno con `openssl rand -hex 32` y no lo imprime. El mismo valor va en el `.env.local`
     de quien corre el puente, junto con `VIGIA_URL=<URL de la app>`; léelo con
     `gcloud secrets versions access latest --secret=vigia-bridge-token --project=platanus-515411`.
6. Bucket con acceso uniforme, prevención de acceso público y CORS de `deploy/cors.json`
   (el script falla si el archivo no existe). El marcador de origen del archivo
   (`https://REEMPLAZA-CON-TU-ORIGEN`, o `__APP_URL__`) se reemplaza por la URL de la app en una
   copia temporal; el archivo del repositorio no cambia. Si el origen de la app no aparece, avisa.
   Para permitir más orígenes (p. ej. un dominio propio además de la URL de Cloud Run), agrégalos
   a la lista `origin` de `cors.json`.
7. Cuenta de servicio con permisos mínimos (ver la sección de IAM).
8. Construye la imagen con **Cloud Build** (máquina `E2_HIGHCPU_8`). Como
   `gcloud builds submit --tag` no acepta build args, genera un `cloudbuild.yaml` temporal
   que pasa las `NEXT_PUBLIC_*` como `--build-arg`. El contexto que se sube respeta
   `.dockerignore`.
9. `gcloud run deploy` con: `--add-cloudsql-instances`, `--no-cpu-throttling` (el trabajo de IA
   corre en `after()` después de responder y necesita CPU), `--timeout=900`, `--cpu=2
   --memory=2Gi`, `--min-instances=1`, `--max-instances=4`, `--concurrency=40`,
   `--execution-environment=gen2`, `--cpu-boost`, `--allow-unauthenticated` (los vecinos
   reportan sin cuenta), la cuenta de servicio, las variables (`GCS_BUCKET`,
   `GOOGLE_CLOUD_PROJECT`, `VIGIA_ADMIN_EMAIL`, `NEXT_PUBLIC_APP_URL`, `DATABASE_POOL_MAX`, y las
   opcionales de mapa, IA y `ZELLO_OBAC_USERNAME` si las defines) y los secretos.
   Las variables van en un archivo YAML (`--env-vars-file`, mismo efecto que `--set-env-vars`)
   para que las comas en los valores no rompan nada.
10. Imprime la URL y los próximos pasos.

### Llave de Anthropic pendiente

Si `anthropic-api-key` **no tiene ninguna versión**, el script **no lo monta** y despliega
igual: la IA corre en **modo simulado**, que la interfaz rotula siempre como tal. Al final te
muestra cómo cargar la llave y redesplegar sin reconstruir:

```bash
printf '%s' "$ANTHROPIC_API_KEY" | gcloud secrets versions add anthropic-api-key --data-file=- --project=platanus-515411
SKIP_INFRA=1 IMAGE=<imagen del último deploy> bash deploy/cloudrun.sh
```

Si prefieres que el script falle en vez de desplegar con IA simulada: `REQUIRE_ANTHROPIC=1`.

### La URL de la app (huevo y gallina)

La URL se necesita **antes** del primer deploy: va al build (`NEXT_PUBLIC_APP_URL`) y al CORS
del bucket. El script la resuelve así:

- Si no defines `APP_URL`, usa la **URL determinista** de Cloud Run,
  `https://vigia-<NÚMERO_DE_PROYECTO>.southamerica-west1.run.app`, que se conoce antes de
  desplegar (el script lee el número de proyecto).
- Al terminar compara con la URL que informa Cloud Run. Si son distintas, ambas apuntan al
  mismo servicio; si la determinista no abriera, vuelve a correr con
  `APP_URL=<la URL que sí funciona> bash deploy/cloudrun.sh` (reconstruye y actualiza CORS).
- Con dominio propio: `APP_URL=https://vigia.tu-dominio.cl bash deploy/cloudrun.sh`, mapea el
  dominio al servicio y confirma que `cors.json` lo incluya.

## Requisitos

- **gcloud** (Google Cloud SDK) con sesión iniciada: `gcloud auth login`.
- **openssl** y **bash** ≥ 4 (Linux, macOS con bash de Homebrew, o Cloud Shell).
- Proyecto con **facturación activa**.
- Permisos de quien corre el script (lo más simple: `roles/owner` del proyecto). Si no, al
  menos: Service Usage Admin, Artifact Registry Admin, Cloud SQL Admin, Secret Manager Admin,
  Storage Admin, Service Account Admin, Project IAM Admin, Cloud Build Editor, Cloud Run Admin
  y Service Account User sobre `vigia-run`.
- Una política de organización que prohíba `allUsers` (uso compartido restringido por dominio)
  impide `--allow-unauthenticated`; en ese caso hay que pedir una excepción para el proyecto.
- Si Cloud Build falla por permisos al subir la imagen, la cuenta con que corre el build
  (en proyectos nuevos, la cuenta por defecto de Compute Engine
  `<NÚMERO>-compute@developer.gserviceaccount.com`) necesita `roles/artifactregistry.writer`
  sobre el repositorio, `roles/logging.logWriter` y lectura del bucket de fuentes de Cloud Build.

## Paso a paso

```bash
cd vigia
# 1. Revisa el script y deploy/cors.json.
less deploy/cloudrun.sh
# 2. Sesión y proyecto.
gcloud auth login
# 3. (Opcional) llave de Anthropic y clave del admin elegida por ti.
export ANTHROPIC_API_KEY=...        # o déjala para después
export VIGIA_ADMIN_PASSWORD=...     # o deja que se genere
# 4. Corre. Muestra el plan y pide escribir "si".
bash deploy/cloudrun.sh
# 5. Prueba.
curl -fsS https://vigia-<NÚMERO>.southamerica-west1.run.app/api/status
gcloud secrets versions access latest --secret=vigia-admin-password --project=platanus-515411
# Entra a /login con admin@vigia.local y esa clave (la cuenta se crea en ese primer login).
```

Variantes útiles:

| Qué | Cómo |
|---|---|
| Solo construir y desplegar (sin revisar infraestructura) | `SKIP_INFRA=1 bash deploy/cloudrun.sh` |
| Redesplegar una imagen existente | `SKIP_INFRA=1 IMAGE=<imagen> bash deploy/cloudrun.sh` |
| Sin pregunta (CI) | `CONFIRM=1 bash deploy/cloudrun.sh` |
| Bajar costos | `MIN_INSTANCES=0 CPU=1 MEMORY=1Gi bash deploy/cloudrun.sh` |
| Más instancias | `MAX_INSTANCES=…` (ajusta `DATABASE_POOL_MAX` para no pasar ~50 conexiones de `db-g1-small`) |

Las migraciones de `db/migrations/` se aplican solas al primer uso (con candado de Postgres,
así que varias instancias no chocan). Para desactivarlo: `VIGIA_AUTO_MIGRATE=0`.

## IAM: firmar URLs V4 sin llave, y CORS

El navegador sube la evidencia **directo** a Cloud Storage con una URL firmada V4 (PUT) y la
lee mediante `/api/files/...`, que redirige a una URL firmada de lectura. En Cloud Run no hay
archivo de llave: la biblioteca firma llamando a **IAM `signBlob`** (API `iamcredentials`) con
la identidad del servicio. Por eso la cuenta `vigia-run` necesita:

| Rol | Sobre | Para qué |
|---|---|---|
| `roles/iam.serviceAccountTokenCreator` | **la propia cuenta** `vigia-run` | `signBlob`: firmar URLs V4 sin llave |
| `roles/storage.objectAdmin` | **solo** el bucket `platanus-515411-vigia-evidencia` | leer, escribir y borrar evidencia |
| `roles/cloudsql.client` | el proyecto | conectarse por el conector `/cloudsql/...` |
| `roles/secretmanager.secretAccessor` | cada uno de los 5 secretos | montar los secretos como variables |

Nada más: sin Editor ni Owner.

**CORS:** como la subida la hace el navegador hacia `storage.googleapis.com`, el bucket debe
permitir `PUT`, `GET` y `HEAD` desde el origen de la app (la URL de Cloud Run o tu dominio),
con la cabecera `Content-Type` (la firma la incluye y debe coincidir exactamente). Esa
configuración vive en `deploy/cors.json` y el script la aplica en cada corrida. Para revisarla:
`gcloud storage buckets describe gs://platanus-515411-vigia-evidencia --format="default(cors_config)"`.

## Costos mensuales (aproximado, confírmalo en la calculadora de Google Cloud)

> Cifras **aproximadas** en USD con precios de lista y uso bajo; `southamerica-west1`
> (Santiago) suele costar más que las regiones de EE. UU. **Confírmalo en la
> [calculadora de Google Cloud](https://cloud.google.com/products/calculator)** antes de desplegar.

| Ítem | Supuesto | Aproximado / mes |
|---|---|---|
| **Cloud Run** | 1 instancia siempre encendida, 2 vCPU / 2 GiB, sin throttling de CPU (facturación por instancia) | **USD 100 – 150** |
| Cloud SQL | `db-g1-small` zonal + 10 GB SSD + respaldos | USD 30 – 45 |
| Cloud Storage | decenas de GB de evidencia + descargas | USD 1 – 10 |
| Artifact Registry | imágenes (~0,5 GB c/u; borra las viejas) | USD 0 – 3 |
| Cloud Build | ~10 min por deploy en `E2_HIGHCPU_8` | < USD 1 por deploy |
| Secret Manager | 5 secretos | < USD 1 |
| Anthropic (Claude) | según uso, se cobra aparte en tu cuenta de Anthropic | variable |

**El costo principal es Cloud Run con `--min-instances=1` y `--no-cpu-throttling`**: la
instancia queda encendida las 24 horas con 2 vCPU y 2 GiB, haya o no emergencias. Las
perillas, de mayor a menor efecto:

- `MIN_INSTANCES=0`: se apaga sin tráfico (cuesta casi nada en reposo), a cambio de un
  arranque en frío de varios segundos en el primer reporte.
- `CPU=1 MEMORY=1Gi`: la mitad del costo por hora; la extracción con ffmpeg y la fusión
  serán más lentas.
- Mantener `--no-cpu-throttling`: sin él el análisis de IA en `after()` puede quedar sin CPU
  después de responder.

## Correr local

### Sin credenciales (modo local)

```bash
cd vigia
npm run dev
```

Sin `DATABASE_URL`, `GCS_BUCKET` ni `ANTHROPIC_API_KEY`: datos en `.data/`, acceso abierto
(sesión demo) e IA simulada, rotulada en la interfaz. Copia `.env.example` a `.env.local`
para ver todas las variables.

### Con Postgres en Docker

```bash
docker run -d --name vigia-pg -e POSTGRES_PASSWORD=vigia -e POSTGRES_DB=vigia \
  -p 5432:5432 postgres:17-alpine

# En .env.local (o exportadas en la terminal):
DATABASE_URL=postgresql://postgres:vigia@localhost:5432/vigia
VIGIA_SESSION_SECRET=<salida de: openssl rand -base64 48>
VIGIA_ADMIN_EMAIL=admin@vigia.local
VIGIA_ADMIN_PASSWORD=<al menos 10 caracteres>

npx tsx scripts/db-migrate.mts   # opcional: también se aplican solas al primer uso
npm run dev                      # http://localhost:3000/login
```

Para detenerlo: `docker stop vigia-pg` (y `docker rm vigia-pg` para borrar los datos).

### La imagen de producción en tu máquina

```bash
docker build -t vigia --build-arg NEXT_PUBLIC_APP_URL=http://localhost:8080 .
docker run --rm -p 8080:8080 --add-host=host.docker.internal:host-gateway \
  -e DATABASE_URL=postgresql://postgres:vigia@host.docker.internal:5432/vigia \
  -e VIGIA_SESSION_SECRET="$(openssl rand -base64 48)" \
  -e VIGIA_ADMIN_EMAIL=admin@vigia.local -e VIGIA_ADMIN_PASSWORD=<clave> \
  vigia
```

Sin `-e DATABASE_URL` el contenedor corre en modo local (datos efímeros dentro del contenedor).
`next build` ocupa varios GB de memoria: no lo corras con la máquina cargada.

## Planes B durante la demo

| Falla | Qué hacer |
|---|---|
| Claude lento o caído | Automático: Vigía cae a plantillas en ~30 s y no vuelve a esperar a Claude por 2 min. Un clic: en la ficha, botón «V» → **«Vigía sin IA (plantillas)»** (la fusión y la radio de esa emergencia pasan a reglas; «Volver a usar IA» lo revierte). La barra de la ficha muestra «Vigía sin IA». |
| Puente Zello cortado o expulsado | La barra de la ficha muestra «Zello desconectado / sin señal». Si la cuenta del bot está abierta en otro lado, ciérrala: tras 3 expulsiones en 5 min el puente deja de pelear la conexión. Sin voz, la demo sigue con «V» → **«Demo: dos radios a la vez»**. Reiniciar el puente de la nube: `INSTANCES=0 SKIP_BUILD=1 CONFIRM=1 bash deploy/zello-bridge.sh` y luego `INSTANCES=1 SKIP_BUILD=1 CONFIRM=1 bash deploy/zello-bridge.sh`. No corras `npm run zello` local con el de la nube encendido (el puente local se niega si lo detecta; `--force` lo salta). |
| Cloud SQL no responde | Las consultas fallan en ~10–15 s en vez de colgarse. Pasar a modo local en memoria (sin login, datos efímeros): `gcloud run services update vigia --region southamerica-west1 --remove-secrets=DATABASE_URL --max-instances=1` y en el tablero «Demostración → Cargar incidentes de demostración». Volver: correr `deploy/cloudrun.sh` de nuevo. |
| Se cae el Wi-Fi del evento | Hotspot del teléfono para el notebook de la mesa. Radio y Vigía siguen (corren en la nube). La ficha muestra «Sin conexión · hace N s» mientras no hay red. El público debe usar el QR con código (`/reportar/<código>`), abierto desde la URL pública, no desde localhost. |

## Notas

- La clave del usuario de la base pasa como argumento a `gcloud sql users create/set-password`
  (gcloud no la acepta por stdin); queda visible un instante en la lista de procesos de la
  máquina que corre el script. Todos los demás secretos van por stdin.
- Los secretos se montan como `:latest`: si rotas uno (nueva versión), redespliega
  (`SKIP_INFRA=1 IMAGE=<imagen> bash deploy/cloudrun.sh`) para que las instancias lo lean.
- Para no acumular imágenes, agrega una política de limpieza al repositorio de Artifact Registry.
