"use client";

import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  ArrowLeft,
  ChevronDown,
  CircleAlert,
  Ellipsis,
  Loader2,
  LogOut,
  Siren,
  Users,
  type LucideIcon,
} from "lucide-react";
import { Logo } from "@/components/brand/Logo";
import { LiveClock } from "@/components/ui/time";
import type { RuntimeMode, StaffPublic } from "@/lib/contract";
import { staffRoleLabel } from "@/lib/labels";
import { cn } from "@/lib/cn";
import { ModeBadges } from "./ModeBadges";

/** Props del marco de las pantallas del puesto de mando. */
export interface MandoShellProps {
  children: ReactNode;
  /** Título de la pantalla; se muestra en la barra superior como encabezado h1 (no repetir otro h1 en el contenido). */
  title?: ReactNode;
  subtitle?: ReactNode;
  /** Acciones propias de la pantalla, a la derecha de la barra. */
  actions?: ReactNode;
  /** Enlace de regreso (p. ej. a la lista de incidentes). */
  back?: { href: string; label: string };
  mode?: RuntimeMode | null;
  staff?: StaffPublic | null;
  className?: string;
  /** Clases del área de contenido (`main`), que maneja su propio scroll. */
  contentClassName?: string;
}

interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  isActive: (pathname: string) => boolean;
}

const PERSONAL_PATH = "/mando/personal";

const NAV_INCIDENTS: NavItem = {
  href: "/mando",
  label: "Incidentes",
  icon: Siren,
  isActive: (p) =>
    (p === "/mando" || p.startsWith("/mando/")) && !(p === PERSONAL_PATH || p.startsWith(`${PERSONAL_PATH}/`)),
};

const NAV_PERSONAL: NavItem = {
  href: PERSONAL_PATH,
  label: "Personal",
  icon: Users,
  isActive: (p) => p === PERSONAL_PATH || p.startsWith(`${PERSONAL_PATH}/`),
};

/**
 * Marco del puesto de mando: una sola barra superior (sin menú lateral) con la marca, que
 * lleva a la portada, el regreso, el título, las acciones de la pantalla y la sesión.
 */
