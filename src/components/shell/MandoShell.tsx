"use client";

import { useCallback, useEffect, useId, useRef, useState, useSyncExternalStore, type KeyboardEvent, type ReactNode } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  ArrowLeft,
  ChevronDown,
  CircleAlert,
  Ellipsis,
  Loader2,
  LogOut,
  PanelLeftClose,
  PanelLeftOpen,
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

/* ───────────── Menú lateral colapsable (se recuerda en el navegador) ───────────── */

const MENU_KEY = "vigia-menu-expandido";
const MENU_EVENT = "vigia-menu-cambio";

function readMenuExpanded(): boolean {
  try {
    return localStorage.getItem(MENU_KEY) === "1";
  } catch {
    return false;
  }
}

function subscribeMenu(onChange: () => void): () => void {
  window.addEventListener("storage", onChange);
  window.addEventListener(MENU_EVENT, onChange);
  return () => {
    window.removeEventListener("storage", onChange);
    window.removeEventListener(MENU_EVENT, onChange);
  };
}

/** Menú expandido (íconos y textos) o contraído (solo íconos, ocupa menos). Por defecto contraído. */
function useMenuExpanded(): [boolean, () => void] {
  const expanded = useSyncExternalStore(subscribeMenu, readMenuExpanded, () => false);
  const toggle = useCallback(() => {
    try {
      localStorage.setItem(MENU_KEY, readMenuExpanded() ? "0" : "1");
    } catch {
      /* sin almacenamiento: no se recuerda */
    }
    window.dispatchEvent(new Event(MENU_EVENT));
  }, []);
  return [expanded, toggle];
}

