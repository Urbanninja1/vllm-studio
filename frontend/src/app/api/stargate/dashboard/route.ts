/**
 * Flight Ops Dashboard aggregation — one fetch returns everything the
 * Dashboard component renders: GPUs, services, running models, disks.
 *
 * Backends (all local, Tailscale-gated):
 *   - Stargate Agent API   :8096  — /system/gpu, /system/services, /system/disk
 *   - llama-swap           :8080  — /running (direct, no Agent API proxy)
 *
 * Shape is stable with `useDashboardData()` in
 * `@/components/flight-ops/Dashboard`. If that component's types change,
 * update this route's transforms in the same PR.
 *
 * Failure mode: if any upstream is down, that section returns `[]` and the
 * Dashboard renders the panel empty rather than crashing. No cascading
 * failures across panels.
 */

import { NextResponse } from "next/server";

const AGENT_API = process.env.STARGATE_AGENT_API_URL ?? "http://localhost:8096";
const LLAMA_SWAP = process.env.STARGATE_LLAMA_SWAP_URL ?? "http://localhost:8080";

// Mode C layout (per `.claude/rules/gpu-management.md`). Static because PCI
// addresses + role assignments are fixed at the hardware level.
const GPU_LAYOUT: Record<number, { label: GPULabel; pci: string; kind: GPUKind }> = {
  0: { label: "P6000 #0", pci: "01:00", kind: "persist" },
  1: { label: "P6000 #1", pci: "02:00", kind: "service" },
  2: { label: "3090 #2", pci: "41:00", kind: "persist" },
  3: { label: "3090 #3", pci: "61:00", kind: "giant" },
};

type GPULabel = "P6000 #0" | "P6000 #1" | "3090 #2" | "3090 #3";
type GPUKind = "persist" | "service" | "giant" | "on-demand";
type ServiceState = "active" | "degraded" | "failed";
type DiskState = "ok" | "warn" | "alert" | "disabled";
type RunningState = "running" | "idle";

interface AgentGPU {
  index: number;
  name: string;
  memory_used_mb: number;
  memory_total_mb: number;
  memory_free_mb: number;
  utilization_pct: number;
  temperature_c: number;
  power_draw_w: number;
}

interface AgentService {
  name: string;
  state: string;
  status?: string;
  health?: string;
}

interface LlamaRunning {
  model: string;
  state?: string;
}

