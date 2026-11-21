/**
 * Envío de reportes de vecinos (y del mando con `asResponder`): fotogramas primero para que
 * el análisis empiece cuanto antes y después el video original con progreso real.
 * Importable en SSR: nada toca `window`/`document` hasta que se llama a una función.
 */
import { api } from "@/lib/client/api";
import { extractVideoFrames, imageToFrame, FrameExtractionError } from "@/lib/client/frames";
import {
  runSubmitReport,
  putToTarget,
  type SubmitReportDeps,
  type SubmitReportOptions,
  type SubmitReportResult,
} from "@/lib/client/upload-core";

export {
  putToTarget,
  backoffDelay,
  isRetryableStatus,
  overallFraction,
  mapWithConcurrency,
  stageMessage,
  normalizeHeading,
  cleanNote,
  guessMime,
  videoExtension,
  bodyForTarget,
  isCrossOrigin,
  uploadErrorFor,
  isAbortError,
  isFileReadable,
  SubmitReportError,
  isSubmitReportError,
} from "@/lib/client/upload-core";
export type {
  UploadStage,
  UploadProgress,
  ReportPosition,
  FramesUploadedInfo,
  SubmitReportOptions,
  SubmitReportResult,
  SubmitReportErrorCode,
  VideoOutcome,
  PutOptions,
} from "@/lib/client/upload-core";

const deps: SubmitReportDeps = {
  extractVideoFrames: async (file, opts) => {
    const res = await extractVideoFrames(file, opts);
    return {
      frames: res.frames.map((f) => ({
        idx: f.idx,
        t_s: f.t_s,
        blob: f.blob,
        width: f.width,
        height: f.height,
      })),
      duration_s: res.duration_s,
      width: res.width,
      height: res.height,
    };
  },
  imageToFrame: (file, signal) => imageToFrame(file, { signal }),
  extractionErrorCode: (err) => (err instanceof FrameExtractionError ? String(err.code) : null),
  createReport: (body, signal) => api.public.createReport(body, { signal }),
  completeReport: (mediaId, token, body, signal) =>
    api.public.completeReport(mediaId, token, body, { signal }),
  putToTarget,
};

/**
 * Envía un reporte completo:
 * (1) fotogramas del video o fotos convertidas; (2) registro; (3) PUT de fotogramas (3 en paralelo,
 * con reintentos); (4) aviso "frames" → empieza el análisis y se llama a `onFramesUploaded`;
 * (5) video original con progreso real; (6) aviso "video".
 * Lanza `SubmitReportError` (mensaje en español + etapa) si el reporte no llegó.
 * Si solo falla el video tras enviar los fotogramas, no lanza: `result.video === "failed"`.
 */
export function submitReport(opts: SubmitReportOptions): Promise<SubmitReportResult> {
  return runSubmitReport(opts, deps);
}
