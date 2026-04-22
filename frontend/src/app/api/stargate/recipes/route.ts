/**
 * Models/Recipes feed — reads the Stargate Agent API's model-registry
 * (canonical parse of models.yaml, 45 entries) and transforms to the
 * Flight Ops Recipe[] shape.
 *
 * Endpoint:
 *   GET /api/stargate/recipes              → { recipes: Recipe[] }
 *   GET /api/stargate/recipes?id=<model>   → { recipe: Recipe, benchmarks }
 *
 * Data path:
 *   1. Agent API `/system/model-registry?all=true` — 45 models with
 *      id/name/description/speed/context/gpu/quantization/vram_mb/base_model.
 *   2. llama-swap `/running` — overlay state=running on matching entries.
 *   3. Persistence state derived from id suffix (-p6000, -uncensored) and
 *      known Mode C roster (see `.claude/rules/gpu-management.md`).
 *
 * No direct file reads; no new dependencies. The Agent API is the
 * Stargate-side stable surface.
 */

import { NextResponse } from "next/server";

const AGENT_API = process.env.STARGATE_AGENT_API_URL ?? "http://localhost:8096";
const LLAMA_SWAP = process.env.STARGATE_LLAMA_SWAP_URL ?? "http://localhost:8080";

type Backend = "llama-swap" | "vllm" | "sglang" | "llamacpp";
type GPUPreferred = "P6000" | "3090" | "multi" | "cpu";
type RecipeState = "running" | "on-demand" | "persist";

interface Recipe {
  id: string;
  name: string;
  subtitle: string;
  backend: Backend;
  gpu_label: string;
  gpu_preferred: GPUPreferred;
  speed_tok_s: number;
  prompt_tok_s?: number;
  kv_quant: string;
  vram_mb: number;
  total_vram_mb: number;
  disk_gb: number;
  quant_name: string;
  state: RecipeState;
  uncensored: boolean;
  thinking: boolean;
  vision: boolean;
  benchmarks: { mmlu_pro?: number; gpqa?: number; math500?: number; lcb_v6?: number };
  favorite: boolean;
}

interface BenchmarkResult {
  name: string;
  score: number;
  samples: number;
  good?: boolean;
}

interface RegistryModel {
  id: string;
  name?: string;
  description?: string;
  type?: string;
  speed?: string | number;
  context?: number;
  context_native?: number;
  gpu?: string;
  agent_accessible?: boolean;
  use_cases?: string[];
  quantization?: string;
  vram_mb?: number;
  base_model?: string;
  quirks?: string[];
  sampling?: Record<string, unknown>;
}

// Mode C persistent slots (see CLAUDE.md services table). Hardcoded because
// the persistence decision is a GPU-layout invariant, not a per-model flag.
const MODE_C_PERSISTENT = new Set([
  "qwen3.6-35b-a3b-hauhau-p6000",
  "gemma-4-31b-uncensored",
  "qwen3.5-397b",
  "qwen3-embed-p6000",
  "qwen3-reranker-p6000",
  "glm-ocr-p6000",
  "gemma-4-e4b-hauhau-p6000",
]);

function toSpeedNumber(s: unknown): number {
  if (typeof s === "number") return s;
  if (typeof s !== "string") return 0;
  const m = s.match(/(\d+(?:\.\d+)?)/);
  return m ? parseFloat(m[1]) : 0;
}

function deriveBackend(id: string): Backend {
  const lower = id.toLowerCase();
  if (lower.startsWith("vllm-") || lower.includes("-vllm")) return "vllm";
  if (lower.includes("sglang") || lower.startsWith("fish-s2-pro")) return "sglang";
  return "llama-swap";
}

function deriveGpuLabel(gpu: string | undefined, id: string): string {
  const g = (gpu ?? "").toLowerCase();
  // Explicit Mode C labels first.
  if (id.endsWith("-p6000") || g.includes("p6000 #0")) return "P6000 #0";
  if (g.includes("p6000") && (g.includes("#1") || g.includes("shelf") || g.includes("service")))
    return "P6000 #1";
  if (g.includes("p6000")) return "P6000";
  if (g.includes("3090 #2")) return "3090 #2";
  if (g.includes("3090 #3")) return "3090 #3";
  // Multi / dual / both / CPU before "gpu N" — those strings win even if the
  // text also contains "gpu 0 + cpu" etc.
  if (g.includes("multi") || g.includes("dual") || g.includes("both") || g.includes("tp")) {
    if (g.includes("cpu")) return "3090 + CPU";
    return "multi-GPU";
  }
  if (g.includes("+ cpu")) return "3090 + CPU";
  // "gpu 0" / "gpu 1" comes from Mode B legacy labelling in models.yaml.
  // Mode C heuristic: gpu 0 → 3090 #2 (prior primary slot), gpu 1 → 3090 #3.
  const modeBMatch = /\bgpu\s*([0-9])\b/.exec(g);
  if (modeBMatch) {
    const idx = parseInt(modeBMatch[1], 10);
    if (idx === 0) return "3090 #2";
    if (idx === 1) return "3090 #3";
    if (idx === 2) return "3090 #2";
    if (idx === 3) return "3090 #3";
  }
  if (g.includes("3090")) return "3090";
  if (g.includes("cpu")) return "CPU";
  return g || "?";
}

