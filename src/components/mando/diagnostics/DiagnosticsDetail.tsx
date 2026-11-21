"use client";
/**
 * Detalle de la vista técnica: un panel por subsistema con lo que hace falta para saber qué
 * falla durante una demo. Denso a propósito: horas exactas, "hace N s" que corre cada segundo
 * y el color del estado en cada fila importante.
 */
import { useEffect, type ReactNode } from "react";
import { AlertTriangle, Bot, Cpu, ListOrdered, RadioTower, ScanEye, Zap, type LucideIcon } from "lucide-react";
import { Badge, EmptyState, Panel, Spinner, StatusDot } from "@/components/ui";
import { KIND_LABEL } from "@/components/vigia/VigiaDock";
import { cn } from "@/lib/cn";
import type {
  DiagnosticsClaudeCall,
  DiagnosticsLiveFeed,
  DiagnosticsServerError,
  DiagnosticsUtterance,
  IncidentDiagnostics,
} from "@/lib/contract";
import { formatClock } from "@/lib/format";
import type { VigiaKind } from "@/lib/vigia/types";
import { DIAG_TONE } from "./DiagnosticsBand";
import {
  ageMs,
  agoText,
  callError,
  formatMs,
  formatTokens,
  heartbeatAgeMs,
  HEARTBEAT_STALE_MS,
  LIVE_LAG_MS,
  liveLagMs,
  MEDIA_LATE_MS,
  ruleLabel,
  SCREEN_REASON_LABEL,
  SOURCE_LABEL,
  TASK_LABEL,
  UTTERANCE_STATE_LABEL,
  UTTERANCE_STATE_TONE,
  voiceFreeInMs,
  ZELLO_STATE_LABEL,
  ZELLO_STATE_TONE,
  zelloState,
  type DiagTone,
  type SubsystemId,
  type SubsystemStatus,
} from "./model";
import { useLiveDiagnostics } from "./use-diagnostics";

const PANEL_ICON: Record<SubsystemId, LucideIcon> = {
  motor: Cpu,
  zello: RadioTower,
  claude: Zap,
  detector: ScanEye,
  salida: Bot,
  errores: AlertTriangle,
};

const PANEL_TITLE: Record<SubsystemId, string> = {
  motor: "Motor en uso",
  zello: "Puente Zello",
  claude: "Últimas llamadas a Claude",
  detector: "Detector y cola de videos",
  salida: "Salida de Vigía",
  errores: "Errores recientes del servidor",
};

const TEXT_TONE: Record<DiagTone, string> = {
  ok: "text-ok",
  warning: "text-warning",
  critical: "text-critical",
  muted: "text-muted",
};

/** id del panel de un subsistema (la banda salta ahí). */
export function sectionId(id: SubsystemId): string {
  return `diagnostico-${id}`;
}

/* ───────────────────────────── Piezas ───────────────────────────── */

function Row({ label, children, tone, mono = false }: { label: string; children: ReactNode; tone?: DiagTone; mono?: boolean }) {
  return (
    <div className="grid grid-cols-[8.5rem_minmax(0,1fr)] gap-2 py-1 text-sm">
      <dt className="text-xs leading-5 text-muted">{label}</dt>
      <dd className={cn("min-w-0 break-words", mono && "font-mono text-[13px] tabular", tone ? TEXT_TONE[tone] : "text-text")}>
        {children}
      </dd>
    </div>
  );
}

function Rows({ children }: { children: ReactNode }) {
  return <dl className="divide-y divide-line">{children}</dl>;
}

/** Hora exacta y hace cuánto: "17:02:05 · hace 4 s". */
function When({ iso, nowMs, lateMs }: { iso: string | null | undefined; nowMs: number; lateMs?: number }) {
  if (!iso) return <span className="text-faint">nunca</span>;
  const age = ageMs(iso, nowMs);
  const late = lateMs !== undefined && age !== null && age > lateMs;
  return (
    <span className="tabular" suppressHydrationWarning>
      <span className="font-mono text-[13px]">{formatClock(iso)}</span>
      <span className={cn("ml-1.5", late ? "font-semibold text-critical" : "text-muted")}>· {agoText(iso, nowMs)}</span>
    </span>
  );
}

