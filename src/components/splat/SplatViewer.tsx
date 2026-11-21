"use client";

/**
 * Visor de Gaussian splats (three.js + Spark). Solo navegador: three y Spark se
 * cargan con import() dentro del efecto.
 *
 * Coordenadas: `transform` (16 números, fila por fila) lleva el archivo a ENU local
 * (x Este, y Norte, z arriba, metros, origen en el incidente); luego ENU → three:
 * three.x = Este, three.y = altura, three.z = −Norte. Sin transform se muestra tal
 * cual (convención habitual de 3DGS) y sin norte ni origen, porque no significan nada.
 */
import { useEffect, useRef, useState } from "react";
import { AlertTriangle, Crosshair, MonitorX } from "lucide-react";
import { cn } from "@/lib/cn";
import { formatBytes, formatNumber } from "@/lib/format";
import { Button, ProgressBar, Spinner } from "@/components/ui";

export interface SplatViewerProps {
  /** URL del archivo .splat (normalmente /api/files/<splat_path>). */
  url: string;
  /** Archivo → ENU local (fila por fila); null = sin alinear. */
  transform: number[] | null;
  /** Muestra la grilla en metros (si la escala es conocida o estimada) o en unidades del archivo. */
  scaleKnown: boolean;
  className?: string;
}

type ViewerState =
  | { phase: "loading"; loaded: number; total: number | null }
  | { phase: "preparing" }
  | { phase: "ready"; splats: number }
  | { phase: "nowebgl" }
  | { phase: "error"; message: string };

export function hasWebGL2(): boolean {
  try {
    const c = document.createElement("canvas");
    const gl = c.getContext("webgl2");
    const ok = Boolean(gl);
    gl?.getExtension("WEBGL_lose_context")?.loseContext();
    return ok;
  } catch {
    return false;
  }
}

