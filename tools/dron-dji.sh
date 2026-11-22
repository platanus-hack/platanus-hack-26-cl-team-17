#!/usr/bin/env bash
# Video en vivo de DJI Fly → Vigía, en un solo comando (desde vigia/):
#
#   tools/dron-dji.sh                         # Cloud Run, emergencia abierta más nueva
#   tools/dron-dji.sh --incident VG-XXXX      # solo esa emergencia
#   tools/dron-dji.sh http://localhost:3000   # otro Vigía (las opciones van después)
#
# 1. Levanta MediaMTX (servidor RTMP, en Docker) si no está corriendo: DJI Fly le transmite a él.
# 2. Corre el puente en modo automático: lee el video de MediaMTX y lo manda a la emergencia
#    abierta más nueva (pide el correo y la contraseña del puesto de mando, o usa
#    VIGIA_EMAIL / VIGIA_PASSWORD).
# Ctrl+C detiene el puente; MediaMTX sigue corriendo (docker stop vigia-mediamtx lo apaga).
set -euo pipefail

URL="${VIGIA_URL:-https://vigia-hrbozo3p6q-tl.a.run.app}"
if [ $# -gt 0 ] && [ "${1#-}" = "$1" ]; then URL="$1"; shift; fi
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ -z "$(docker ps -q --filter name=^vigia-mediamtx$)" ]; then
  echo "Levantando MediaMTX (servidor RTMP en el puerto 1935)…"
  docker rm -f vigia-mediamtx >/dev/null 2>&1 || true
  docker run -d --rm --name vigia-mediamtx --network=host bluenviron/mediamtx:1 >/dev/null
  sleep 2
fi

IP="$(ip route get 1.1.1.1 2>/dev/null | awk '{for (i = 1; i < NF; i++) if ($i == "src") print $(i + 1)}')"
echo
echo "  En DJI Fly (Transmisión en vivo → RTMP) pon:   rtmp://${IP:-<IP-de-este-notebook>}:1935/live/dron"
echo "  Video hacia: $URL"
echo

exec python3 "$HERE/drone_bridge.py" --url "$URL" --stream rtsp://127.0.0.1:8554/live/dron "$@"