function SubHeading({ children }: { children: ReactNode }) {
  return <h3 className="label-caps mt-3 mb-1 text-[11px] text-muted first:mt-0">{children}</h3>;
}

function Callout({ tone, children }: { tone: DiagTone; children: ReactNode }) {
  const cls: Record<DiagTone, string> = {
    ok: "border-ok/40 bg-ok-soft text-ok",
    warning: "border-warning/40 bg-warning-soft text-warning",
    critical: "border-critical/50 bg-critical-soft text-critical",
    muted: "border-line bg-surface-2 text-muted",
  };
  return <div className={cn("rounded-lg border px-3 py-2 text-sm", cls[tone])}>{children}</div>;
}

function DiagPanel({ id, status, children, actions }: { id: SubsystemId; status: SubsystemStatus | undefined; children: ReactNode; actions?: ReactNode }) {
  const tone = status?.tone ?? "muted";
  return (
    <Panel
      id={sectionId(id)}
      title={PANEL_TITLE[id]}
      icon={PANEL_ICON[id]}
      tone={DIAG_TONE[tone]}
      actions={actions}
      badge={
        status ? (
          <Badge tone={DIAG_TONE[tone]} dot pulse={tone === "critical"} className="max-w-64">
            {status.value}
          </Badge>
        ) : null
      }
      className="scroll-mt-3"
    >
      {children}
    </Panel>
  );
}

/* ───────────────────────────── Paneles ───────────────────────────── */

function EnginePanel({ d, status }: { d: IncidentDiagnostics; status?: SubsystemStatus }) {
  const e = d.engine;
  const settings = (s: { model: string; effort: string; fast: boolean }) => (
    <span className="font-mono text-[13px]">
      {s.model} · esfuerzo {s.effort}
      {s.fast ? " · rápido" : ""}
    </span>
  );
  return (
    <DiagPanel id="motor" status={status}>
      {e.ai === "simulated" ? (
        <Callout tone="warning">
          <strong>MOTOR SIMULADO.</strong> {e.forced_simulated ? "VIGIA_AI=simulated lo fuerza" : "No hay credencial de Anthropic"}: los
          análisis son de demostración (no salen de los videos), el dron en vivo no se analiza y Vigía responde con plantillas.
        </Callout>
      ) : (
        <Callout tone="ok">
          <strong>Claude real.</strong> Los análisis, el dron en vivo y Vigía usan los modelos de abajo.
        </Callout>
      )}
      <Rows>
        <Row label="Videos e informe">{settings(e.analysis)}</Row>
        <Row label="Dron y preguntas">{settings(e.live)}</Row>
        <Row label="Agente Vigía" tone={e.agent.enabled ? undefined : "muted"}>
          {e.agent.enabled ? (
            e.agent.engine === "claude" ? (
              settings(e.agent)
            ) : (
              "plantillas (sin Claude)"
            )
          ) : (
            "apagado (VIGIA_AGENT=0)"
          )}
        </Row>
        <Row label="Credencial" tone={e.has_credential ? undefined : "warning"}>
          {e.has_credential ? `hay credencial de Anthropic${e.forced_simulated ? " (sin uso: simulado forzado)" : ""}` : "no hay credencial de Anthropic"}
        </Row>
        <Row label="Transcripción" tone={e.transcription ? undefined : "muted"}>
          {e.transcription ? "ElevenLabs configurado" : "sin ElevenLabs: la radio llega sin texto"}
        </Row>
        <Row label="Datos y archivos">
          {e.store === "postgres" ? "Postgres" : "local (.data/)"} · {e.files === "gcs" ? "Cloud Storage" : "archivos locales"}
        </Row>
      </Rows>
    </DiagPanel>
  );
}

