import { ScenarioProvider } from "@/components/mando/scenario";

/** Layout de /mando y sus subrutas: mantiene vivo el simulacro al navegar entre tablero e incidente. */
export default function MandoLayout({ children }: LayoutProps<"/mando">) {
  return <ScenarioProvider>{children}</ScenarioProvider>;
}
