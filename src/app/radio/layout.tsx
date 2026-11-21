import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { VecinoShell } from "@/components/shell";

export const metadata: Metadata = {
  title: { absolute: "Radio de demostración — Vigía" },
  description: "Habla por el micrófono como por una radio: cada transmisión entra a la bitácora del incidente.",
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  themeColor: "#fffdf9",
  colorScheme: "light",
};

export default function RadioLayout({ children }: { children: ReactNode }) {
  return <VecinoShell>{children}</VecinoShell>;
}