function ZelloPanel({ d, nowMs, status }: { d: IncidentDiagnostics; nowMs: number; status?: SubsystemStatus }) {
  const z = d.zello;
  const s = z.status;
  const st = zelloState(z, nowMs);
  const age = heartbeatAgeMs(z, nowMs);
  return (
    <DiagPanel id="zello" status={status}>
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <Badge tone={DIAG_TONE[ZELLO_STATE_TONE[st]]} size="md" dot pulse={ZELLO_STATE_TONE[st] === "critical"}>
          {ZELLO_STATE_LABEL[st]}
        </Badge>
        {s?.listen_only && <Badge tone="warning">Vigía no habla: sin voz configurada</Badge>}
      </div>
      {!s ? (
        <p className="text-sm text-muted">
          Nunca llegó un latido de un puente Zello. Se inicia con <code className="font-mono">npm run zello</code>; la app funciona
          igual sin él (la radio se escribe o se dicta en la mesa).
        </p>
      ) : (
        <Rows>
          <Row label="Último latido">
            <When iso={z.received_at} nowMs={nowMs} lateMs={HEARTBEAT_STALE_MS} />
            <span className="ml-1.5 text-xs text-faint">(cada ~10 s; rojo pasados 30 s)</span>
          </Row>
          {age !== null && age > HEARTBEAT_STALE_MS && !s.stopped && (
            <Row label="" tone="critical">
              El puente dejó de informar: se cayó o perdió la red. Lo que se hable en Zello no entra a la bitácora.
            </Row>
          )}
          <Row label="Canal" mono>
            {s.channel}
          </Row>
          <Row label="En línea">{s.users_online ?? "no se sabe"}</Row>
          <Row label="Emergencias">{s.incident_codes.length > 0 ? s.incident_codes.join(", ") : "ninguna abierta"}</Row>
          <Row label="Última transmisión">
            {s.last_transmission ? (
              <>
                <When iso={s.last_transmission.at} nowMs={nowMs} /> · <strong>{s.last_transmission.from}</strong>
                <span className="mt-0.5 block text-muted">«{s.last_transmission.text}»</span>
              </>
            ) : (
              <span className="text-faint">sin transmisiones aún</span>
            )}
          </Row>
          <Row label="Vigía dijo">
            {s.last_spoken ? (
              <>
                <When iso={s.last_spoken.at} nowMs={nowMs} />
                <span className="mt-0.5 block text-muted">«{s.last_spoken.text}»</span>
              </>
            ) : (
              <span className="text-faint">{s.listen_only ? "no habla (solo escucha)" : "todavía nada"}</span>
            )}
          </Row>
          <Row label="Error del puente" tone={s.error ? "critical" : "muted"}>
            {s.error ?? "ninguno"}
          </Row>
        </Rows>
      )}
    </DiagPanel>
  );
}

/** Segunda línea chica de una celda. */
function Sub({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cn("block text-[10px] leading-3 text-faint", className)}>{children}</span>;
}

