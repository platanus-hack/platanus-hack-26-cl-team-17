# Video: el dron llega a la emergencia

Animación de 38 s (1920×1080, 30 fps) del simulacro de Av. Independencia 1350 (`src/lib/demo/data-scenario.ts`, datos ficticios):

1. Plano general del incendio con los aportes de vecinos (M1, M2) y la persona en el balcón.
2. El Segundo Comandante pide el dron; D1 despega desde el puesto de mando con telemetría en vivo.
3. Entra en la órbita de 50 m a 40 m de altura.
4. Cámara del dron (230° → 330°): detecciones ancladas a la escena y lote M3 de 5 cuadros enviado a Vigía.
5. Los hallazgos del dron se suman al informe de situación junto a vecinos y radio; se avisa el briefing a las unidades en ruta.
6. Cierre con la marca.

```bash
node tools/video-dron/render.mjs                     # → tools/video-dron/out/vigia-dron.mp4
node tools/video-dron/render.mjs --stills 3,12,20,29  # cuadros sueltos para revisar
node tools/video-dron/render.mjs --serve              # vista en vivo: http://localhost:8767/?play (&t=20 para saltar)
```

Requiere `ffmpeg` y el Playwright de `node_modules`. La escena está entera en `index.html` (three.js de `node_modules`); `window.renderAt(t)` dibuja el instante `t` de forma determinista. `out/` no se versiona.
