# Vigilia

**La emergencia, vista antes de llegar.** Puesto de mando asistido por IA para Bomberos.

## El problema

Cuando sale una emergencia, los bomberos van en camino sin saber con qué se van a encontrar: si hay personas atrapadas, dónde está el fuego, qué peligros hay y por dónde entrar. Mientras tanto, los vecinos ya están grabando con sus teléfonos y la radio se llena de información que nadie alcanza a cruzar.

## La solución

Vigilia suma al puesto de mando a **Vigía**, un agente de IA que trabaja como un integrante más: mira y escucha todo para que el oficial a cargo (OBAC) pueda concentrarse en decidir.

- **Vecinos**: escanean un QR o abren un enlace y envían videos o fotos, sin crear cuenta. Vigía les puede pedir más videos de un lado de la casa.
- **Dron**: el video en vivo de un dron DJI llega al puesto de mando con cajas de YOLO (personas, bomberos, fuego, humo, gas, cables) y una mirada de Claude cada pocos segundos. Mientras vuela se arma la escena en 3D en vivo: una nube de puntos y, encima, Gaussian splats.
- **Radio**: Vigía escucha el canal de Zello de todas las compañías, transcribe cada transmisión y la cruza con lo que muestran los videos.
- **El agente**: cada 2 segundos revisa si hay algo nuevo, cruza las fuentes y actualiza la ficha. Cuando importa (posible persona en riesgo, un riesgo nuevo o una contradicción entre la radio y la imagen), avisa por radio con voz. Si el OBAC le pregunta por Zello, responde en unos 4 segundos.
- **La ficha del oficial**: mapa 3D con la casa, el piso del foco, humo, zonas de peligro y unidades; personas, riesgos y lo que dice Vigía, legible en tres segundos desde tres metros. Suma un esquema técnico de la escena y una reconstrucción 3D con Gaussian Splatting a partir de todos los videos.
- **Unidades en ruta**: reciben en la tablet del carro un briefing con lo crítico primero, lectura en voz alta y aviso cuando algo cambia.

## Reglas de la IA

Son reglas duras: el agente no puede saltárselas y el código las hace cumplir.

1. **Informa, no decide.** No da órdenes a las unidades ni dice por dónde entrar o si es seguro. Si algo hay que transmitir, lo propone y el OBAC decide.
2. **Confianza en cada dato**: alta, media o baja, siempre a la vista.
3. **Cita su fuente**: cada hallazgo dice si sale del video M1, la radio C5 o el dron D1.
4. **«No se ve» no es «no hay»**: sin evidencia no descarta víctimas.
5. **Habla poco**: un mensaje por radio cada ~20 s, salvo que haya una persona en riesgo.
6. **Nada simulado pasa por real**: sin IA configurada funciona igual, y todo queda rotulado como simulado.

## Tecnología

Claude (visión y agente con herramientas), YOLOE-26 + pose en CPU, VGGT en GPU para el 3D en vivo, 3D Gaussian Splatting en un job de Cloud Run con GPU, Zello Channel API, ElevenLabs (transcripción y voz), Next.js 16 + React 19 + three.js + MapLibre en Cloud Run, Cloud SQL (Postgres) y Cloud Storage.