function CallRow({ c, nowMs, incidentId }: { c: DiagnosticsClaudeCall; nowMs: number; incidentId: string }) {
  const slow = c.ms > 20_000;
  const other = c.incident_id !== null && c.incident_id !== incidentId;
  return (
    <tr className={cn("border-t border-line align-top", !c.ok && "bg-critical-soft")}>
      <td className="py-1 pr-2 font-mono whitespace-nowrap" title={agoText(c.at, nowMs)}>
        {formatClock(c.at)}
      </td>
      <td className="py-1 pr-2">
        {TASK_LABEL[c.task] ?? c.task}
        {other && <Sub>{c.incident_code ?? "otra emergencia"}</Sub>}
      </td>
      <td className="py-1 pr-2 font-mono whitespace-nowrap">
        {c.model.replace(/^claude-/, "")}
        {(c.fast || c.fallback) && (
          <Sub className="font-sans">
            {c.fast && <span className="text-info">rápido</span>}
            {c.fast && c.fallback && " · "}
            {c.fallback && <span className="text-warning">respaldo</span>}
          </Sub>
        )}
      </td>
      <td className={cn("py-1 pr-3 text-right font-mono whitespace-nowrap", slow && "font-semibold text-warning")}>{formatMs(c.ms)}</td>
      <td className="py-1 pr-2 whitespace-nowrap">
        {c.ok ? (
          <span className="text-ok">ok</span>
        ) : (
          <span className="font-semibold text-critical" title={c.error ?? undefined}>
            {callError(c)}
          </span>
        )}
        {c.ok && c.stop_reason && c.stop_reason !== "end_turn" && <Sub>{c.stop_reason}</Sub>}
      </td>
      <td className="py-1 text-right font-mono whitespace-nowrap text-muted">
        {c.ok ? `${formatTokens(c.input_tokens)} / ${formatTokens(c.output_tokens)}` : "—"}
        {c.ok && c.cache_read_tokens ? <Sub className="font-sans">caché {formatTokens(c.cache_read_tokens)}</Sub> : null}
      </td>
    </tr>
  );
}

function ClaudePanel({ d, nowMs, status }: { d: IncidentDiagnostics; nowMs: number; status?: SubsystemStatus }) {
  const c = d.claude;
  return (
    <DiagPanel id="claude" status={status}>
      <p className="mb-2 text-xs text-muted">
        {c.total} registradas en esta instancia · {c.errors} con error · mediana {formatMs(c.p50_ms)} · máxima {formatMs(c.max_ms)}
      </p>
      {c.calls.length === 0 ? (
        <p className="text-sm text-muted">
          {d.engine.ai === "simulated" ? "Con el motor simulado no se llama a Claude." : "Todavía no hay llamadas desde que arrancó el servidor."}
        </p>
      ) : (
        <div className="-mx-1 overflow-x-auto px-1">
          <table className="w-full min-w-[26rem] text-xs">
            <thead>
              <tr className="text-left text-[11px] text-muted">
                <th className="pb-1 font-medium">Hora</th>
                <th className="pb-1 font-medium">Tarea</th>
                <th className="pb-1 font-medium">Modelo</th>
                <th className="pb-1 pr-3 text-right font-medium">Duración</th>
                <th className="pb-1 font-medium">Estado</th>
                <th className="pb-1 text-right font-medium" title="Tokens de entrada / salida">
                  Tokens ent. / sal.
                </th>
              </tr>
            </thead>
            <tbody>
              {c.calls.map((call, i) => (
                <CallRow key={`${call.at}-${i}`} c={call} nowMs={nowMs} incidentId={d.incident.id} />
              ))}
            </tbody>
          </table>
          {c.calls.some((x) => !x.ok) && (
            <ul className="mt-2 space-y-1 text-xs text-critical">
              {c.calls
                .filter((x) => !x.ok)
                .slice(0, 3)
                .map((x, i) => (
                  <li key={`${x.at}-${i}`} className="break-words">
                    <span className="font-mono">{formatClock(x.at)}</span> {x.error}
                  </li>
                ))}
            </ul>
          )}
        </div>
      )}
    </DiagPanel>
  );
}

