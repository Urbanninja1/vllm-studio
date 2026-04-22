/**
 * Dashboard — GPU row + service grid + running models + disk usage.
 *
 * DATA STRATEGY (Lane 2):
 *   - /api/stargate/system/gpu       → 2s poll, swr fallback 10s — 4-GPU payload
 *   - /api/stargate/system/services  → 5s poll, swr fallback 30s
 *   - /api/recipes/running           → SSE (controller event-manager) on hover of
 *     Running panel, poll 2s otherwise. Controller already fires `model-loaded` /
 *     `model-unloaded` events (event-manager.ts), wire straight through.
 *   - /api/stargate/system/disk      → 30s poll, cache-stale 2m
 *
 * AESTHETIC COMMITMENTS:
 *   - Hero numeric per GPU panel — VRAM GB / total, tabular, 32px.
 *   - One saturated color (accent cyan) — used only for persist/active/running
 *     signals and selected nav. Alerts use terracotta (not fire-red).
 *   - Corner-bracket panels, hairline dividers between rows, no cards.
 *   - Odometer component wraps any live numeric so digit-column updates feel
 *     mechanical, not janky. Crucial detail.
 *
 * KEYBOARD:
 *   - gpu-0 / gpu-1 / gpu-2 / gpu-3 cycle with 1–4
 *   - R = refresh all
 *   - L = jump to logs filtered on that GPU
 */

"use client";

import { useEffect, useState } from "react";
import { Panel, PanelAction } from "./Panel";
import { Odometer } from "./Odometer";

/* =========================================================================
   Types — matches Agent API /system/gpu and llama-swap /running contracts.
   ========================================================================= */

interface GPU {
  id: 0 | 1 | 2 | 3;
  cuda: number;
  pci: string;
  name: string;
  label: "P6000 #0" | "P6000 #1" | "3090 #2" | "3090 #3";
  kind: "persist" | "service" | "giant" | "on-demand";
  vram_used_mb: number;
  vram_total_mb: number;
  temp_c: number;
  power_w: number;
  util_pct: number;
  hero_model?: string | string[];
  /** Where speed lives on the giant GPU. */
  gen_tok_s?: number;
  /** Only the giant has an RAM-experts number. */
  ram_experts_gb?: number;
}

interface Service {
  name: string;
  port: number;
  state: "active" | "degraded" | "failed";
}

interface RunningModel {
  id: string;
  gpu_label: string;
  vram_mb: number;
  ttl_s: number | null;  // null = persistent
  gen_tok_s: number | null;
  prompt_tok_s: number | null;
  state: "running" | "idle";
  notes?: string;
}

interface DiskRow {
  mount: string;
  device: string;
  used_gb: number;
  total_gb: number;
  pct: number;
  state: "ok" | "warn" | "alert" | "disabled";
}

/* ========================================================================= */

export function Dashboard() {
  const { gpus, services, running, disks, lastTickMs } = useDashboardData();

  return (
    <div className="flex flex-col gap-6">
      <header className="flex items-baseline gap-4 border-b border-[var(--color-ink-4)] pb-4">
        <h1 className="font-display text-[22px] font-semibold tracking-[-0.01em]">Dashboard</h1>
        <p className="font-mono text-[11px] tracking-[0.05em] text-[var(--color-fg-3)]">
          MODE C — 4 GPU / 96 GB VRAM ·{" "}
          <span className="text-[var(--color-ok)]">LIVE</span> · polling every{" "}
          <Odometer value={(lastTickMs / 1000).toFixed(1)} />s
        </p>
      </header>

      {/* GPU ROW — 4 across on desktop, 2×2 on laptop, stacked on tablet */}
      <div className="grid gap-4 grid-cols-1 md:grid-cols-2 xl:grid-cols-4">
        {gpus.map((g) => (
          <GPUPanel key={g.id} gpu={g} />
        ))}
      </div>

      {/* SERVICES + DISK — 8/4 split */}
      <div className="grid gap-4 grid-cols-1 lg:grid-cols-3">
        <ServiceGrid services={services} className="lg:col-span-2" />
        <DiskPanel disks={disks} />
      </div>

      {/* RUNNING MODELS full-width */}
      <RunningPanel running={running} />
    </div>
  );
}

