"use client";
/**
 * Arrastre con el mouse en el mapa 3D de la ficha: clic izquierdo gira (horizontal) e
 * inclina (vertical) alrededor del centro de la vista, en vez de desplazar el mapa; clic
 * derecho lo desplaza. El tacto queda como viene (un dedo mueve, dos giran).
 *
 * Funciona igual con Mapbox y MapLibre: se intercepta el mousedown sobre el canvas en fase
 * de captura, antes de que llegue a los manejadores del motor. Los marcadores HTML no son
 * el canvas, así que sus clics siguen intactos.
 */
import type { Map as MlMap } from "maplibre-gl";

/** Mismas tasas que el giro nativo con clic derecho. */
const DEG_PER_PX_BEARING = 0.8;
const DEG_PER_PX_PITCH = 0.5;
/** Desde cuántos px de recorrido deja de ser un clic. */
const CLICK_TOLERANCE_PX = 3;

export function enableOrbitDrag(map: MlMap): () => void {
  const container = map.getContainer();
  const canvas = map.getCanvas();
  let drag: { button: number; x: number; y: number; lastX: number; lastY: number; bearing: number; pitch: number; moved: boolean } | null = null;
  let swallowClick = false;

  const onMove = (e: MouseEvent) => {
    if (!drag) return;
    const dx = e.clientX - drag.x;
    const dy = e.clientY - drag.y;
    if (!drag.moved && Math.abs(dx) + Math.abs(dy) < CLICK_TOLERANCE_PX) return;
    drag.moved = true;
    if (drag.button === 0) {
      const maxPitch = map.getMaxPitch();
      const pitch = Math.max(0, Math.min(maxPitch, drag.pitch - dy * DEG_PER_PX_PITCH));
      map.jumpTo({ bearing: drag.bearing + dx * DEG_PER_PX_BEARING, pitch });
    } else {
      map.panBy([drag.lastX - e.clientX, drag.lastY - e.clientY], { duration: 0 });
    }
    drag.lastX = e.clientX;
    drag.lastY = e.clientY;
  };

  const onUp = (e: MouseEvent) => {
    if (!drag || e.button !== drag.button) return;
    // Tras arrastrar, el click que sigue no debe contar como clic en el mapa.
    swallowClick = drag.moved;
    drag = null;
    canvas.style.cursor = "";
    window.removeEventListener("mousemove", onMove);
    window.removeEventListener("mouseup", onUp);
    setTimeout(() => {
      swallowClick = false;
    }, 0);
  };

  const onDown = (e: MouseEvent) => {
    if (e.target !== canvas) return;
    // Shift (zoom por caja) y Ctrl/⌘ (giro nativo) siguen en manos del motor.
    if ((e.button !== 0 && e.button !== 2) || e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) return;
    e.stopPropagation();
    e.preventDefault();
    canvas.focus({ preventScroll: true });
    map.stop();
    const b = map.getBearing();
    const p = map.getPitch();
    drag = { button: e.button, x: e.clientX, y: e.clientY, lastX: e.clientX, lastY: e.clientY, bearing: b, pitch: p, moved: false };
    canvas.style.cursor = e.button === 0 ? "grabbing" : "move";
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  const onClick = (e: MouseEvent) => {
    if (!swallowClick || e.target !== canvas) return;
    swallowClick = false;
    e.stopPropagation();
  };

  const onContextMenu = (e: MouseEvent) => {
    if (e.target === canvas) e.preventDefault();
  };

  container.addEventListener("mousedown", onDown, true);
  container.addEventListener("click", onClick, true);
  container.addEventListener("contextmenu", onContextMenu, true);
  return () => {
    container.removeEventListener("mousedown", onDown, true);
    container.removeEventListener("click", onClick, true);
    container.removeEventListener("contextmenu", onContextMenu, true);
    window.removeEventListener("mousemove", onMove);
    window.removeEventListener("mouseup", onUp);
  };
}