function LiveFeedRows({ f, nowMs }: { f: DiagnosticsLiveFeed; nowMs: number }) {
  const lag = liveLagMs(f);
  const lagTone: DiagTone | undefined = f.receiving && (lag === null || lag > LIVE_LAG_MS) ? "warning" : undefined;
  return (
    <div className="rounded-lg border border-line px-2.5 py-1.5">
      <div className="flex items-center gap-2 text-sm font-semibold">
        <StatusDot tone={f.receiving ? "ok" : "neutral"} />
        Dron {f.label}
        <span className="text-xs font-normal text-muted">
          {f.receiving ? "recibiendo video aquí" : f.active ? "en misión, sin video en esta instancia" : "terminado"}
        </span>
      </div>
      <Rows>
        <Row label="Último cuadro">
          <When iso={f.last_frame_at} nowMs={nowMs} />
        </Row>
        <Row label="Última detección">
          <When iso={f.last_detection_at} nowMs={nowMs} />
          {f.last_detection_ms !== null && <span className="ml-1.5 text-xs text-muted">(inferencia {formatMs(f.last_detection_ms)})</span>}
          {f.last_detection !== null && <span className="mt-0.5 block text-muted">{f.last_detection || "nada detectado"}</span>}
        </Row>
        <Row label="Atraso de YOLO" tone={lagTone}>
          {lag === null ? (f.receiving ? "sin detecciones todavía" : "—") : formatMs(lag)}
          {f.detecting && <span className="ml-1.5 text-xs text-muted">(detectando)</span>}
        </Row>
        <Row label="Observador">
          {f.observer.analyzing && <span className="mr-1.5 text-xs text-info">mirando ahora…</span>}
          <When iso={f.observer.last_at} nowMs={nowMs} />
          {f.observer.engine && <span className="ml-1.5 text-xs text-muted">({f.observer.engine})</span>}
          {f.observer.summary && <span className="mt-0.5 block text-muted">{f.observer.summary}</span>}
        </Row>
      </Rows>
    </div>
  );
}

function DetectorPanel({ d, nowMs, status }: { d: IncidentDiagnostics; nowMs: number; status?: SubsystemStatus }) {
  const det = d.detector;
  const q = det.media;
  const pendingAge = ageMs(q.oldest_pending?.since, nowMs);
  return (
    <DiagPanel id="detector" status={status}>
      <Rows>
        <Row label="YOLO" tone={!det.configured ? "muted" : det.healthy ? "ok" : "critical"}>
          {!det.configured
            ? "no configurado (VIGIA_DETECTOR_URL vacío): los videos van directo a Claude con visión"
            : det.healthy
              ? `responde · ${det.labels} etiquetas`
              : "no responde /health: el análisis sigue sin YOLO"}
        </Row>
        {det.configured && (
          <Row label="Última consulta">
            <When iso={det.checked_at} nowMs={nowMs} />
          </Row>
        )}
      </Rows>

      <SubHeading>Video en vivo</SubHeading>
      {det.live.length === 0 ? (
        <p className="text-sm text-muted">Sin drones en misión.</p>
      ) : (
        <div className="space-y-2">
          {det.live.map((f) => (
            <LiveFeedRows key={f.mission_id} f={f} nowMs={nowMs} />
          ))}
        </div>
      )}

      <SubHeading>Videos de la emergencia</SubHeading>
      <div className="mb-1 flex flex-wrap gap-1.5">
        <Badge tone={q.uploading > 0 ? "info" : "neutral"}>{q.uploading} subiendo</Badge>
        <Badge tone={q.queued > 0 ? "warning" : "neutral"}>{q.queued} en cola</Badge>
        <Badge tone={q.analyzing > 0 ? "info" : "neutral"}>{q.analyzing} analizando</Badge>
        <Badge tone={q.analyzed > 0 ? "ok" : "neutral"}>{q.analyzed} analizados</Badge>
        <Badge tone={q.failed > 0 ? "critical" : "neutral"}>{q.failed} fallidos</Badge>
      </div>
      <Rows>
        <Row label="Espera más antigua" tone={pendingAge !== null && pendingAge > MEDIA_LATE_MS ? "warning" : undefined}>
          {q.oldest_pending ? (
            <>
              <strong>{q.oldest_pending.label}</strong> ({q.oldest_pending.status}) desde <When iso={q.oldest_pending.since} nowMs={nowMs} />
            </>
          ) : (
            "nada esperando"
          )}
        </Row>
        <Row label="Último analizado">
          {q.last_analyzed ? (
            <>
              <strong>{q.last_analyzed.label}</strong> <When iso={q.last_analyzed.at} nowMs={nowMs} />
              {q.last_analyzed.engine && <span className="ml-1.5 text-xs text-muted">({q.last_analyzed.engine})</span>}
            </>
          ) : (
            "ninguno todavía"
          )}
        </Row>
        {q.last_failed && (
          <Row label="Último fallido" tone="critical">
            <strong>{q.last_failed.label}</strong>: {q.last_failed.error ?? "sin detalle"}
          </Row>
        )}
      </Rows>
    </DiagPanel>
  );
}

