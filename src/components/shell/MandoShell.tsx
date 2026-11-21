"use client";

import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { ChevronDown, ChevronLeft, CircleAlert, Loader2, LogOut, Siren, Users, type LucideIcon } from "lucide-react";
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

/** Marco del puesto de mando: barra superior compacta (marca, navegación, reloj, modo, sesión) y contenido a pantalla completa. */
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
  const nav = staffAuth && staff?.role === "admin" ? [NAV_INCIDENTS, NAV_PERSONAL] : [NAV_INCIDENTS];

  return (
    // relative: los elementos absolutos (p. ej. sr-only) quedan recortados aquí y no alargan el documento.
    <div className={cn("relative flex h-dvh flex-col overflow-hidden bg-bg text-text", className)}>
      <a
        href={`#${contentId}`}
        className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:rounded-md focus:border focus:border-line-strong focus:bg-surface-2 focus:px-3 focus:py-2 focus:text-sm focus:text-text"
      >
        Saltar al contenido
      </a>

      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-line bg-surface px-2 sm:gap-3 sm:px-3">
        <Link
          href="/mando"
          aria-label="Vigía: ir a incidentes"
          className="flex h-9 shrink-0 items-center gap-2 rounded-md px-1 text-text"
        >
          <Logo size={24} title="" />
          <span className="hidden font-display text-lg leading-none font-semibold xl:inline">
            Vigía
          </span>
        </Link>

        <nav aria-label="Principal" className="shrink-0">
          <ul className="flex items-center gap-0.5">
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
                      "label-caps flex h-8 items-center gap-1.5 rounded-md px-2 text-xs transition-colors",
                      active ? "bg-surface-2 text-text" : "text-muted hover:bg-surface-2 hover:text-text",
                    )}
                  >
                    <Icon aria-hidden className={cn("size-4 shrink-0", active && "text-accent")} />
                    <span className="max-sm:sr-only">{item.label}</span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>

        <span aria-hidden className="h-6 w-px shrink-0 bg-line" />

        {back ? (
          <Link
            href={back.href}
            title={back.label}
            className="flex h-8 max-w-48 shrink-0 items-center gap-1 rounded-md pr-2 pl-1 text-sm text-muted transition-colors hover:bg-surface-2 hover:text-text"
          >
            <ChevronLeft aria-hidden className="size-4 shrink-0" />
            <span className="truncate max-sm:sr-only">{back.label}</span>
          </Link>
        ) : null}

        <div className="min-w-0 flex-1">
          {title ? (
            <h1 className="truncate font-display text-base leading-tight font-semibold">{title}</h1>
          ) : null}
          {subtitle ? <div className="truncate text-xs leading-tight text-muted">{subtitle}</div> : null}
        </div>

        {actions ? <div className="flex shrink-0 items-center gap-1.5">{actions}</div> : null}

        <div className="hidden shrink-0 text-sm text-muted sm:block">
          <LiveClock />
        </div>

        {mode ? (
          <>
            <div className="hidden shrink-0 lg:block">
              <ModeBadges mode={mode} />
            </div>
            <div className="shrink-0 lg:hidden">
              <ModeBadges mode={mode} compact />
            </div>
          </>
        ) : null}

        {staffAuth && staff ? <UserMenu staff={staff} /> : null}
      </header>

      <main id={contentId} tabIndex={-1} className={cn("relative min-h-0 flex-1 outline-none", contentClassName)}>
        {children}
      </main>
    </div>
  );
}

/** Menú de la sesión del personal con la opción de cerrar sesión. */
function UserMenu({ staff }: { staff: StaffPublic }) {
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
      className="relative shrink-0"
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
          "flex h-8 max-w-52 items-center gap-2 rounded-md border px-2 text-left transition-colors",
          open ? "border-line-strong bg-surface-2" : "border-transparent hover:bg-surface-2",
        )}
      >
        <span
          aria-hidden
          className="flex size-6 shrink-0 items-center justify-center rounded-full bg-surface-2 font-display text-xs font-bold text-muted uppercase ring-1 ring-line"
        >
          {initials(staff.name)}
        </span>
        <span className="hidden min-w-0 flex-col md:flex">
          <span className="truncate text-sm leading-tight">{staff.name}</span>
          <span className="truncate text-[11px] leading-tight text-muted">{roleLabel}</span>
        </span>
        <span className="sr-only md:hidden">
          {staff.name}, {roleLabel}
        </span>
        <ChevronDown aria-hidden className={cn("size-3.5 shrink-0 text-muted transition-transform", open && "rotate-180")} />
      </button>

      {open ? (
        <div
          id={menuId}
          role="menu"
          aria-label="Sesión"
          className="absolute top-full right-0 z-40 mt-1 w-64 animate-fade-in overflow-hidden rounded-lg border border-line-strong bg-surface"
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
              className="flex h-9 w-full items-center gap-2 rounded-md px-2 text-left text-sm text-text transition-colors hover:bg-surface-2 focus-visible:bg-surface-2 aria-disabled:cursor-wait aria-disabled:text-muted"
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
