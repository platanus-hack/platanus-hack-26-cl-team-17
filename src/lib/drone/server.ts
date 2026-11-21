/**
 * Dependencias reales para las rutas del dron. Solo servidor.
 */
import { after } from "next/server";
import { processMedia } from "@/lib/ai/pipeline";
import { getFiles, getStore } from "@/lib/store";
import type { DroneDeps } from "./service";

export function droneDeps(): DroneDeps {
  return {
    store: getStore(),
    files: getFiles(),
    now: Date.now,
    defer: (task) => after(task),
    processMedia: (id) => processMedia(id),
  };
}