/** Resuelve un color de tema (var CSS, también oklch) a "#rrggbb" usando un canvas 2D. */
function themeColor(host: Element, cssVar: string, fallback: string): string {
  try {
    const raw = getComputedStyle(host).getPropertyValue(cssVar).trim();
    if (!raw) return fallback;
    const ctx = document.createElement("canvas").getContext("2d");
    if (!ctx) return fallback;
    ctx.fillStyle = fallback;
    ctx.fillStyle = raw;
    ctx.fillRect(0, 0, 1, 1);
    const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
    return `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
  } catch {
    return fallback;
  }
}

class HttpFetchError extends Error {
  constructor(public status: number) {
    super(`HTTP ${status}`);
  }
}

async function fetchBytes(
  url: string,
  signal: AbortSignal,
  onProgress: (loaded: number, total: number | null) => void,
): Promise<Uint8Array> {
  const res = await fetch(url, { signal, credentials: "same-origin", cache: "default" });
  if (!res.ok) throw new HttpFetchError(res.status);
  const totalHeader = Number(res.headers.get("content-length"));
  const total = Number.isFinite(totalHeader) && totalHeader > 0 ? totalHeader : null;
  if (!res.body) return new Uint8Array(await res.arrayBuffer());
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  let lastReport = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.length;
    if (loaded - lastReport > 256 * 1024) {
      lastReport = loaded;
      onProgress(loaded, total);
    }
  }
  const out = new Uint8Array(loaded);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

function describeError(err: unknown): string {
  if (err instanceof HttpFetchError) {
    if (err.status === 401) return "Tu sesión expiró: vuelve a iniciar sesión para ver la reconstrucción.";
    if (err.status === 403) return "No tienes acceso a este archivo.";
    if (err.status === 404) return "No se encontró el archivo de la reconstrucción.";
    return `No se pudo descargar la reconstrucción (${err.message}).`;
  }
  if (err instanceof Error && /webgl/i.test(err.message)) {
    return "Tu navegador no pudo iniciar WebGL2 para dibujar la reconstrucción.";
  }
  return "No se pudo abrir la reconstrucción 3D. Recarga la página para intentarlo de nuevo.";
}

/** Percentil sobre valores ya ordenados. */
const pct = (sorted: number[], p: number) =>
  sorted.length ? sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(p * (sorted.length - 1))))] : 0;

/** Cambiar de archivo o de transform reinicia el visor desde cero (estado y WebGL). */
export function SplatViewer(props: SplatViewerProps) {
  return <SplatViewerInner key={`${props.url}|${props.transform?.join(",") ?? ""}`} {...props} />;
}

function SplatViewerInner({ url, transform, scaleKnown, className }: SplatViewerProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const compassRef = useRef<HTMLDivElement>(null);
  const resetRef = useRef<(() => void) | null>(null);
  const [state, setState] = useState<ViewerState>({ phase: "loading", loaded: 0, total: null });
  const [cellM, setCellM] = useState<number | null>(null);
  const aligned = transform !== null;
  const transformKey = transform ? transform.join(",") : "";

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let disposed = false;
    const abort = new AbortController();
    const cleanups: (() => void)[] = [];
    const matrixRows = transformKey ? transformKey.split(",").map(Number) : null;

    (async () => {
      if (!hasWebGL2()) {
        setState({ phase: "nowebgl" });
        return;
      }
      const [THREE, spark, { OrbitControls }] = await Promise.all([
        import("three"),
        import("@sparkjsdev/spark"),
        import("three/examples/jsm/controls/OrbitControls.js"),
      ]);
      const bytes = await fetchBytes(url, abort.signal, (loaded, total) => {
        if (!disposed) setState({ phase: "loading", loaded, total });
      });
      if (disposed) return;
      setState({ phase: "preparing" });

      const colors = {
        bg: themeColor(host, "--color-bg", "#0a0e13"),
        line: themeColor(host, "--color-line", "#223040"),
        lineStrong: themeColor(host, "--color-line-strong", "#33465c"),
        accent: themeColor(host, "--color-accent", "#ff6a47"),
        info: themeColor(host, "--color-info", "#48b8ff"),
        text: themeColor(host, "--color-text", "#e8eef4"),
      };

      const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: "high-performance" });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      renderer.setClearColor(colors.bg);
      const size = () => ({ w: Math.max(1, host.clientWidth), h: Math.max(1, host.clientHeight) });
      renderer.setSize(size().w, size().h);
      renderer.domElement.className = "block h-full w-full outline-none";
      renderer.domElement.setAttribute("aria-hidden", "true");
      host.appendChild(renderer.domElement);
      cleanups.push(() => {
        renderer.setAnimationLoop(null);
        renderer.dispose();
        renderer.domElement.remove();
      });

      const scene = new THREE.Scene();
      const camera = new THREE.PerspectiveCamera(50, size().w / size().h, 0.1, 10_000);
      const sparkRenderer = new spark.SparkRenderer({ renderer });
      scene.add(sparkRenderer);
      cleanups.push(() => sparkRenderer.dispose());

      const mesh = new spark.SplatMesh({ fileBytes: bytes, fileType: spark.SplatFileType.SPLAT });
      cleanups.push(() => mesh.dispose());
      await mesh.initialized;
      if (disposed) return;

      // Archivo → ENU (transform) → three. Sin transform: giro de 180° en X (cámaras OpenCV).
      const enuToThree = new THREE.Matrix4().set(1, 0, 0, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1);
      const world = new THREE.Matrix4();
      if (matrixRows && matrixRows.length === 16 && matrixRows.every(Number.isFinite)) {
        const t = new THREE.Matrix4();
        t.set(...(matrixRows as [number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number]));
        world.multiplyMatrices(enuToThree, t);
      } else {
        world.makeRotationX(Math.PI);
      }
      world.decompose(mesh.position, mesh.quaternion, mesh.scale);
      scene.add(mesh);
      mesh.updateMatrixWorld(true);

      // Límites robustos (percentiles 2–98): los "flotadores" de 3DGS no deben alejar la cámara.
      const total = mesh.packedSplats?.numSplats ?? mesh.numSplats;
      const stride = Math.max(1, Math.floor(total / 20_000));
      const xs: number[] = [];
      const ys: number[] = [];
      const zs: number[] = [];
      const p = new THREE.Vector3();
      let count = 0;
      mesh.forEachSplat((i, center, _s, _q, opacity) => {
        count++;
        if (i % stride !== 0 || opacity < 0.1) return;
        p.copy(center).applyMatrix4(mesh.matrixWorld);
        xs.push(p.x);
        ys.push(p.y);
        zs.push(p.z);
      });
      for (const arr of [xs, ys, zs]) arr.sort((a, b) => a - b);
      const lo = new THREE.Vector3(pct(xs, 0.02), pct(ys, 0.02), pct(zs, 0.02));
      const hi = new THREE.Vector3(pct(xs, 0.98), pct(ys, 0.98), pct(zs, 0.98));
      const center = lo.clone().add(hi).multiplyScalar(0.5);
      const span = Math.max(4, hi.x - lo.x, hi.z - lo.z);
      const groundY = aligned ? 0 : lo.y;

      const disposables: { dispose(): void }[] = [];
      cleanups.push(() => disposables.forEach((d) => d.dispose()));

      // Grilla de suelo: centrada en el origen del incidente si está alineada.
      const cell = span > 160 ? 10 : span > 40 ? 5 : 1;
      const reach = aligned
        ? Math.max(Math.abs(lo.x), Math.abs(hi.x), Math.abs(lo.z), Math.abs(hi.z))
        : span / 2;
      const gridSize = Math.max(cell * 8, Math.ceil((reach * 2.2) / (cell * 2)) * cell * 2);
      const grid = new THREE.GridHelper(gridSize, Math.round(gridSize / cell), colors.lineStrong, colors.line);
      grid.position.set(aligned ? 0 : center.x, groundY + 0.06, aligned ? 0 : center.z);
      scene.add(grid);
      disposables.push(grid.geometry, grid.material);
      if (!disposed) setCellM(cell);

      if (aligned) {
        // Norte: flecha plana en el borde norte de la grilla (−Z) y la letra N.
        const arrowLen = Math.max(2, gridSize * 0.06);
        const shape = new THREE.Shape();
        shape.moveTo(0, arrowLen);
        shape.lineTo(arrowLen * 0.45, 0);
        shape.lineTo(0, arrowLen * 0.25);
        shape.lineTo(-arrowLen * 0.45, 0);
        shape.closePath();
        const arrowGeo = new THREE.ShapeGeometry(shape);
        const arrowMat = new THREE.MeshBasicMaterial({ color: colors.info, side: THREE.DoubleSide });
        const arrow = new THREE.Mesh(arrowGeo, arrowMat);
        arrow.rotation.x = -Math.PI / 2;
        arrow.position.set(0, groundY + 0.1, -gridSize / 2 - arrowLen * 0.2);
        scene.add(arrow);
        disposables.push(arrowGeo, arrowMat);

        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = 128;
        const ctx = canvas.getContext("2d");
        if (ctx) {
          ctx.fillStyle = colors.info;
          ctx.font = "bold 96px 'Barlow Condensed', system-ui, sans-serif";
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.fillText("N", 64, 70);
        }
        const tex = new THREE.CanvasTexture(canvas);
        const spriteMat = new THREE.SpriteMaterial({ map: tex, transparent: true });
        const label = new THREE.Sprite(spriteMat);
        label.scale.setScalar(arrowLen * 1.1);
        label.position.set(0, groundY + arrowLen * 0.7, -gridSize / 2 - arrowLen * 1.6);
        scene.add(label);
        disposables.push(tex, spriteMat);

        // Origen del incidente: anillo en el suelo y un poste con esfera.
        const ringR = Math.max(0.8, span * 0.015);
        const ringGeo = new THREE.RingGeometry(ringR, ringR * 1.5, 48);
        const accentMat = new THREE.MeshBasicMaterial({ color: colors.accent, side: THREE.DoubleSide });
        const ring = new THREE.Mesh(ringGeo, accentMat);
        ring.rotation.x = -Math.PI / 2;
        ring.position.set(0, groundY + 0.12, 0);
        scene.add(ring);
        const poleH = Math.min(30, Math.max(6, span * 0.12));
        const poleGeo = new THREE.CylinderGeometry(ringR * 0.08, ringR * 0.08, poleH, 8);
        const pole = new THREE.Mesh(poleGeo, accentMat);
        pole.position.set(0, groundY + poleH / 2, 0);
        scene.add(pole);
        const knobGeo = new THREE.SphereGeometry(ringR * 0.45, 16, 12);
        const knob = new THREE.Mesh(knobGeo, accentMat);
        knob.position.set(0, groundY + poleH, 0);
        scene.add(knob);
        disposables.push(ringGeo, accentMat, poleGeo, knobGeo);
      }

      // Cámara inicial: desde el sureste, elevada (en three: +X Este, +Y arriba, +Z Sur).
      const target = new THREE.Vector3(center.x, groundY + Math.min(4, (hi.y - groundY) * 0.25), center.z);
      const { w, h } = size();
      const fit = Math.max(20, span * 1.05) / Math.pow(Math.min(1, w / h), 0.7);
      const startPos = target.clone().add(new THREE.Vector3(0.5, 0.62, 0.8).normalize().multiplyScalar(fit));
      camera.position.copy(startPos);
      camera.far = Math.max(1000, fit * 20);
      camera.updateProjectionMatrix();

      const controls = new OrbitControls(camera, renderer.domElement);
      controls.target.copy(target);
      controls.enableDamping = true;
      controls.dampingFactor = 0.08;
      controls.screenSpacePanning = true;
      controls.minDistance = 1;
      controls.maxDistance = fit * 5;
      if (aligned) controls.maxPolarAngle = Math.PI / 2 - 0.03;
      controls.update();
      cleanups.push(() => controls.dispose());
      resetRef.current = () => {
        camera.position.copy(startPos);
        controls.target.copy(target);
        controls.update();
      };
      cleanups.push(() => {
        resetRef.current = null;
      });

      let lastAzimuth = Number.NaN;
      let visible = true;
      const frame = () => {
        if (!visible) return;
        controls.update();
        renderer.render(scene, camera);
        const az = (controls.getAzimuthalAngle() * 180) / Math.PI;
        if (compassRef.current && Math.abs(az - lastAzimuth) > 0.3) {
          lastAzimuth = az;
          compassRef.current.style.transform = `rotate(${az.toFixed(1)}deg)`;
        }
      };
      renderer.setAnimationLoop(frame);

      const ro = new ResizeObserver(() => {
        const s = size();
        renderer.setSize(s.w, s.h);
        camera.aspect = s.w / s.h;
        camera.updateProjectionMatrix();
      });
      ro.observe(host);
      cleanups.push(() => ro.disconnect());

      // Sin dibujar mientras no se ve (pestaña oculta o fuera de pantalla): ahorra batería.
      const io = new IntersectionObserver((entries) => {
        visible = entries.some((e) => e.isIntersecting);
      });
      io.observe(host);
      cleanups.push(() => io.disconnect());

      if (!disposed) setState({ phase: "ready", splats: count });
    })().catch((err: unknown) => {
      if (disposed || (err instanceof DOMException && err.name === "AbortError")) return;
      console.error("[splat] visor:", err);
      setState({ phase: "error", message: describeError(err) });
    });

    return () => {
      disposed = true;
      abort.abort();
      for (const c of cleanups.reverse()) {
        try {
          c();
        } catch {
          /* liberar recursos de WebGL no debe romper el desmontaje */
        }
      }
    };
  }, [url, transformKey, aligned]);

  return (
    <div className={cn("relative isolate overflow-hidden rounded-md border border-line bg-bg", className)}>
      <div ref={hostRef} className="absolute inset-0" />

      {state.phase === "ready" && (
        <>
          {aligned && (
            <div
              className="pointer-events-none absolute right-2 top-2 flex size-11 items-center justify-center rounded-full border border-line bg-surface/85"
              role="img"
              aria-label="Indicador de norte"
            >
              <div ref={compassRef} className="relative size-9">
                <span className="absolute left-1/2 top-0 -translate-x-1/2 font-display text-[11px] font-bold leading-none text-info">
                  N
                </span>
                <span className="absolute left-1/2 top-3 h-3 w-0.5 -translate-x-1/2 rounded bg-info" />
                <span className="absolute left-1/2 top-6 h-2 w-0.5 -translate-x-1/2 rounded bg-muted" />
              </div>
            </div>
          )}
          <div className="pointer-events-none absolute bottom-2 left-2 right-12 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted">
            <span className="rounded bg-surface/85 px-1.5 py-0.5">
              {formatNumber(state.splats)} gaussianas
              {cellM !== null && ` · grilla ${cellM} ${scaleKnown ? "m" : aligned ? "m (aprox.)" : "unidades"}`}
            </span>
            {aligned && (
              <span className="inline-flex items-center gap-1 rounded bg-surface/85 px-1.5 py-0.5">
                <span aria-hidden className="size-2 rounded-full bg-accent" /> Origen del incidente
              </span>
            )}
            <span className="hidden rounded bg-surface/85 px-1.5 py-0.5 sm:inline">
              Arrastra para orbitar · rueda o pellizca para acercar · clic derecho para desplazar
            </span>
          </div>
          <div className="absolute bottom-2 right-2">
            <Button
              size="sm"
              variant="secondary"
              icon={Crosshair}
              onClick={() => resetRef.current?.()}
              aria-label="Volver a la vista inicial"
              title="Volver a la vista inicial"
              className="px-2"
            />
          </div>
        </>
      )}

      {(state.phase === "loading" || state.phase === "preparing") && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 p-6 text-center">
          <Spinner size="md" label="Cargando reconstrucción" />
          <p className="text-sm text-muted">
            {state.phase === "preparing"
              ? "Preparando la vista 3D…"
              : `Descargando la reconstrucción${state.loaded > 0 ? ` (${formatBytes(state.loaded)}${state.total ? ` de ${formatBytes(state.total)}` : ""})` : "…"}`}
          </p>
          {state.phase === "loading" && state.total !== null && (
            <ProgressBar value={state.loaded / state.total} className="w-48" label="Descarga" />
          )}
        </div>
      )}

      {state.phase === "nowebgl" && (
        <div role="alert" className="absolute inset-0 flex flex-col items-center justify-center gap-2 p-6 text-center">
          <MonitorX aria-hidden className="size-8 text-warning" />
          <p className="font-display text-lg font-semibold text-text">Este navegador no puede mostrar la vista 3D</p>
          <p className="max-w-sm text-sm text-muted">
            Necesita WebGL2. Prueba con Chrome, Edge, Firefox o Safari actualizados, o activa la aceleración por
            hardware.
          </p>
        </div>
      )}

      {state.phase === "error" && (
        <div role="alert" className="absolute inset-0 flex flex-col items-center justify-center gap-2 p-6 text-center">
          <AlertTriangle aria-hidden className="size-8 text-critical" />
          <p className="font-display text-lg font-semibold text-text">No se pudo mostrar la reconstrucción</p>
          <p className="max-w-sm text-sm text-muted">{state.message}</p>
        </div>
      )}
    </div>
  );
}
