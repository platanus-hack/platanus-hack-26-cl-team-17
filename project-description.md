# Vigía

**Puesto de mando asistido por IA para Bomberos.**

## El problema

Cuando sale una emergencia, los bomberos van en camino sin saber con qué se van a encontrar: si hay personas atrapadas, dónde está el fuego, qué peligros hay y por dónde entrar. Mientras tanto, los vecinos ya están grabando con sus teléfonos.

## La solución

- **Vecinos**: abren un enlace o escanean un QR y envían videos o fotos, sin crear cuenta.
- **IA con visión (Claude)**: analiza cada video y fusiona todas las fuentes en un informe de situación con personas atrapadas o posibles, peligros, accesos y una reconstrucción 3D esquemática de la escena.
- **Dron**: se despliega desde el puesto de mando y envía telemetría y cuadros que entran al mismo análisis.
- **Radio**: la bitácora de comunicaciones se cruza con lo que muestran los videos.
- **Reconstrucción 3D real**: 3D Gaussian Splatting con GPU a partir de todos los videos del incidente.
- **Unidades en ruta**: reciben en la tablet del carro un briefing con lo crítico primero, lectura en voz alta y aviso cuando algo cambia.

## Principios

La IA apoya y decide el oficial a cargo. Nunca descarta víctimas: ausencia de evidencia no es evidencia de ausencia. Todo resultado muestra su confianza y nada simulado pasa por real.

## Tecnología

Next.js 16, React 19, three.js, MapLibre, Claude (visión y salidas estructuradas), Google Cloud Run, Cloud SQL, Cloud Storage y un job de Cloud Run con GPU NVIDIA para Gaussian Splatting.
