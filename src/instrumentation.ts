/**
 * Se ejecuta una vez al iniciar el servidor de Next. Arranca la escucha continua del agente
 * Vigía (solo en el runtime de Node; VIGIA_AGENT=0 la apaga).
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { ensureVigiaSupervisor } = await import("./lib/vigia/supervisor");
    ensureVigiaSupervisor();
  }
}
