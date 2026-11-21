/** Iconos lucide por tipo (SVG en línea; sin imágenes remotas). */
import {
  AppWindow,
  Bike,
  Biohazard,
  Bomb,
  Building2,
  Bus,
  Car,
  CarFront,
  Caravan,
  CarBattery,
  CircleHelp,
  Construction,
  Cylinder,
  DoorOpen,
  Droplet,
  Fence,
  Flag,
  Flame,
  Footprints,
  Fuel,
  LifeBuoy,
  MapPin,
  Motorbike,
  Siren,
  Signpost,
  SolarPanel,
  SquareParking,
  TrafficCone,
  Trees,
  TriangleAlert,
  Truck,
  Users,
  Waves,
  Zap,
  type LucideIcon,
} from "lucide-react";
import type { AccessPointKind, HazardKind, IncidentType, VehicleKind } from "@/lib/domain";

export const INCIDENT_TYPE_ICON: Record<IncidentType, LucideIcon> = {
  structure_fire: Flame,
  vehicle_fire: CarFront,
  wildland_fire: Trees,
  vehicle_collision: Car,
  hazmat: Biohazard,
  rescue: LifeBuoy,
  other: Siren,
  unknown: CircleHelp,
};

export const HAZARD_ICON: Record<HazardKind, LucideIcon> = {
  gas_cylinder: Cylinder,
  gas_line: Flame,
  power_lines: Zap,
  electrical: Zap,
  fuel_spill: Fuel,
  hazmat_placard: Biohazard,
  collapse_risk: Construction,
  explosion_risk: Bomb,
  ev_battery: CarBattery,
  solar_panels: SolarPanel,
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
  street_entry: Signpost,
  hydrant: Droplet,
  staging: SquareParking,
  command_post: Flag,
  other: MapPin,
};

export const VEHICLE_ICON: Record<VehicleKind, LucideIcon> = {
  car: Car,
  suv_pickup: Car,
  van: Bus,
  truck: Truck,
  bus: Bus,
  motorcycle: Motorbike,
  bicycle: Bike,
  trailer: Caravan,
  other: Car,
};

export { Building2 as StructureIcon };
