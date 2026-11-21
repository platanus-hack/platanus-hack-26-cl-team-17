import type { Metadata, Viewport } from "next";
import { JetBrains_Mono, Outfit } from "next/font/google";
import { ToastProvider } from "@/components/ui/Toast";
import { cn } from "@/lib/cn";
import "./globals.css";

const outfit = Outfit({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-outfit",
  display: "swap",
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-jetbrains-mono",
  display: "swap",
});

/** Metadatos base; cada página define su título con la plantilla "%s · Vigía". */
export const metadata: Metadata = {
  title: {
    default: "Vigía — Puesto de mando asistido por IA",
    template: "%s · Vigía",
  },
  description:
    "Puesto de mando asistido por IA para Bomberos: videos de vecinos, dron y comunicaciones radiales reunidos en una sola lectura del incidente.",
  applicationName: "Vigía",
};

/** Viewport: tema claro y área segura completa en teléfonos con muesca. */
export const viewport: Viewport = {
  themeColor: "#ffffff",
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  colorScheme: "light",
};

/** Layout raíz: fuentes, tema "mando" por defecto y proveedor de avisos (toasts). */
export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="es-CL"
      data-theme="mando"
      className={cn(outfit.variable, jetbrainsMono.variable)}
    >
      <body className="min-h-dvh bg-bg font-sans text-text antialiased">
        <ToastProvider>{children}</ToastProvider>
      </body>
    </html>
  );
}