async function fetchJson<T>(url: string, timeoutMs = 2500): Promise<T | null> {
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    const res = await fetch(url, { signal: ctl.signal, cache: "no-store" });
    clearTimeout(t);
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

/** Map Agent API GPU record → Dashboard GPU shape. */
function transformGpus(raw: AgentGPU[] | null, runningByGpu: Map<number, string[]>): unknown[] {
  if (!raw) return [];
  return raw.slice(0, 4).map((g) => {
    const layout = GPU_LAYOUT[g.index];
    const heroList = runningByGpu.get(g.index) ?? [];
    const hero_model =
      heroList.length > 1 ? heroList : heroList[0] ?? undefined;
    return {
      id: g.index,
      cuda: g.index,
      pci: layout?.pci ?? "??:??",
      name: g.name,
      label: layout?.label ?? (`GPU ${g.index}` as GPULabel),
      kind: layout?.kind ?? "on-demand",
      vram_used_mb: g.memory_used_mb,
      vram_total_mb: g.memory_total_mb,
      temp_c: g.temperature_c,
      power_w: Math.round(g.power_draw_w),
      util_pct: g.utilization_pct,
      hero_model,
    };
  });
}

/** Clean Docker container noise from service names + bucket state. */
function transformServices(
  docker: AgentService[] | null,
  systemd: Record<string, string> | null,
): unknown[] {
  const out: { name: string; port: number; state: ServiceState }[] = [];

  // Docker services — name cleanup (strip container prefix hashes)
  for (const s of docker ?? []) {
    const clean = s.name.replace(/^[a-f0-9]{12}_/, "").replace(/^stargate-/, "");
    const state: ServiceState =
      s.state === "running" && s.health !== "unhealthy"
        ? "active"
        : s.state === "running"
          ? "degraded"
          : "failed";
    out.push({ name: clean, port: 0, state });
  }

  // Systemd services — port unknown, state = active/inactive/failed
  for (const [name, state] of Object.entries(systemd ?? {})) {
    const clean = name.replace(/^stargate-/, "");
    const s: ServiceState =
      state === "active" ? "active" : state === "inactive" ? "degraded" : "failed";
    out.push({ name: clean, port: 0, state: s });
  }

  return out;
}

/** Map llama-swap /running payload → Dashboard RunningModel + GPU index map. */
function transformRunning(
  raw: { running?: LlamaRunning[] } | null,
): { running: unknown[]; byGpu: Map<number, string[]> } {
  const byGpu = new Map<number, string[]>();
  const list = raw?.running ?? [];
  const out = list.map((r) => {
    // Heuristic: model name suffix encodes GPU assignment. This is soft —
    // the source of truth is llama-swap config, but the Dashboard already
    // tolerates "?" via the `gpu_label` being a string. Strict mapping
    // lives in llama-swap's own config; here we just do best-effort.
    let gpu_label = "?";
    let gpu_index: number | null = null;
    if (r.model.includes("-p6000")) {
      gpu_label = r.model.endsWith("-p6000") ? "P6000 #0" : "P6000 #1";
      gpu_index = r.model.endsWith("-p6000") ? 0 : 1;
    } else if (r.model.startsWith("gemma-4-31b-uncensored")) {
      gpu_label = "3090 #2";
      gpu_index = 2;
    } else {
      gpu_label = "3090 #3";
      gpu_index = 3;
    }
    if (gpu_index !== null) {
      const existing = byGpu.get(gpu_index) ?? [];
      existing.push(r.model);
      byGpu.set(gpu_index, existing);
    }
    const state: RunningState = r.state === "running" ? "running" : "idle";
    return {
      id: r.model,
      gpu_label,
      vram_mb: 0,
      ttl_s: null,
      gen_tok_s: null,
      prompt_tok_s: null,
      state,
      notes: "",
    };
  });
  return { running: out, byGpu };
}

/** Mode C known mount layout — disk data is stable, hardcoded acceptable. */
function transformDisks(
  raw: { disks?: { mount: string; used_gb: number; total_gb: number }[] } | null,
): unknown[] {
  if (!raw?.disks) return [];
  return raw.disks.map((d) => {
    const pct = d.total_gb > 0 ? Math.round((d.used_gb / d.total_gb) * 100) : 0;
    const state: DiskState =
      pct >= 90 ? "alert" : pct >= 70 ? "warn" : pct === 0 ? "disabled" : "ok";
    return {
      mount: d.mount,
      device: "",
      used_gb: d.used_gb,
      total_gb: d.total_gb,
      pct,
      state,
    };
  });
}

export async function GET() {
  const [gpuRaw, servicesRaw, runningRaw, diskRaw] = await Promise.all([
    fetchJson<{ gpus: AgentGPU[] }>(`${AGENT_API}/system/gpu`),
    fetchJson<{ docker: AgentService[]; systemd: Record<string, string> }>(
      `${AGENT_API}/system/services`,
    ),
    fetchJson<{ running: LlamaRunning[] }>(`${LLAMA_SWAP}/running`),
    fetchJson<{ disks: { mount: string; used_gb: number; total_gb: number }[] }>(
      `${AGENT_API}/system/disk`,
    ),
  ]);

  const { running, byGpu } = transformRunning(runningRaw);
  const gpus = transformGpus(gpuRaw?.gpus ?? null, byGpu);
  const services = transformServices(
    servicesRaw?.docker ?? null,
    servicesRaw?.systemd ?? null,
  );
  const disks = transformDisks(diskRaw ?? null);

  return NextResponse.json({
    gpus,
    services,
    running,
    disks,
    lastTickMs: 2000,
    sources: {
      agent_api: gpuRaw !== null,
      llama_swap: runningRaw !== null,
    },
    fetched_at: new Date().toISOString(),
  });
}