function deriveGpuPreferred(label: string): GPUPreferred {
  if (label.startsWith("P6000")) return "P6000";
  if (label.startsWith("3090")) return "3090";
  if (label === "CPU") return "cpu";
  return "multi";
}

function totalVramForLabel(label: string): number {
  if (label.startsWith("P6000") || label.startsWith("3090")) return 24576;
  if (label === "multi-GPU" || label.includes("3090 + CPU")) return 49152;
  return 0;
}

function deriveState(id: string, runningSet: Set<string>): RecipeState {
  if (runningSet.has(id)) return "running";
  if (MODE_C_PERSISTENT.has(id)) return "persist";
  return "on-demand";
}

function deriveFlags(id: string, description: string | undefined, quirks: string[] | undefined) {
  const blob = `${id} ${description ?? ""} ${(quirks ?? []).join(" ")}`.toLowerCase();
  return {
    uncensored:
      blob.includes("uncensor") ||
      blob.includes("heretic") ||
      blob.includes("hauhau") ||
      blob.includes("abliterate"),
    thinking:
      blob.includes("thinking") || blob.includes("reasoning") || blob.includes("r1"),
    vision: blob.includes("vision") || blob.includes("mmproj") || blob.includes("multimodal"),
  };
}

function estimateDiskGb(quant: string | undefined, vram_mb: number): number {
  // Rough: disk ≈ VRAM for llama.cpp loads; quant-specific corrections for giants.
  if (!quant) return 0;
  return Math.round((vram_mb / 1024) * 0.95 * 10) / 10;
}

function transformModel(raw: RegistryModel, runningSet: Set<string>): Recipe {
  const gpu_label = deriveGpuLabel(raw.gpu, raw.id);
  const { uncensored, thinking, vision } = deriveFlags(raw.id, raw.description, raw.quirks);
  const vram_mb = raw.vram_mb ?? 0;
  return {
    id: raw.id,
    name: raw.id,
    subtitle: raw.name ?? raw.description?.slice(0, 80) ?? raw.id,
    backend: deriveBackend(raw.id),
    gpu_label,
    gpu_preferred: deriveGpuPreferred(gpu_label),
    speed_tok_s: toSpeedNumber(raw.speed),
    prompt_tok_s: undefined,
    kv_quant: "f16", // model-registry doesn't expose — default; inspector view can read config directly
    vram_mb,
    total_vram_mb: totalVramForLabel(gpu_label),
    disk_gb: estimateDiskGb(raw.quantization, vram_mb),
    quant_name: raw.quantization ?? "?",
    state: deriveState(raw.id, runningSet),
    uncensored,
    thinking,
    vision,
    benchmarks: {},
    favorite: false,
  };
}

async function fetchJson<T>(url: string, timeoutMs = 3000): Promise<T | null> {
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

async function loadRecipes(): Promise<Recipe[]> {
  const [registry, runningResp] = await Promise.all([
    fetchJson<{ models: RegistryModel[] }>(`${AGENT_API}/system/model-registry?all=true`),
    fetchJson<{ running: { model: string }[] }>(`${LLAMA_SWAP}/running`),
  ]);
  if (!registry?.models) return [];
  const runningSet = new Set((runningResp?.running ?? []).map((r) => r.model));
  return registry.models.map((m) => transformModel(m, runningSet));
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const id = url.searchParams.get("id");
  const recipes = await loadRecipes();

  if (id) {
    const match = recipes.find((r) => r.id === id) ?? recipes[0] ?? null;
    // Benchmarks pass-through is a stub until we expose /bench/results —
    // empty array renders the "no bench data" panel correctly.
    const benchmarks: BenchmarkResult[] = [];
    return NextResponse.json({
      recipe: match,
      benchmarks,
      fetched_at: new Date().toISOString(),
    });
  }

  return NextResponse.json({
    recipes,
    count: recipes.length,
    fetched_at: new Date().toISOString(),
  });
}
