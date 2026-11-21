/**
 * Texturas y geometrías compartidas, generadas en el navegador (sin recursos de red).
 * Se crean una sola vez por página y no se liberan: son pocas y pequeñas.
 */
import * as THREE from "three";

let glow: THREE.CanvasTexture | null = null;

/** Degradado radial blanco → transparente (resplandor del fuego). */
export function glowTexture(): THREE.CanvasTexture {
  if (glow) return glow;
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const g = c.getContext("2d");
  if (g) {
    const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
    grad.addColorStop(0, "rgba(255,255,255,1)");
    grad.addColorStop(0.22, "rgba(255,255,255,0.75)");
    grad.addColorStop(0.55, "rgba(255,255,255,0.22)");
    grad.addColorStop(1, "rgba(255,255,255,0)");
    g.fillStyle = grad;
    g.fillRect(0, 0, 128, 128);
  }
  glow = new THREE.CanvasTexture(c);
  glow.colorSpace = THREE.SRGBColorSpace;
  return glow;
}

const hatches = new Map<string, THREE.CanvasTexture>();

/** Rayado diagonal (calles bloqueadas), repetible. */
export function hatchTexture(color: string): THREE.CanvasTexture {
  const hit = hatches.get(color);
  if (hit) return hit;
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const g = c.getContext("2d");
  if (g) {
    g.clearRect(0, 0, 64, 64);
    g.strokeStyle = color;
    g.lineWidth = 6;
    g.lineCap = "square";
    for (let k = -64; k <= 128; k += 32) {
      g.beginPath();
      g.moveTo(k, 64);
      g.lineTo(k + 64, 0);
      g.stroke();
    }
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 4;
  hatches.set(color, t);
  return t;
}

let flameGeo: THREE.ConeGeometry | null = null;

/** Cono unitario (radio 1, alto 1) con la base en y = 0: lengua de fuego. */
export function flameGeometry(): THREE.ConeGeometry {
  if (flameGeo) return flameGeo;
  flameGeo = new THREE.ConeGeometry(1, 1, 7, 1, true);
  flameGeo.translate(0, 0.5, 0);
  return flameGeo;
}

/** Puntos de una circunferencia horizontal (three.js) de radio r alrededor de (x, z). */
export function circlePoints(r: number, x = 0, y = 0, z = 0, segments = 64): [number, number, number][] {
  const out: [number, number, number][] = [];
  for (let i = 0; i <= segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    out.push([x + Math.cos(a) * r, y, z + Math.sin(a) * r]);
  }
  return out;
}