/**
 * Marco del puesto de mando al estilo de X: barra lateral con marca, navegación y sesión
 * (solo íconos en pantallas medianas; arriba en teléfonos) y una columna con encabezado y contenido.
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
  const nav = staffAuth && staff?.role === "admin" ? [NAV_INCIDENTS, NAV_PERSONAL] : [NAV_INCIDENTS];
  // En pantallas anchas el menú se puede expandir; contraído deja solo los íconos.
  const [expanded, toggleMenu] = useMenuExpanded();

  return (
    // relative: los elementos absolutos (p. ej. sr-only) quedan recortados aquí y no alargan el documento.
    <div className={cn("relative flex h-dvh overflow-hidden bg-bg text-text", className)}>
      <a
        href={`#${contentId}`}
        className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:rounded-full focus:border focus:border-line-strong focus:bg-surface focus:px-4 focus:py-2 focus:text-sm focus:text-text"
      >
        Saltar al contenido
      </a>

      <aside
        className={cn(
          "hidden w-[76px] shrink-0 flex-col items-center border-r border-line px-2 transition-[width] md:flex",
          expanded && "xl:w-64 xl:items-stretch xl:px-3",
        )}
      >
        <Link
          href="/mando"
          aria-label="Vigía: ir a incidentes"
          className="mt-1 flex size-[52px] shrink-0 items-center justify-center rounded-full text-text transition-colors hover:bg-surface-2"
        >
          <Logo size={30} title="" />
        </Link>

        <nav aria-label="Principal" className="mt-1">
          <ul className="flex flex-col gap-1">
            {nav.map((item) => (
              <li key={item.href}>
                <SideNavLink item={item} active={item.isActive(pathname)} expanded={expanded} />
              </li>
            ))}
          </ul>
        </nav>

        <button
          type="button"
          onClick={toggleMenu}
          aria-expanded={expanded}
          title={expanded ? "Contraer menú" : "Expandir menú"}
          className={cn(
            "mt-1 hidden items-center gap-5 rounded-full p-3 text-muted transition-colors hover:bg-surface-2 hover:text-text xl:flex",
            expanded ? "xl:justify-start xl:pr-6" : "justify-center",
          )}
        >
          {expanded ? <PanelLeftClose aria-hidden className="size-[22px] shrink-0" /> : <PanelLeftOpen aria-hidden className="size-[22px] shrink-0" />}
          <span className={cn("text-[15px]", expanded ? "" : "sr-only")}>{expanded ? "Contraer menú" : "Expandir menú"}</span>
        </button>

        <div className={cn("mt-auto flex flex-col gap-3 pb-3", expanded && "xl:items-stretch")}>
          {mode && expanded ? (
            <div className="hidden px-3 xl:block">
              <ModeBadges mode={mode} compact />
            </div>
          ) : null}
          {expanded ? (
            <div className="hidden px-3 text-sm text-muted xl:block">
              <LiveClock />
            </div>
          ) : null}
          {staffAuth && staff ? <UserMenu staff={staff} placement="sidebar" expanded={expanded} /> : null}
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-[53px] shrink-0 items-center gap-2 border-b border-line bg-bg/85 px-2 backdrop-blur-md sm:gap-3 sm:px-4">
          {/* Teléfono: la barra lateral no cabe; marca y navegación van aquí, solo con íconos. */}
          <Link
            href="/mando"
            aria-label="Vigía: ir a incidentes"
            className="flex size-9 shrink-0 items-center justify-center rounded-full text-text transition-colors hover:bg-surface-2 md:hidden"
          >
            <Logo size={22} title="" />
          </Link>
          <nav aria-label="Principal" className="shrink-0 md:hidden">
            <ul className="flex items-center">
              {nav.map((item) => {
                const active = item.isActive(pathname);
                const Icon = item.icon;
                return (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      aria-current={active ? "page" : undefined}
                      title={item.label}
                      className="flex size-9 items-center justify-center rounded-full transition-colors hover:bg-surface-2"
                    >
                      <Icon aria-hidden className="size-5" strokeWidth={active ? 2.5 : 1.75} />
                      <span className="sr-only">{item.label}</span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          </nav>

          {back ? (
            <Link
              href={back.href}
              title={back.label}
              className="flex size-9 shrink-0 items-center justify-center rounded-full text-text transition-colors hover:bg-surface-2"
            >
              <ArrowLeft aria-hidden className="size-5" />
              <span className="sr-only">{back.label}</span>
            </Link>
          ) : null}

          <div className="min-w-0 flex-1">
            {title ? <h1 className="truncate text-xl leading-6 font-extrabold">{title}</h1> : null}
            {subtitle ? <div className="truncate text-[13px] leading-4 text-muted">{subtitle}</div> : null}
          </div>

          {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}

          <div className={cn("hidden shrink-0 text-sm text-muted sm:block", expanded && "xl:hidden")}>
            <LiveClock />
          </div>

          {mode ? (
            <>
              <div className={cn("hidden shrink-0 lg:block", expanded && "xl:hidden")}>
                <ModeBadges mode={mode} />
              </div>
              <div className="shrink-0 lg:hidden">
                <ModeBadges mode={mode} compact />
              </div>
            </>
          ) : null}

          {staffAuth && staff ? (
            <div className="shrink-0 md:hidden">
              <UserMenu staff={staff} placement="header" />
            </div>
          ) : null}
        </header>

        <main id={contentId} tabIndex={-1} className={cn("relative min-h-0 flex-1 outline-none", contentClassName)}>
          {children}
        </main>
      </div>
    </div>
  );
}

/**
 * Enlace de la barra lateral: ícono grande y, con el menú expandido en pantallas anchas,
 * texto de 20 px; el activo va en negrita.
 */
function SideNavLink({ item, active, expanded }: { item: NavItem; active: boolean; expanded: boolean }) {
  const Icon = item.icon;
  return (
    <Link
      href={item.href}
      aria-current={active ? "page" : undefined}
      title={item.label}
      className={cn("group flex justify-center text-xl text-text", expanded && "xl:justify-start")}
    >
      <span className={cn("flex items-center gap-5 rounded-full p-3 transition-colors group-hover:bg-surface-2", expanded && "xl:pr-6")}>
        <Icon aria-hidden className="size-[26px] shrink-0" strokeWidth={active ? 2.5 : 1.75} />
        <span className={cn("sr-only", expanded && "xl:not-sr-only", active ? "font-bold" : "font-normal")}>{item.label}</span>
      </span>
    </Link>
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
