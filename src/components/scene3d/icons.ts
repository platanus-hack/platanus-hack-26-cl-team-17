/** Iconos (lucide) por tipo de peligro y de acceso, compartidos por 3D, planta 2D y simbología. */
import {
  AppWindow,
  BatteryCharging,
  Biohazard,
  Bomb,
  Construction,
  Cylinder,
  DoorOpen,
  Droplet,
  Fence,
  Flag,
  Footprints,
  Fuel,
  LogIn,
  MapPin,
  SquareParking,
  SunMedium,
  TrafficCone,
  TriangleAlert,
  Users,
  UtilityPole,
  Waves,
  Zap,
  type LucideIcon,
} from "lucide-react";
import type { AccessPointKind, HazardKind } from "@/lib/domain";

export const HAZARD_ICON: Record<HazardKind, LucideIcon> = {
  gas_cylinder: Cylinder,
  gas_line: Cylinder,
  power_lines: UtilityPole,
  electrical: Zap,
  fuel_spill: Fuel,
  hazmat_placard: Biohazard,
  collapse_risk: Construction,
  explosion_risk: Bomb,
  ev_battery: BatteryCharging,
  solar_panels: SunMedium,
  traffic: TrafficCone,
  crowd: Users,
  water_hazard: Waves,
  other: TriangleAlert,
};

export const ACCESS_ICON: Record<AccessPointKind, LucideIcon> = {
  door: DoorOpen,
  gate: Fence,
  window: AppWindow,
  stairwell: Footprints,
  street_entry: LogIn,
  hydrant: Droplet,
  staging: SquareParking,
  command_post: Flag,
  other: MapPin,
};

export type Tone = "critical" | "warning" | "accent" | "info" | "ok" | "drone" | "muted" | "text";

export const HAZARD_TONE: Record<"low" | "medium" | "high", Tone> = {
  low: "info",
  medium: "warning",
  high: "critical",
};

export const ACCESS_TONE: Record<AccessPointKind, Tone> = {
  door: "ok",
  gate: "ok",
  window: "ok",
  stairwell: "ok",
  street_entry: "ok",
  hydrant: "info",
  staging: "muted",
  command_post: "text",
  other: "muted",
};

export const CONFIDENCE_TONE: Record<"low" | "medium" | "high", Tone> = {
  low: "warning",
  medium: "info",
  high: "ok",
};