function UtteranceLine({ u, nowMs }: { u: DiagnosticsUtterance; nowMs: number }) {
  const tone = UTTERANCE_STATE_TONE[u.state];
  const label = u.state === "pantalla" && u.screen_reason ? SCREEN_REASON_LABEL[u.screen_reason] : UTTERANCE_STATE_LABEL[u.state];
  return (
    <li className="border-t border-line py-1.5 first:border-t-0">
      <div className="flex flex-wrap items-center gap-1.5 text-xs">
        <span className="font-mono text-muted">#{u.seq}</span>
        <When iso={u.at} nowMs={nowMs} />
        <Badge tone="neutral">{KIND_LABEL[u.kind as VigiaKind] ?? u.kind}</Badge>
        {u.priority === "persona" && <Badge tone="critical">persona</Badge>}
        <Badge tone={DIAG_TONE[tone]} dot>
          {label}
        </Badge>
        {u.rules.map((r) => (
          <Badge key={r} tone="info" title="Regla dura aplicada al texto">
            {ruleLabel(r)}
          </Badge>
        ))}
        {u.engine === "plantilla" && <span className="text-faint">plantilla</span>}
      </div>
      <p className="mt-0.5 line-clamp-2 text-sm text-text">{u.text}</p>
    </li>
  );
}