/* =========================================================================
   GPU PANEL — the hero component on this page.
   One big tabular number. VRAM bar with tick marks. 3 sub-metrics. Hero model.
   ========================================================================= */

function GPUPanel({ gpu }: { gpu: GPU }) {
  const pct = (gpu.vram_used_mb / gpu.vram_total_mb) * 100;
  const hot = pct > 90;

  const kindBadge = {
    persist: { label: "PERSIST", cls: "model-badge persist" },
    service: { label: "SERVICE", cls: "model-badge persist" },
    giant:   { label: "GIANT",   cls: "model-badge persist" },
    "on-demand": { label: "ON-DEMAND", cls: "model-badge ondemand" },
  }[gpu.kind];

  return (
    <Panel
      interactive
      ariaLabel={`${gpu.label} — ${(gpu.vram_used_mb / 1024).toFixed(1)} of ${(gpu.vram_total_mb / 1024).toFixed(0)} GB VRAM`}
    >
      <div className="flex items-start justify-between mb-1">
        <div>
          <div className="font-display text-[10px] font-semibold tracking-[0.18em] uppercase text-[var(--color-fg-3)]">
            GPU {gpu.id} · CUDA {gpu.cuda} · PCI {gpu.pci}
          </div>
          <div className="font-display text-[13px] font-medium text-[var(--color-fg-1)] mt-0.5">
            {gpu.name}{" "}
            <span className="text-[var(--color-accent)]">{gpu.label.replace(/^[^#]*/, "")}</span>
          </div>
        </div>
        <span className={kindBadge.cls + " shrink-0"}>{kindBadge.label}</span>
      </div>

      {/* Hero metric */}
      <div className="font-mono text-[32px] font-medium tracking-[-0.02em] leading-none flex items-baseline gap-1 mt-3 mb-1">
        <Odometer value={(gpu.vram_used_mb / 1024).toFixed(1)} />
        <span className="text-[var(--color-fg-4)]">/</span>
        <span className="text-[var(--color-fg-3)] text-[18px]">
          {(gpu.vram_total_mb / 1024).toFixed(1)}
        </span>
        <span className="text-[11px] text-[var(--color-fg-3)] uppercase tracking-[0.08em] ml-1.5">
          GB
        </span>
      </div>

      <VRAMBar pct={pct} hot={hot} ticks={[25, 50, 75]} />

      {/* Three sub-metrics */}
      <div className="grid grid-cols-3 gap-2 pt-2 mt-2 border-t border-[var(--color-ink-4)]">
        <SubMetric label="TEMP" value={gpu.temp_c} unit="°C" />
        <SubMetric label="POWER" value={gpu.power_w} unit="W" dim />
        {gpu.kind === "giant" ? (
          <SubMetric label="TOK/S" value={gpu.gen_tok_s ?? 0} fmt={(v) => v.toFixed(1)} />
        ) : (
          <SubMetric label="UTIL" value={gpu.util_pct} unit="%" />
        )}
      </div>

      {/* Hero model list */}
      <div className="pt-2 mt-2 border-t border-[var(--color-ink-4)] font-mono text-[11px] leading-relaxed text-[var(--color-fg-2)]">
        {Array.isArray(gpu.hero_model) ? (
          gpu.hero_model.map((m) => (
            <div key={m}>
              <span className="text-[var(--color-accent)]">▸</span> {m}
            </div>
          ))
        ) : gpu.hero_model ? (
          <>
            <span className="text-[var(--color-accent)]">▸</span> {gpu.hero_model}
          </>
        ) : null}
      </div>
    </Panel>
  );
}

function VRAMBar({ pct, hot, ticks = [] }: { pct: number; hot?: boolean; ticks?: number[] }) {
  return (
    <div
      className="relative h-1.5 bg-[var(--color-ink-3)]"
      role="progressbar"
      aria-valuenow={Math.round(pct)}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label="VRAM usage"
    >
      <div
        className={
          "absolute inset-y-0 left-0 transition-[width] duration-[var(--duration-slow)] ease-[cubic-bezier(0.2,0.9,0.2,1)] " +
          (hot
            ? "bg-gradient-to-r from-[var(--color-warn)] to-[var(--color-alert)]"
            : "bg-gradient-to-r from-[var(--color-accent)] to-[var(--color-accent-dim)]")
        }
        style={{ width: `${Math.min(100, pct)}%` }}
      />
      {ticks.map((t) => (
        <span
          key={t}
          className="absolute top-0 bottom-0 w-px bg-[var(--color-ink-1)]"
          style={{ left: `${t}%` }}
          aria-hidden
        />
      ))}
    </div>
  );
}

function SubMetric({
  label,
  value,
  unit,
  dim,
  fmt,
}: {
  label: string;
  value: number;
  unit?: string;
  dim?: boolean;
  fmt?: (v: number) => string;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="font-display text-[9px] tracking-[0.14em] uppercase text-[var(--color-fg-3)]">
        {label}
      </span>
      <span
        className={
          "font-mono text-[14px] " + (dim ? "text-[var(--color-fg-2)]" : "text-[var(--color-fg-1)]")
        }
      >
        <Odometer value={fmt ? fmt(value) : value.toString()} />
        {unit && <span className="text-[var(--color-fg-3)] text-[10px]">{unit}</span>}
      </span>
    </div>
  );
}

/* =========================================================================
   SERVICE GRID — 3-col hairline grid, dots bit-encode state.
   ========================================================================= */

function ServiceGrid({ services, className }: { services: Service[]; className?: string }) {
  return (
    <Panel
      className={className}
      title="Service Health"
      count={`${services.length} units · ${services.filter((s) => s.state === "active").length} active`}
      actions={
        <>
          <PanelAction>REFRESH</PanelAction>
          <PanelAction>FILTER</PanelAction>
        </>
      }
    >
      <div className="grid grid-cols-2 md:grid-cols-3 gap-px bg-[var(--color-ink-4)]">
        {services.map((s) => (
          <div
            key={s.port}
            className="bg-[var(--color-ink-2)] hover:bg-[var(--color-ink-3)] transition-colors
                       duration-[var(--duration-fast)] px-4 py-2 flex items-center gap-2"
            role="status"
            aria-label={`${s.name} on port ${s.port} is ${s.state}`}
          >
            <StatusDot state={s.state} />
            <span className="text-[12px] text-[var(--color-fg-1)] flex-1 truncate">{s.name}</span>
            <span className="font-mono text-[10px] text-[var(--color-fg-3)]">:{s.port}</span>
          </div>
        ))}
      </div>
    </Panel>
  );
}

export function StatusDot({
  state,
  pulse,
}: {
  state: "active" | "degraded" | "failed" | "ok" | "warn" | "alert";
  pulse?: boolean;
}) {
  const color =
    state === "active" || state === "ok"
      ? "var(--color-ok)"
      : state === "degraded" || state === "warn"
      ? "var(--color-warn)"
      : "var(--color-alert)";
  return (
    <span
      className={"inline-block w-1.5 h-1.5 rounded-full shrink-0 " + (pulse ? "dot-pulse" : "")}
      style={{ background: color, boxShadow: `0 0 6px ${color}` }}
      aria-hidden
    />
  );
}

/* =========================================================================
   RUNNING MODELS — wide table with tabular-num alignment.
   ========================================================================= */

function RunningPanel({ running }: { running: RunningModel[] }) {
  return (
    <Panel
      scanning
      title="Running Models"
      count={`via llama-swap :8080 · ${running.length} loaded`}
      actions={
        <>
          <PanelAction>RELOAD CFG</PanelAction>
          <PanelAction>EVICT ALL</PanelAction>
        </>
      }
    >
      <div role="table" className="flex flex-col">
        <div
          role="row"
          className="grid items-center gap-4 px-1 py-1 font-display text-[10px] tracking-[0.14em] uppercase text-[var(--color-fg-3)]"
          style={{ gridTemplateColumns: "8px 2fr 1fr 1fr 80px" }}
        >
          <div />
          <div>Model</div>
          <div>VRAM · TTL</div>
          <div>Gen · Prompt</div>
          <div className="text-right">Action</div>
        </div>
        {running.map((r) => (
          <div
            key={r.id}
            role="row"
            className="grid items-center gap-4 px-1 py-2 border-b border-[var(--color-ink-4)] last:border-b-0
                       hover:bg-[var(--color-ink-3)] transition-colors duration-[var(--duration-fast)]"
            style={{ gridTemplateColumns: "8px 2fr 1fr 1fr 80px" }}
          >
            <span
              className="w-1.5 h-1.5 block"
              style={{
                background: r.state === "running" ? "var(--color-ok)" : "var(--color-warn)",
              }}
              aria-hidden
            />
            <div className="font-display text-[13px] font-medium text-[var(--color-fg-1)]">
              {r.id}
              {r.notes && (
                <span className="font-mono text-[10px] font-normal text-[var(--color-fg-3)] ml-2">
                  · {r.notes}
                </span>
              )}
            </div>
            <div className="font-mono text-[11px] text-[var(--color-fg-2)]">
              {(r.vram_mb / 1024).toFixed(1)} GB ·{" "}
              {r.ttl_s === null ? "∞" : formatTTL(r.ttl_s)}
            </div>
            <div className="font-mono text-[11px] text-[var(--color-fg-2)]">
              {r.gen_tok_s !== null && r.prompt_tok_s !== null ? (
                <>
                  <Odometer value={r.gen_tok_s.toFixed(1)} /> /{" "}
                  <Odometer value={r.prompt_tok_s.toString()} /> t/s
                </>
              ) : (
                <span className="text-[var(--color-fg-3)]">idle</span>
              )}
            </div>
            <button
              className="justify-self-end font-display text-[10px] tracking-[0.14em] uppercase
                         text-[var(--color-accent)] px-2 py-1 border border-transparent
                         hover:border-[var(--color-accent)]
                         hover:bg-[color-mix(in_srgb,var(--color-accent)_8%,transparent)]
                         transition-all duration-[var(--duration-fast)]"
              aria-label={`Unload ${r.id}`}
            >
              UNLOAD
            </button>
          </div>
        ))}
      </div>
    </Panel>
  );
}

function formatTTL(sec: number): string {
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ${sec % 60}s`;
  return `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m`;
}

/* =========================================================================
   DISK PANEL — minimal sparkline-style bars, 4 rows max typical.
   ========================================================================= */

function DiskPanel({ disks }: { disks: DiskRow[] }) {
  return (
    <Panel title="Storage" actions={<PanelAction>DETAILS</PanelAction>}>
      <div className="flex flex-col">
        {disks.map((d) => (
          <div
            key={d.mount}
            className="grid items-center gap-4 px-1 py-1.5 border-b border-[var(--color-ink-4)] last:border-b-0"
            style={{ gridTemplateColumns: "1fr auto auto" }}
          >
            <div className="font-mono text-[12px] text-[var(--color-fg-1)]">
              {d.mount}
              <span className="text-[var(--color-fg-3)]"> · {d.device}</span>
            </div>
            <div className="w-[180px] h-[3px] bg-[var(--color-ink-3)] relative">
              <div
                className="absolute inset-y-0 left-0"
                style={{
                  width: `${d.pct}%`,
                  background:
                    d.state === "alert"
                      ? "var(--color-alert)"
                      : d.state === "warn"
                      ? "var(--color-warn)"
                      : d.state === "disabled"
                      ? "transparent"
                      : "var(--color-fg-2)",
                }}
              />
            </div>
            <div
              className={
                "font-mono text-[11px] min-w-[64px] text-right " +
                (d.state === "disabled" ? "text-[var(--color-fg-3)]" : "text-[var(--color-fg-2)]")
              }
            >
              {d.state === "disabled"
                ? `— / ${d.total_gb} GB`
                : `${d.used_gb.toFixed(1)} / ${d.total_gb.toFixed(1)} ${d.total_gb > 1000 ? "TB" : "GB"}`}
            </div>
          </div>
        ))}
      </div>
    </Panel>
  );
}

/* =========================================================================
   Data hook — /api/stargate/* poll + SSE subscription for running models.
   Gracefully degrades on controller-down → read-only last-known state.
   ========================================================================= */

/* ============================================================
 * Live backend — hits /api/stargate/dashboard which aggregates
 * Agent API (:8096) + llama-swap (:8080) in one server-side fetch.
 * Polls every 2s while the tab is visible; pauses on hide.
 * Falls back to baked defaults if the backend is unreachable so
 * the UI doesn't stutter during transient gateway errors.
 * ============================================================ */

interface DashboardPayload {
  gpus: GPU[];
  services: Service[];
  running: RunningModel[];
  disks: DiskRow[];
  lastTickMs: number;
  sources: { agent_api: boolean; llama_swap: boolean };
  fetched_at: string;
}

function useDashboardData() {
  const [payload, setPayload] = useState<DashboardPayload>(() => ({
    gpus: FALLBACK_GPUS,
    services: FALLBACK_SERVICES,
    running: FALLBACK_RUNNING,
    disks: FALLBACK_DISKS,
    lastTickMs: 2000,
    sources: { agent_api: false, llama_swap: false },
    fetched_at: new Date().toISOString(),
  }));

  useEffect(() => {
    let cancelled = false;
    const pull = async () => {
      try {
        const r = await fetch("/api/stargate/dashboard", { cache: "no-store" });
        if (!r.ok) return;
        const j = (await r.json()) as DashboardPayload;
        if (cancelled) return;
        // Empty arrays = upstream down; keep previous payload to avoid UI flash
        if ((j.gpus?.length ?? 0) > 0) setPayload(j);
      } catch {
        // swallow — next tick retries
      }
    };
    pull();
    const onVis = () => {
      if (!document.hidden) pull();
    };
    document.addEventListener("visibilitychange", onVis);
    const id = setInterval(() => {
      if (!document.hidden) pull();
    }, 2000);
    return () => {
      cancelled = true;
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, []);

  return payload;
}

/* Fallback data — rendered only until first backend response arrives. */
const FALLBACK_GPUS: GPU[] = [
    {
      id: 0, cuda: 0, pci: "01:00",
      name: "Quadro P6000", label: "P6000 #0",
      kind: "persist",
      vram_used_mb: 22528, vram_total_mb: 24576,
      temp_c: 61, power_w: 178, util_pct: 87,
      hero_model: "qwen3.6-35b-a3b-hauhau-p6000",
    },
    {
      id: 1, cuda: 1, pci: "02:00",
      name: "Quadro P6000", label: "P6000 #1",
      kind: "service",
      vram_used_mb: 22732, vram_total_mb: 24576,
      temp_c: 58, power_w: 92, util_pct: 31,
      hero_model: [
        "qwen3-embed · reranker",
        "glm-ocr · gemma-4-e4b",
        "splade · pyannote · kokoro",
      ],
    },
    {
      id: 2, cuda: 2, pci: "41:00",
      name: "RTX 3090 NVLINK", label: "3090 #2",
      kind: "persist",
      vram_used_mb: 20275, vram_total_mb: 24576,
      temp_c: 67, power_w: 231, util_pct: 94,
      hero_model: "gemma-4-31b-uncensored",
    },
    {
      id: 3, cuda: 3, pci: "61:00",
      name: "RTX 3090 + CPU", label: "3090 #3",
      kind: "giant",
      vram_used_mb: 23245, vram_total_mb: 24576,
      temp_c: 70, power_w: 217, util_pct: 99,
      ram_experts_gb: 115,
      gen_tok_s: 16.2,
      hero_model: "qwen3.5-397b [--n-cpu-moe 60]",
    },
];

const FALLBACK_SERVICES: Service[] = [
    { name: "llama-swap", port: 8080, state: "active" },
    { name: "llama-swap-proxy", port: 8084, state: "active" },
    { name: "open-webui", port: 3000, state: "active" },
    { name: "comfyui", port: 8188, state: "active" },
    { name: "qdrant", port: 6333, state: "active" },
    { name: "searxng", port: 8888, state: "active" },
    { name: "parakeet-stt", port: 8090, state: "active" },
    { name: "sillytavern", port: 8181, state: "active" },
    { name: "qwen3-embed", port: 8093, state: "active" },
    { name: "qwen3-rerank", port: 8094, state: "active" },
    { name: "kokoro-tts", port: 8880, state: "degraded" },
    { name: "fish-s2-pro", port: 8882, state: "active" },
    { name: "pyannote", port: 8886, state: "active" },
    { name: "mcp-server", port: 8097, state: "active" },
    { name: "voice-gateway", port: 8098, state: "active" },
    { name: "livekit", port: 7880, state: "active" },
    { name: "agent-api", port: 8096, state: "active" },
    { name: "beszel-hub", port: 8091, state: "active" },
    { name: "docling", port: 5001, state: "active" },
    { name: "glm-ocr", port: 8087, state: "active" },
    { name: "splade", port: 8089, state: "active" },
    { name: "vllm-studio-ctrl", port: 8300, state: "failed" },
    { name: "postgresql", port: 5432, state: "active" },
];

const FALLBACK_RUNNING: RunningModel[] = [
    {
      id: "qwen3.6-35b-a3b-hauhau-p6000",
      gpu_label: "P6000 #0",
      vram_mb: 22528,
      ttl_s: null,
      gen_tok_s: 45.1,
      prompt_tok_s: 312,
      state: "running",
      notes: "gpu-0 persist",
    },
    {
      id: "gemma-4-31b-uncensored",
      gpu_label: "3090 #2",
      vram_mb: 20275,
      ttl_s: null,
      gen_tok_s: 36.4,
      prompt_tok_s: 1094,
      state: "running",
      notes: "gpu-2 persist · vision",
    },
    {
      id: "qwen3.5-397b",
      gpu_label: "3090 #3",
      vram_mb: 23245,
      ttl_s: null,
      gen_tok_s: 16.2,
      prompt_tok_s: 84,
      state: "running",
      notes: "gpu-3 + cpu · 115 GB RAM",
    },
    {
      id: "qwopus-27b",
      gpu_label: "3090 #3",
      vram_mb: 20890,
      ttl_s: 582,
      gen_tok_s: null,
      prompt_tok_s: null,
      state: "idle",
      notes: "gpu-3 on-demand",
    },
];

const FALLBACK_DISKS: DiskRow[] = [
    { mount: "/", device: "nvme0n1p2", used_gb: 2600, total_gb: 3600, pct: 72, state: "warn" },
    { mount: "/models", device: "nvme1", used_gb: 820, total_gb: 2000, pct: 41, state: "ok" },
    { mount: "/output", device: "md0", used_gb: 1400, total_gb: 8000, pct: 18, state: "ok" },
    { mount: "/swap", device: "(disabled)", used_gb: 0, total_gb: 32, pct: 0, state: "disabled" },
];
