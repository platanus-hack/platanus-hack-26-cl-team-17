# Vigía

<img src="./project-logo.png" alt="Logo de Vigía" width="200" />

**Puesto de mando asistido por IA para Bomberos.** Platanus Hack 26: Santiago ft. Buk · team-17 · Track: 🌎 Physical World

- Nicolás Quintana ([@nicopad22](https://github.com/nicopad22))
- Alessandro Queirolo ([@aqm007](https://github.com/aqm007))
- Benjamín Taito ([@benjamintaito](https://github.com/benjamintaito))
- Lucas Cayazzo Cáceres ([@lcayazzo](https://github.com/lcayazzo))
- Agustín Alberto Arévalo Rodríguez ([@HechoEnChile](https://github.com/HechoEnChile))

## El problema

Cuando sale una emergencia, los bomberos van en camino sin saber con qué se van a encontrar: si hay personas atrapadas, dónde está el fuego, qué peligros hay y por dónde entrar.

## Qué hace

- **Vecinos** abren un enlace o un QR, sin crear cuenta, y envían videos o fotos desde el teléfono. El navegador extrae fotogramas y los sube primero; el video original sube después.
- **IA con visión (Claude)** analiza cada medio y fusiona todas las fuentes en un informe de situación: personas atrapadas o posibles, peligros, accesos y un briefing para las unidades en ruta. También arma una reconstrucción espacial esquemática de la escena en 3D.
- **Dron**: se despliega desde el puesto de mando y envía telemetría y cuadros. Hay simulador, un modo sensor con un teléfono y un puente para drones reales (`tools/drone_bridge.py`).
- **Comunicaciones radiales**: bitácora escrita, dictada o importada, cruzada con lo que muestran los videos.
- **Reconstrucción 3D real** con Gaussian Splatting a partir de todos los videos, en un job de Cloud Run con GPU.
- **Briefing en ruta**: vista para la tablet del carro, con lo crítico primero, lectura en voz alta y aviso cuando algo cambia.

Reglas de diseño: la IA apoya y decide el oficial a cargo; la IA nunca descarta víctimas (ausencia de evidencia no es evidencia de ausencia); todo resultado muestra su confianza y nada simulado pasa por real.

## Correr en local

```bash
npm install
npm run dev        # http://localhost:3000
```

Sin credenciales corre en **modo local**: datos en `.data/`, acceso abierto y motor de IA simulado (rotulado en la interfaz). Con `ANTHROPIC_API_KEY` en `.env.local` usa Claude de verdad. Todas las variables están en `.env.example`.

Pruebas: `npm test` · tipos: `npm run typecheck` · lint: `npm run lint`.

## Arquitectura

- Next.js 16 (App Router) + React 19, Tailwind CSS 4, three.js / React Three Fiber, MapLibre GL, Spark (Gaussian splats).
- Google Cloud Run + Cloud SQL (Postgres 17) + Cloud Storage con URLs firmadas. Despliegue: `deploy/cloudrun.sh` (ver `deploy/README.md`).
- Job de GPU para 3D Gaussian Splatting en `gpu/splat/` (Cloud Run, us-central1).
- Datos en vivo por sondeo con un contador de revisión por incidente.

| Ruta | Para quién |
|---|---|
| `/reportar` | Vecinos: enviar un video |
| `/mando` | Puesto de mando: incidentes, mapa y simulacro |
| `/mando/[id]` | Vista de un incidente |
| `/en-ruta/[id]?k=…` | Tablet de la unidad en ruta |
| `/dron/[missionId]` | Teléfono usado como sensor del dron |