function OutboxPanel({ d, nowMs, status }: { d: IncidentDiagnostics; nowMs: number; status?: SubsystemStatus }) {
  const o = d.outbox;
  const free = voiceFreeInMs(d, nowMs);
  const lastTurnAge = ageMs(o.last_turn?.at, nowMs);
  return (
    <DiagPanel id="salida" status={status}>
      {!o.agent_enabled && <Callout tone="muted">El agente está apagado (VIGIA_AGENT=0): Vigía no escucha ni habla.</Callout>}
      {o.last_error && (
        <Callout tone="critical">
          <strong>Última vuelta con error:</strong> {o.last_error}
        </Callout>
      )}
      <Rows>
        <Row label="Ventana de voz" tone={free === null ? "ok" : "warning"}>
          <span className="tabular" suppressHydrationWarning>
            {free === null ? "libre: puede hablar" : `faltan ${Math.ceil(free / 1000)} s (máx. 1 mensaje cada ${Math.round(o.voice_interval_ms / 1000)} s, salvo persona)`}
          </span>
        </Row>
        <Row label="Agente habló">
          <When iso={o.last_spoken_at} nowMs={nowMs} />
        </Row>
        <Row label="Puente dijo">
          {o.bridge_spoken ? <When iso={o.bridge_spoken.at} nowMs={nowMs} /> : <span className="text-faint">nada informado</span>}
        </Row>
        <Row label="Silencio" tone={o.silenced ? "warning" : undefined}>
          {o.silenced ? "sí: solo pantalla, salvo posible persona" : "no"}
        </Row>
        <Row label="Última vuelta" tone={lastTurnAge !== null && lastTurnAge > 15_000 && (o.unread_comms > 0 || o.unseen_media > 0) ? "warning" : undefined}>
          {o.last_turn ? (
            <>
              <When iso={o.last_turn.at} nowMs={nowMs} />
              <span className="ml-1.5 text-xs text-muted">
                {o.thinking ? "pensando ahora…" : o.last_turn.thought ? `pensó (${o.last_turn.engine ?? "—"})` : "sin novedades"}
              </span>
            </>
          ) : (
            <span className="text-faint">ninguna en esta instancia</span>
          )}
        </Row>
        <Row label="Última vez que pensó">
          {o.last_thought ? (
            <>
              <When iso={o.last_thought.at} nowMs={nowMs} />
              <span className="ml-1.5 text-xs text-muted">
                {o.last_thought.engine ?? "—"} · {formatMs(o.last_thought.ms)} · {o.last_thought.events.join(", ") || "sin eventos"}
              </span>
            </>
          ) : (
            <span className="text-faint">todavía no</span>
          )}
        </Row>
        <Row label="Sin mirar" tone={o.unread_comms + o.unseen_media > 0 ? "warning" : undefined}>
          {o.unread_comms} radio · {o.unseen_media} videos
        </Row>
        <Row label="OBAC">
          {o.unanswered_questions} {o.unanswered_questions === 1 ? "pregunta" : "preguntas"} sin responder · {o.open_pending} pendientes abiertos
        </Row>
      </Rows>

      <SubHeading>En cola para la radio ({o.waiting.length})</SubHeading>
      {o.waiting.length === 0 ? (
        <p className="text-sm text-muted">Nada esperando.</p>
      ) : (
        <ul>
          {o.waiting.map((u) => (
            <UtteranceLine key={u.seq} u={u} nowMs={nowMs} />
          ))}
        </ul>
      )}
      <p className="mt-1 text-[11px] text-faint">
        {o.queue_exact
          ? "Cola informada por el puente en su último latido (cada ~10 s); lo más nuevo cuenta como en cola."
          : "Cola estimada (el puente no la informa): con lo último que dijo y su plazo de 45 s."}
      </p>

      <SubHeading>Bloqueados por las reglas ({o.blocked.length})</SubHeading>
      {o.blocked.length === 0 ? (
        <p className="text-sm text-muted">Ninguno.</p>
      ) : (
        <ul>
          {o.blocked.map((b, i) => (
            <li key={`${b.at}-${i}`} className="border-t border-line py-1.5 first:border-t-0">
              <div className="flex flex-wrap items-center gap-1.5 text-xs">
                <When iso={b.at} nowMs={nowMs} />
                {b.reasons.map((r) => (
                  <Badge key={r} tone="critical">
                    {ruleLabel(r)}
                  </Badge>
                ))}
              </div>
              <p className="mt-0.5 line-clamp-2 text-sm text-muted">«{b.text}»</p>
            </li>
          ))}
        </ul>
      )}

      <SubHeading>Últimos mensajes ({o.recent.length})</SubHeading>
      {o.recent.length === 0 ? (
        <p className="text-sm text-muted">Vigía todavía no ha dicho nada.</p>
      ) : (
        <ul className="max-h-96 overflow-y-auto">
          {o.recent.map((u) => (
            <UtteranceLine key={u.seq} u={u} nowMs={nowMs} />
          ))}
        </ul>
      )}
    </DiagPanel>
  );
}

function ErrorLine({ e, nowMs, incidentId }: { e: DiagnosticsServerError; nowMs: number; incidentId: string }) {
  const age = ageMs(e.at, nowMs) ?? Infinity;
  const tone: DiagTone = age <= 120_000 ? "critical" : age <= 15 * 60_000 ? "warning" : "muted";
  return (
    <li className="border-t border-line py-1.5 first:border-t-0">
      <div className="flex flex-wrap items-center gap-1.5 text-xs">
        <StatusDot tone={DIAG_TONE[tone]} />
        <When iso={e.at} nowMs={nowMs} />
        <Badge tone="neutral">{SOURCE_LABEL[e.source]}</Badge>
        {e.count > 1 && (
          <span className="font-semibold text-text" title={`Desde las ${formatClock(e.first_at)}`}>
            ×{e.count}
          </span>
        )}
        {e.incident_id && e.incident_id !== incidentId && <span className="text-faint">{e.incident_code ?? "otra emergencia"}</span>}
      </div>
      <p className="mt-0.5 font-mono text-xs break-words text-text">{e.message}</p>
    </li>
  );
}

