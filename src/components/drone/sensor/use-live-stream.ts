"use client";

import { useEffect, useRef, useState, type RefObject } from "react";
import { api, ApiClientError } from "@/lib/client/api";
import { scaleToLongEdge } from "@/lib/client/frames-core";
import { LIMITS } from "@/lib/domain";

/**
 * Video en vivo del modo sensor: cuadros chicos (640 px, calidad 0,6) en un ciclo propio,
 * aparte de los cuadros de análisis. Nunca hay dos envíos a la vez: si la red es lenta
 * bajan los cuadros por segundo en vez de acumularse.
 */
export const LIVE_TIMING = {
  /** Intervalo mínimo entre cuadros (~8 por segundo; con red lenta baja solo). */
  everyMs: 125,
  /** Espera tras un error de red antes de volver a intentar. */
  retryMs: 2000,
  timeoutMs: 8000,
} as const;

export type LiveStreamStatus = "off" | "starting" | "live" | "retrying" | "ended";

export interface LiveStreamState {
  status: LiveStreamStatus;
  /** Cuadros por segundo efectivos en los últimos segundos. */
  fps: number;
}

const OFF: LiveStreamState = { status: "off", fps: 0 };

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(t);
      resolve();
    });
  });

function encode(canvas: HTMLCanvasElement, video: HTMLVideoElement): Promise<Blob | null> {
  const size = scaleToLongEdge(video.videoWidth, video.videoHeight, LIMITS.LIVE_FRAME_LONG_EDGE_PX);
  if (!size.width || !size.height) return Promise.resolve(null);
  if (canvas.width !== size.width) canvas.width = size.width;
  if (canvas.height !== size.height) canvas.height = size.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return Promise.resolve(null);
  ctx.drawImage(video, 0, 0, size.width, size.height);
  return new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", LIMITS.LIVE_FRAME_JPEG_QUALITY));
}

export function useLiveStream(opts: {
  active: boolean;
  videoRef: RefObject<HTMLVideoElement | null>;
  cameraReadyRef: RefObject<boolean>;
  missionId: string;
  token: string;
}): LiveStreamState {
  const { active, videoRef, cameraReadyRef, missionId, token } = opts;
  const [state, setState] = useState<LiveStreamState>({ status: "off", fps: 0 });
  const sentAt = useRef<number[]>([]);

  useEffect(() => {
    if (!active) return;
    const ctl = new AbortController();
    const { signal } = ctl;
    const canvas = document.createElement("canvas");
    let status: LiveStreamStatus = "starting";

    // La interfaz se refresca una vez por segundo, no por cada cuadro.
    const publish = () => {
      const now = Date.now();
      sentAt.current = sentAt.current.filter((t) => now - t < 3000);
      setState({ status, fps: Math.round((sentAt.current.length / 3) * 10) / 10 });
    };
    const ui = setInterval(publish, 1000);

    async function loop() {
      while (!signal.aborted) {
        const started = Date.now();
        const video = videoRef.current;
        if (!video || !cameraReadyRef.current || video.readyState < 2) {
          await sleep(500, signal);
          continue;
        }
        let blob: Blob | null = null;
        try {
          blob = await encode(canvas, video);
        } catch {
          blob = null;
        }
        if (!blob) {
          await sleep(500, signal);
          continue;
        }
        const timeout = new AbortController();
        const t = setTimeout(() => timeout.abort(), LIVE_TIMING.timeoutMs);
        const onAbort = () => timeout.abort();
        signal.addEventListener("abort", onAbort);
        try {
          await api.drone.live(missionId, token, blob, { signal: timeout.signal });
          status = "live";
          sentAt.current.push(Date.now());
        } catch (err) {
          if (signal.aborted) break;
          // Token inválido o misión terminada: el video no se reanuda.
          if (err instanceof ApiClientError && (err.status === 401 || err.status === 404 || err.status === 409)) {
            status = "ended";
            break;
          }
          status = "retrying";
          await sleep(LIVE_TIMING.retryMs, signal);
          continue;
        } finally {
          clearTimeout(t);
          signal.removeEventListener("abort", onAbort);
        }
        await sleep(Math.max(0, LIVE_TIMING.everyMs - (Date.now() - started)), signal);
      }
      publish();
    }
    void loop();

    return () => {
      ctl.abort();
      clearInterval(ui);
      canvas.width = 0;
      canvas.height = 0;
    };
  }, [active, videoRef, cameraReadyRef, missionId, token]);

  return active ? state : OFF;
}
