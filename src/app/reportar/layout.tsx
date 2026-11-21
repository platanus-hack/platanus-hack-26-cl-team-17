import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { VecinoShell } from "@/components/shell";

export const metadata: Metadata = {
  title: { absolute: "Enviar video a Bomberos — Vigía" },
  description:
    "Envía a Bomberos un video o fotos de la emergencia desde tu teléfono, sin crear cuenta.",
};

/** Tema claro: la barra del navegador acompaña el fondo de las pantallas de vecinos. */
export const viewport: Viewport = {
  themeColor: "#fffdf9",
  colorScheme: "light",
};

export default function ReportarLayout({ children }: { children: ReactNode }) {
  return <VecinoShell>{children}</VecinoShell>;
}
