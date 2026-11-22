"use client";
/**
 * Barra de navegación de la portada: una píldora flotante blanca translúcida (deja ver la
 * foto detrás), separada del borde superior. Al bajar se vuelve un poco más opaca.
 * En teléfono, las secciones van en un menú desplegable.
 */
import { useEffect, useState } from "react";
import Link from "next/link";
import { Menu, MonitorDot, Video, X } from "lucide-react";
import { Wordmark } from "@/components/brand/Wordmark";
import { ThemeToggle } from "@/components/ui/ThemeToggle";
import { cn } from "@/lib/cn";

const SECTIONS = [
  { href: "#ficha", label: "La ficha" },
  { href: "#reglas", label: "Reglas de la IA" },
  { href: "#tecnologia", label: "Tecnología" },
];

export function LandingHeader() {
  const [scrolled, setScrolled] = useState(false);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const update = () => setScrolled(window.scrollY > 24);
    update();
    window.addEventListener("scroll", update, { passive: true });
    return () => window.removeEventListener("scroll", update);
  }, []);

  return (
    <header className="fixed inset-x-0 top-0 z-40 px-3 pt-3 sm:px-6 sm:pt-4">
      <nav
        aria-label="Principal"
        className={cn(
          "mx-auto flex h-12 w-full max-w-6xl items-center gap-3 rounded-full sm:h-14 border border-line/60 pr-1.5 pl-4 backdrop-blur-xl sm:pr-2 sm:pl-5 transition-[background-color,box-shadow] duration-300",
          scrolled ? "bg-surface/85 shadow-[0_8px_30px_rgb(21_26_33/0.14)]" : "bg-surface/70 shadow-[0_8px_30px_rgb(21_26_33/0.25)]",
        )}
      >
        <Wordmark size="sm" href="/" />

        <ul className="mx-auto hidden items-center gap-1 md:flex">
          {SECTIONS.map((s) => (
            <li key={s.href}>
              <a
                href={s.href}
                className="rounded-full px-3.5 py-2 text-[15px] font-medium text-muted transition-colors hover:bg-surface-2 hover:text-text"
              >
                {s.label}
              </a>
            </li>
          ))}
        </ul>

        <div className="ml-auto flex items-center gap-1.5 md:ml-0">
          <Link
            href="/reportar"
            className="hidden h-10 items-center gap-1.5 rounded-full px-4 text-[14px] font-bold text-text transition-colors hover:bg-surface-2 sm:inline-flex"
          >
            <Video className="size-4" aria-hidden="true" />
            Soy vecino
          </Link>
          <ThemeToggle />
          <Link
            href="/mando"
            className="inline-flex h-9 items-center gap-1.5 rounded-full bg-primary px-3.5 text-[13px] font-bold text-on-primary transition-colors hover:bg-primary/85 sm:h-10 sm:px-4 sm:text-[14px]"
          >
            <MonitorDot className="size-4" aria-hidden="true" />
            Puesto de mando
          </Link>
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            aria-label={open ? "Cerrar menú" : "Abrir menú"}
            className="grid size-9 place-items-center rounded-full text-text hover:bg-surface-2 sm:size-10 md:hidden"
          >
            {open ? <X className="size-5" aria-hidden="true" /> : <Menu className="size-5" aria-hidden="true" />}
          </button>
        </div>
      </nav>

      {open && (
        <div className="mx-auto mt-2 w-full max-w-6xl rounded-3xl bg-surface/90 p-2 backdrop-blur-xl shadow-[0_8px_30px_rgb(21_26_33/0.18)] md:hidden">
          {[...SECTIONS, { href: "/reportar", label: "Soy vecino: enviar video" }].map((s) => (
            <a
              key={s.href}
              href={s.href}
              onClick={() => setOpen(false)}
              className="block rounded-2xl px-4 py-3 text-[16px] font-medium text-text hover:bg-surface-2"
            >
              {s.label}
            </a>
          ))}
        </div>
      )}
    </header>
  );
}