function ErrorsPanel({ d, nowMs, status }: { d: IncidentDiagnostics; nowMs: number; status?: SubsystemStatus }) {
  return (
    <DiagPanel id="errores" status={status}>
      {d.errors.length === 0 ? (
        <p className="text-sm text-muted">Sin errores registrados desde que arrancó esta instancia del servidor.</p>
      ) : (
        <ul>
          {d.errors.map((e, i) => (
            <ErrorLine key={`${e.first_at}-${i}`} e={e} nowMs={nowMs} incidentId={d.incident.id} />
          ))}
        </ul>
      )}
      <p className="mt-2 text-[11px] text-faint">
        Agente, transcripción, subidas, puente Zello, análisis, detector y dron. Los repetidos se agrupan (×N).
      </p>
    </DiagPanel>
  );
}

/* ───────────────────────────── Vista ───────────────────────────── */

export interface DiagnosticsDetailProps {
  incidentId: string;
  /** Panel al que saltar al abrir (el que se tocó en la banda). */
  focus: SubsystemId | null;
  onClose: () => void;
}

/** Los paneles del detalle con datos ya leídos (sin sondeo: probado en DiagnosticsDetail.test.tsx). */
export function DiagnosticsPanels({ d, nowMs, items }: { d: IncidentDiagnostics; nowMs: number; items: SubsystemStatus[] | null }) {
  const by = (id: SubsystemId) => items?.find((s) => s.id === id);
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] items-start gap-3 lg:grid-cols-2 2xl:grid-cols-3">
      <div className="grid gap-3">
        <ZelloPanel d={d} nowMs={nowMs} status={by("zello")} />
        <EnginePanel d={d} status={by("motor")} />
      </div>
      <div className="grid gap-3">
        <OutboxPanel d={d} nowMs={nowMs} status={by("salida")} />
      </div>
      <div className="grid gap-3 lg:col-span-2 2xl:col-span-1">
        <ClaudePanel d={d} nowMs={nowMs} status={by("claude")} />
        <DetectorPanel d={d} nowMs={nowMs} status={by("detector")} />
        <ErrorsPanel d={d} nowMs={nowMs} status={by("errores")} />
      </div>
    </div>
  );
}

export function DiagnosticsDetail({ incidentId, focus, onClose }: DiagnosticsDetailProps) {
  const { d, nowMs, items, offline } = useLiveDiagnostics(incidentId);
  const ready = d !== null;

  // Escape vuelve a la operación (el botón de la banda hace lo mismo).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.defaultPrevented) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Salta al panel tocado en la banda al abrir (o al llegar los datos), no en cada sondeo.
  useEffect(() => {
    if (!focus || !ready) return;
    document.getElementById(sectionId(focus))?.scrollIntoView({ block: "start", behavior: "smooth" });
  }, [focus, ready]);

  return (
    <div className="mx-auto max-w-[1680px] p-3 sm:p-4">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <ListOrdered aria-hidden className="size-4 text-muted" />
        <h2 className="text-base font-semibold">Diagnóstico técnico{d ? ` · ${d.incident.code}` : ""}</h2>
        <span className="text-xs text-muted" suppressHydrationWarning>
          {d ? `actualizado ${agoText(d.server_time, nowMs)} · cada 3 s · ` : ""}lo que está en memoria es de esta instancia del
          servidor · Esc para volver
        </span>
      </div>
      {offline && (
        <div className="mb-3">
          <Callout tone="critical">
            <strong>Sin datos frescos del servidor</strong> {offline.since ?? ""}: {offline.message}
          </Callout>
        </div>
      )}
      {!d ? (
        offline ? (
          <EmptyState icon={AlertTriangle} title="No se pudo leer el diagnóstico" description={offline.message} />
        ) : (
          <div role="status" className="flex items-center gap-2 p-6 text-sm text-muted">
            <Spinner size="sm" label="Cargando" />
            Revisando los sistemas…
          </div>
        )
      ) : (
        <DiagnosticsPanels d={d} nowMs={nowMs} items={items} />
      )}
    </div>
  );
}