export function MandoShell({
  children,
  title,
  subtitle,
  actions,
  back,
  mode,
  staff,
  className,
  contentClassName,
}: MandoShellProps) {
  const pathname = usePathname();
  const contentId = useId();
  const staffAuth = mode?.auth === "staff";
  const nav = staffAuth && staff?.role === "admin" ? [NAV_INCIDENTS, NAV_PERSONAL] : [];
  // Sin regreso propio, el tablero vuelve a la portada.
  const backLink = back ?? (pathname === "/mando" ? { href: "/", label: "Volver al inicio" } : null);

  return (
    // relative: los elementos absolutos (p. ej. sr-only) quedan recortados aquí y no alargan el documento.
    <div className={cn("relative flex h-dvh flex-col overflow-hidden bg-bg text-text", className)}>
      <a
        href={`#${contentId}`}
        className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:rounded-full focus:border focus:border-line-strong focus:bg-surface focus:px-4 focus:py-2 focus:text-sm focus:text-text"
      >
        Saltar al contenido
      </a>

      <header className="flex h-14 shrink-0 items-center gap-2 border-b border-line bg-bg/85 px-2 backdrop-blur-md sm:gap-3 sm:px-4">
        {backLink ? (
          <Link
            href={backLink.href}
            title={backLink.label}
            className="flex size-9 shrink-0 items-center justify-center rounded-full text-text transition-colors hover:bg-surface-2"
          >
            <ArrowLeft aria-hidden className="size-5" />
            <span className="sr-only">{backLink.label}</span>
          </Link>
        ) : null}

        <Link
          href="/"
          title="Ir a la portada"
          className="flex shrink-0 items-center gap-2 rounded-full py-1 pr-2 pl-1 transition-colors hover:bg-surface-2"
        >
          <Logo size={26} title="" />
          <span className="hidden font-display text-[17px] font-bold tracking-[-0.02em] sm:inline">vigilia</span>
        </Link>

        <span aria-hidden="true" className="hidden h-6 w-px bg-line sm:block" />

        <div className="min-w-0 flex-1">
          {title ? <h1 className="truncate text-lg leading-6 font-bold">{title}</h1> : null}
          {subtitle ? <div className="truncate text-[13px] leading-4 text-muted">{subtitle}</div> : null}
        </div>

        {nav.length > 0 ? (
          <nav aria-label="Principal" className="shrink-0">
            <ul className="flex items-center gap-1">
              {nav.map((item) => {
                const active = item.isActive(pathname);
                const Icon = item.icon;
                return (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      aria-current={active ? "page" : undefined}
                      title={item.label}
                      className={cn(
                        "flex h-9 items-center gap-1.5 rounded-full px-3 text-[14px] transition-colors hover:bg-surface-2",
                        active ? "font-semibold text-text" : "text-muted",
                      )}
                    >
                      <Icon aria-hidden className="size-4" />
                      <span className="hidden md:inline">{item.label}</span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          </nav>
        ) : null}

        {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}

        <div className="hidden shrink-0 text-sm text-muted lg:block">
          <LiveClock />
        </div>

        {mode ? (
          <div className="shrink-0">
            <ModeBadges mode={mode} compact />
          </div>
        ) : null}

        {staffAuth && staff ? (
          <div className="shrink-0">
            <UserMenu staff={staff} placement="header" />
          </div>
        ) : null}
      </header>

      <main id={contentId} tabIndex={-1} className={cn("relative min-h-0 flex-1 outline-none", contentClassName)}>
        {children}
      </main>
    </div>
  );
}

/** Menú de la sesión del personal con la opción de cerrar sesión. */
function UserMenu({
  staff,
  placement,
  expanded = false,
}: {
  staff: StaffPublic;
  placement: "sidebar" | "header";
  /** Menú lateral expandido: muestra nombre y cargo en pantallas anchas. */
  expanded?: boolean;
}) {
  const inSidebar = placement === "sidebar";
  const wide = inSidebar && expanded;
  const router = useRouter();
  const menuId = useId();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const itemRef = useRef<HTMLButtonElement>(null);
  const roleLabel = staffRoleLabel[staff.role];

  const close = useCallback((restoreFocus: boolean) => {
    setOpen(false);
    if (restoreFocus) buttonRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!open) return;
    itemRef.current?.focus();
    const onPointerDown = (e: PointerEvent) => {
      if (rootRef.current && e.target instanceof Node && !rootRef.current.contains(e.target)) close(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open, close]);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape" && open) {
      e.preventDefault();
      close(true);
    }
  };

  const onButtonKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    if ((e.key === "ArrowDown" || e.key === "ArrowUp") && !open) {
      e.preventDefault();
      setOpen(true);
    }
  };

  const logout = async () => {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/logout", { method: "POST" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      router.push("/login");
      router.refresh();
    } catch {
      setError("No se pudo cerrar la sesión. Revisa la conexión e inténtalo de nuevo.");
      setPending(false);
    }
  };

  return (
    <div
      ref={rootRef}
      className={cn("relative shrink-0", wide && "xl:w-full")}
      onKeyDown={onKeyDown}
      onBlur={(e) => {
        if (open && !e.currentTarget.contains(e.relatedTarget)) setOpen(false);
      }}
    >
      <button
        ref={buttonRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={onButtonKeyDown}
        className={cn(
          "flex items-center text-left transition-colors hover:bg-surface-2",
          inSidebar ? cn("w-full justify-center gap-3 rounded-full p-3", wide && "xl:justify-start") : "h-9 gap-1.5 rounded-full px-1",
          open && "bg-surface-2",
        )}
      >
        <span
          aria-hidden
          className={cn(
            "flex shrink-0 items-center justify-center rounded-full bg-surface-2 font-bold text-muted uppercase ring-1 ring-line",
            inSidebar ? "size-10 text-sm" : "size-7 text-xs",
          )}
        >
          {initials(staff.name)}
        </span>
        <span className={cn("min-w-0 flex-1 flex-col", wide ? "hidden xl:flex" : "hidden")}>
          <span className="truncate text-[15px] leading-5 font-bold">{staff.name}</span>
          <span className="truncate text-[15px] leading-5 text-muted">{roleLabel}</span>
        </span>
        <span className={cn("sr-only", wide && "xl:hidden")}>
          {staff.name}, {roleLabel}
        </span>
        {inSidebar ? (
          <Ellipsis aria-hidden className={cn("hidden size-5 shrink-0", wide && "xl:block")} />
        ) : (
          <ChevronDown aria-hidden className={cn("size-3.5 shrink-0 text-muted transition-transform", open && "rotate-180")} />
        )}
      </button>

      {open ? (
        <div
          id={menuId}
          role="menu"
          aria-label="Sesión"
          className={cn(
            "absolute z-40 w-64 animate-fade-in overflow-hidden rounded-2xl border border-line bg-surface shadow-[0_0_15px_rgb(101_119_134/0.2),0_0_3px_1px_rgb(101_119_134/0.15)]",
            inSidebar ? "bottom-full left-0 mb-2" : "top-full right-0 mt-1",
          )}
        >
          <div role="none" className="border-b border-line px-3 py-2.5">
            <p className="truncate text-sm font-semibold">{staff.name}</p>
            <p className="truncate text-xs text-muted">{staff.email}</p>
            <p className="label-caps mt-1 text-[11px] text-faint">
              {roleLabel}
              {staff.demo ? " · demostración" : ""}
            </p>
          </div>
          <div role="none" className="p-1">
            <button
              ref={itemRef}
              type="button"
              role="menuitem"
              aria-busy={pending || undefined}
              aria-disabled={pending || undefined}
              onClick={logout}
              className="flex h-10 w-full items-center gap-2 rounded-xl px-3 text-left text-[15px] font-bold text-text transition-colors hover:bg-surface-2 focus-visible:bg-surface-2 aria-disabled:cursor-wait aria-disabled:text-muted"
            >
              {pending ? (
                <Loader2 aria-hidden className="size-4 shrink-0 animate-spin" />
              ) : (
                <LogOut aria-hidden className="size-4 shrink-0 text-muted" />
              )}
              {pending ? "Cerrando sesión…" : "Cerrar sesión"}
            </button>
          </div>
          {error ? (
            <p role="alert" className="flex items-start gap-1.5 border-t border-line px-3 py-2 text-xs text-critical">
              <CircleAlert aria-hidden className="mt-px size-3.5 shrink-0" />
              {error}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** Iniciales (máx. 2) para el avatar del menú de sesión. */
function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  const first = parts[0].charAt(0);
  const last = parts.length > 1 ? parts[parts.length - 1].charAt(0) : "";
  return (first + last).toUpperCase();
}
