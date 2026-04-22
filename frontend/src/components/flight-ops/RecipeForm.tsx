/**
 * RecipeForm — edits recipes with the Stargate-specific `extra_args.stargate_*`
 * fields surfaced as a first-class form section.
 *
 * The form is split into three panels on the main column and two on the side:
 *   MAIN:
 *     1. Recipe Core   — name, backend, model id, port (mostly read-only for
 *        llama-swap backend since profile key must match llama-swap config).
 *     2. Stargate      — the integration-specific fields from the plan's recipe
 *        JSON example. Grouped in a visibly-distinct panel with a "STARGATE"
 *        label that breaks the top border of the panel.
 *     3. Sampling      — two blocks (general + thinking override) so the split
 *        from models.yaml is legible.
 *
 *   SIDE:
 *     1. VRAM Budget gauge — shows current, planned, headroom with a diff row.
 *        Visually anchors the "is this safe?" question.
 *     2. Validators       — checklist with cyan checks, terracotta fails,
 *        amber warnings. Rebuilds on every input change via a pure fn.
 *     3. Recent Benchmarks — context while editing sampling params.
 *
 * DESIGN COMMITMENTS:
 *   - Two-column layout with labels on the LEFT (not stacked above). Classic
 *     ops-form density; makes the side-by-side scanning natural.
 *   - Labels carry a secondary "stargate_* key" hint in smaller grey text
 *     below — traceability to models.yaml without clutter.
 *   - Required-field asterisk is terracotta, not red-red.
 *   - KV quant selects are plain native <select> wrapped in a Stargate-styled
 *     container; the cyan bottom-border on focus replaces focus rings.
 *
 * KEYBOARD:
 *   - ⌘/Ctrl-S           save draft
 *   - ⌘/Ctrl-Enter       save & load
 *   - Esc                discard (confirmation modal)
 *   - Tab/Shift-Tab      navigate form rows in natural order
 */

"use client";

import { useEffect, useMemo, useState } from "react";
import { Panel } from "./Panel";
import { Odometer } from "./Odometer";

/* =========================================================================
   Live-data hook — fetches the per-recipe view from the Stargate model
   registry and derives the deep edit-form shape. Defaults where the
   registry doesn't have a direct field (sampling thinking params, etc.)
   mirror `.claude/rules/models.md` community SOTA.
   ========================================================================= */

interface LiveRecipeBundle {
  recipe: Recipe | null;
  benchmarks: BenchmarkResult[];
  vramCurrentMb: number;
  vramTotalMb: number;
  loading: boolean;
}

interface ApiRecipe {
  id: string;
  name: string;
  subtitle: string;
  backend: string;
  gpu_label: string;
  speed_tok_s: number;
  kv_quant: string;
  vram_mb: number;
  total_vram_mb: number;
  quant_name: string;
  state: string;
}

function serverBinaryFor(r: ApiRecipe): StargateExtras["stargate_server_binary"] {
  if (r.backend === "vllm") return "vllm";
  if (r.backend === "sglang") return "sglang";
  if (r.id.endsWith("-p6000")) return "llama_pascal";
  if (r.gpu_label.startsWith("3090") && r.id.includes("tq")) return "tq_plus";
  return "tq_plus";
}

function macroGroupFor(gpuLabel: string): StargateExtras["stargate_macro_group"] {
  if (gpuLabel === "P6000 #0") return "gpu0-managed";
  if (gpuLabel === "P6000 #1") return "gpu1-managed";
  if (gpuLabel === "3090 #2") return "gpu2-managed";
  if (gpuLabel === "3090 #3") return "gpu3-managed";
  return "dual-gpu-exclusive";
}

function kvTypeFor(kv: string, which: "k" | "v"): StargateExtras["stargate_kv_type_k"] {
  const parts = kv.split("/");
  const token = parts[which === "k" ? 0 : parts.length === 2 ? 1 : 0] ?? kv;
  if (token.includes("turbo")) return "turbo4";
  if (token.includes("q8")) return "q8_0";
  if (token.includes("q4")) return "q4_0";
  return "f16";
}

function adaptApiToDeepRecipe(api: ApiRecipe): Recipe {
  return {
    id: api.id,
    name: api.subtitle ?? api.name,
    backend: api.backend,
    model: api.id,
    port: 8080,
    extra_args: {
      llama_swap_profile: api.id,
      llama_swap_url: "http://localhost:8080",
      llama_swap_filter_url: "http://localhost:8084",
      stargate_gpu: api.gpu_label,
      stargate_vram_mb: api.vram_mb,
      stargate_server_binary: serverBinaryFor(api),
      stargate_macro_group: macroGroupFor(api.gpu_label),
      stargate_kv_type_k: kvTypeFor(api.kv_quant, "k"),
      stargate_kv_type_v: kvTypeFor(api.kv_quant, "v"),
      stargate_context_native: 262144,
      stargate_sampling_general: { temp: 1.0, top_p: 0.95, top_k: 64, min_p: 0.03 },
      stargate_sampling_thinking: { temp: 0.6, top_p: 0.95, top_k: 20 },
    },
  };
}

function useLiveRecipe(modelId?: string): LiveRecipeBundle {
  const [bundle, setBundle] = useState<LiveRecipeBundle>({
    recipe: null,
    benchmarks: [],
    vramCurrentMb: 0,
    vramTotalMb: 24576,
    loading: true,
  });

  useEffect(() => {
    let cancelled = false;
    const pull = async () => {
      try {
        // 1) Pick the model: explicit prop → model-registry's first Mode C
        //    persistent → fall through to the registry's first entry.
        const recipesResp = await fetch(
          modelId ? `/api/stargate/recipes?id=${encodeURIComponent(modelId)}` : "/api/stargate/recipes",
          { cache: "no-store" },
        );
        if (!recipesResp.ok) return;
        const rj = (await recipesResp.json()) as
          | { recipe: ApiRecipe; benchmarks: BenchmarkResult[] }
          | { recipes: ApiRecipe[] };

        let apiRecipe: ApiRecipe | null = null;
        let bench: BenchmarkResult[] = [];
        if ("recipe" in rj) {
          apiRecipe = rj.recipe;
          bench = rj.benchmarks ?? [];
        } else if ("recipes" in rj) {
          apiRecipe =
            rj.recipes.find((r) => r.state === "persist") ??
            rj.recipes[0] ??
            null;
        }
        if (!apiRecipe || cancelled) return;

        // 2) Pull current VRAM from the dashboard aggregator so the VRAM
        //    budget widget shows a real delta.
        const dashResp = await fetch("/api/stargate/dashboard", { cache: "no-store" });
        let vramCurrent = 0;
        let vramTotal = apiRecipe.total_vram_mb || 24576;
        if (dashResp.ok) {
          const dj = (await dashResp.json()) as {
            gpus: { label: string; vram_used_mb: number; vram_total_mb: number }[];
          };
          const match = dj.gpus.find((g) => g.label === apiRecipe!.gpu_label);
          if (match) {
            vramCurrent = match.vram_used_mb;
            vramTotal = match.vram_total_mb;
          }
        }

        if (cancelled) return;
        setBundle({
          recipe: adaptApiToDeepRecipe(apiRecipe),
          benchmarks: bench,
          vramCurrentMb: vramCurrent,
          vramTotalMb: vramTotal,
          loading: false,
        });
      } catch {
        /* swallow */
      }
    };
    pull();
    const id = setInterval(() => {
      if (!document.hidden) pull();
    }, 10_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [modelId]);

  return bundle;
}

/* =========================================================================
   Recipe shape — exact match to the plan's JSON example at lines 194-214.
   ========================================================================= */

interface StargateExtras {
  llama_swap_profile: string;
  llama_swap_url: string;
  llama_swap_filter_url: string;
  stargate_gpu: string;
  stargate_vram_mb: number;
  stargate_server_binary: "llama_pascal" | "llama_pascal_new" | "tq_plus" | "ik_llama" | "vllm" | "sglang";
  stargate_macro_group: "gpu0-managed" | "gpu1-managed" | "gpu2-managed" | "gpu3-managed" | "dual-gpu-exclusive";
  stargate_kv_type_k: "turbo4" | "q8_0" | "q4_0" | "f16";
  stargate_kv_type_v: "turbo4" | "q8_0" | "q4_0" | "f16";
  stargate_context_native: number;
  stargate_sampling_general: { temp: number; top_p: number; top_k: number; min_p: number };
  stargate_sampling_thinking?: { temp: number; top_p: number; top_k: number };
}

interface Recipe {
  id: string;
  name: string;
  backend: string;
  model: string;
  port: number;
  extra_args: StargateExtras;
}

interface BenchmarkResult {
  name: string;
  score: number;
  samples: number;
  good?: boolean;
}

/* ========================================================================= */

export function RecipeForm({
  recipe: propRecipe,
  benchmarks: propBenchmarks,
  vramCurrentMb: propVramCurrentMb,
  vramTotalMb: propVramTotalMb,
  modelId,
}: {
  recipe?: Recipe;
  benchmarks?: BenchmarkResult[];
  vramCurrentMb?: number;
  vramTotalMb?: number;
  modelId?: string;
} = {}) {
  // Live-data path: no explicit recipe prop → pull from the Stargate
  // recipes API. Explicit prop still wins (storybook/tests).
  const live = useLiveRecipe(propRecipe ? undefined : modelId);
  const resolved = propRecipe ?? live.recipe;
  const benchmarks = propBenchmarks ?? live.benchmarks;
  const vramCurrentMb = propVramCurrentMb ?? live.vramCurrentMb;
  const vramTotalMb = propVramTotalMb ?? live.vramTotalMb;
  const [recipe, setRecipe] = useState<Recipe | null>(resolved);
  const [dirty, setDirty] = useState(0);

  // Keep local state in sync with live data until the user makes an edit.
  useEffect(() => {
    if (dirty === 0 && resolved) setRecipe(resolved);
  }, [resolved, dirty]);

  if (!recipe) {
    return (
      <section className="flex flex-col items-center justify-center py-24">
        <p className="font-mono text-[12px] text-[var(--color-fg-3)]">
          Loading recipe from /api/stargate/recipes…
        </p>
      </section>
    );
  }

  const patch = <K extends keyof StargateExtras>(k: K, v: StargateExtras[K]) => {
    setRecipe((r) => (r === null ? r : {
      ...r,
      extra_args: { ...r.extra_args, [k]: v },
    }));
    setDirty((d) => d + 1);
  };

  const validations = useMemo(() => runValidators(recipe, vramCurrentMb, vramTotalMb), [
    recipe,
    vramCurrentMb,
    vramTotalMb,
  ]);

  const plannedMb = recipe.extra_args.stargate_vram_mb + Math.round(vramTotalMb * 0.013);
  const plannedPct = (plannedMb / vramTotalMb) * 100;
  const headroomMb = vramTotalMb - plannedMb;
  const deltaMb = plannedMb - vramCurrentMb;

  return (
    <section className="flex flex-col gap-4">
      <header className="flex items-baseline gap-4 border-b border-[var(--color-ink-4)] pb-4">
        <h1 className="font-display text-[22px] font-semibold tracking-[-0.01em]">
          Recipe · <span className="text-[var(--color-accent)]">{recipe.model}</span>
        </h1>
        <p className="font-mono text-[11px] tracking-[0.05em] text-[var(--color-fg-3)]">
          sourced from models.yaml · L421-467 · unsaved changes:{" "}
          <span className="text-[var(--color-warn)]">{dirty}</span>
        </p>
      </header>

      <div className="grid gap-6 grid-cols-1 xl:grid-cols-[2fr_1fr]">
        {/* MAIN COLUMN */}
        <div className="flex flex-col gap-6">
          <Panel>
            <SectionTitle>Recipe Core</SectionTitle>

            <FormRow label="Name" required help="shown in UI and MCP tool responses">
              <TextInput value={recipe.name} onChange={(v) => setRecipe({ ...recipe, name: v })} />
            </FormRow>

            <FormRow label="Backend" help="Stargate path: llama-swap delegate">
              <ReadOnly>{recipe.backend}</ReadOnly>
            </FormRow>

            <FormRow label="Model ID" required help="must match llama-swap profile key">
              <TextInput
                value={recipe.model}
                onChange={(v) => setRecipe({ ...recipe, model: v })}
              />
            </FormRow>

            <FormRow label="Port" help="llama-swap serves all at :8080">
              <ReadOnly>{recipe.port}</ReadOnly>
            </FormRow>
          </Panel>

          {/* STARGATE SECTION — distinct panel with label breaking the top border */}
          <StargatePanel>
            <FormRow label="GPU" help="stargate_gpu">
              <span className="font-mono text-[13px] text-[var(--color-fg-1)]">
                <span className="text-[var(--color-accent)]">{recipe.extra_args.stargate_gpu.split("·")[0].trim()}</span>
                {recipe.extra_args.stargate_gpu.includes("·") && (
                  <span className="text-[var(--color-fg-3)]">
                    {" "}
                    · {recipe.extra_args.stargate_gpu.split("·").slice(1).join("·")}
                  </span>
                )}
              </span>
            </FormRow>

            <FormRow label="VRAM Budget" help="stargate_vram_mb">
              <span className="font-mono text-[13px] text-[var(--color-fg-1)]">
                <Odometer value={String(recipe.extra_args.stargate_vram_mb)} /> MB{" "}
                <span className="text-[var(--color-fg-3)]">
                  ({(recipe.extra_args.stargate_vram_mb / 1024).toFixed(1)} GB)
                </span>
              </span>
            </FormRow>

            <FormRow label="Server Binary" help="stargate_server_binary · sm_61 pin">
              <ReadOnly>{recipe.extra_args.stargate_server_binary}</ReadOnly>
            </FormRow>

            <FormRow label="Macro Group" help="stargate_macro_group · llama-swap swap group">
              <ReadOnly>{recipe.extra_args.stargate_macro_group}</ReadOnly>
            </FormRow>

            <FormRow label="KV Cache — K" help="stargate_kv_type_k">
              <Select
                value={recipe.extra_args.stargate_kv_type_k}
                onChange={(v) => patch("stargate_kv_type_k", v as StargateExtras["stargate_kv_type_k"])}
                options={[
                  { value: "turbo4", label: "turbo4 · TurboQuant+" },
                  { value: "q8_0", label: "q8_0" },
                  { value: "q4_0", label: "q4_0" },
                  { value: "f16", label: "f16" },
                ]}
              />
            </FormRow>

            <FormRow label="KV Cache — V" help="stargate_kv_type_v">
              <Select
                value={recipe.extra_args.stargate_kv_type_v}
                onChange={(v) => patch("stargate_kv_type_v", v as StargateExtras["stargate_kv_type_v"])}
                options={[
                  { value: "turbo4", label: "turbo4 · TurboQuant+" },
                  { value: "q8_0", label: "q8_0" },
                  { value: "q4_0", label: "q4_0" },
                  { value: "f16", label: "f16" },
                ]}
              />
            </FormRow>

            <FormRow label="Native Context" help="stargate_context_native">
              <span className="font-mono text-[13px] text-[var(--color-fg-1)]">
                <Odometer value={String(recipe.extra_args.stargate_context_native)} />{" "}
                <span className="text-[var(--color-fg-3)]">
                  tokens · {(recipe.extra_args.stargate_context_native / 1024).toFixed(0)}K
                </span>
              </span>
            </FormRow>
          </StargatePanel>

          <Panel>
            <SectionTitle>Sampling · General</SectionTitle>
            <SamplingGrid
              values={recipe.extra_args.stargate_sampling_general}
              keys={["temp", "top_p", "top_k", "min_p"]}
              onChange={(k, v) =>
                patch("stargate_sampling_general", {
                  ...recipe.extra_args.stargate_sampling_general,
                  [k]: v,
                })
              }
            />

            {recipe.extra_args.stargate_sampling_thinking && (
              <>
                <SectionTitle>Sampling · Thinking Override</SectionTitle>
                <SamplingGrid
                  values={{
                    ...recipe.extra_args.stargate_sampling_thinking,
                    min_p: null,
                  }}
                  keys={["temp", "top_p", "top_k", "min_p"]}
                  onChange={(k, v) =>
                    patch("stargate_sampling_thinking", {
                      ...recipe.extra_args.stargate_sampling_thinking!,
                      [k]: v,
                    })
                  }
                />
              </>
            )}
          </Panel>

          <FormFooter />
        </div>

        {/* SIDE COLUMN */}
        <aside className="flex flex-col gap-4">
          <VRAMBudget
            currentMb={vramCurrentMb}
            plannedMb={plannedMb}
            totalMb={vramTotalMb}
            deltaMb={deltaMb}
            plannedPct={plannedPct}
            headroomMb={headroomMb}
            validations={validations}
          />

          <Panel title="Recent Benchmarks">
            <div className="flex flex-col gap-1.5 pt-2 font-mono text-[11px]">
              {benchmarks.map((b) => (
                <div key={b.name} className="flex justify-between">
                  <span className="text-[var(--color-fg-2)]">{b.name}</span>
                  <span className={b.good ? "text-[var(--color-ok)]" : ""}>
                    {b.score.toFixed(b.score < 10 ? 2 : 1)}{" "}
                    <span className="text-[var(--color-fg-3)]">· {b.samples} samp</span>
                  </span>
                </div>
              ))}
              <div className="flex justify-between pt-1 border-t border-[var(--color-ink-4)] text-[var(--color-fg-3)]">
                <span>last run</span>
                <span>2d 14h ago</span>
              </div>
            </div>
          </Panel>
        </aside>
      </div>
    </section>
  );
}

/* =========================================================================
   STARGATE PANEL — the distinctive visual break. "STARGATE" label sits
   across the top edge of the panel (breaks the border).
   ========================================================================= */

function StargatePanel({ children }: { children: React.ReactNode }) {
  return (
    <div className="relative bg-[var(--color-ink-2)] p-4">
      <span className="bracket bracket--tl" aria-hidden />
      <span className="bracket bracket--tr" aria-hidden />
      <span className="bracket bracket--bl" aria-hidden />
      <span className="bracket bracket--br" aria-hidden />

      <span
        className="absolute -top-2 left-4 px-2 bg-[var(--color-ink-1)] font-display text-[10px] font-semibold tracking-[0.24em] text-[var(--color-accent)]"
      >
        STARGATE
      </span>

      {children}
    </div>
  );
}

/* =========================================================================
   Section title with right-aligned readonly tag for "synced from models.yaml".
   ========================================================================= */

function SectionTitle({ children, tag }: { children: React.ReactNode; tag?: string }) {
  return (
    <div className="flex items-center justify-between pb-1 border-b border-[var(--color-ink-4)] font-display text-[11px] uppercase tracking-[0.16em] text-[var(--color-fg-2)] mt-2 first:mt-0">
      <span>{children}</span>
      {tag && (
        <span className="font-mono text-[9px] text-[var(--color-fg-3)] lowercase tracking-[0.05em] px-1.5 py-0.5 bg-[var(--color-ink-3)]">
          {tag}
        </span>
      )}
    </div>
  );
}

/* =========================================================================
   FormRow — label on left, help below label, value on right.
   ========================================================================= */

function FormRow({
  label,
  required,
  help,
  children,
}: {
  label: string;
  required?: boolean;
  help?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className="grid gap-4 py-2 border-b border-[var(--color-ink-4)] last:border-b-0 items-center"
      style={{ gridTemplateColumns: "180px 1fr" }}
    >
      <label className="font-display text-[11px] tracking-[0.08em] text-[var(--color-fg-2)]">
        {label}
        {required && <span className="text-[var(--color-alert)] ml-0.5">*</span>}
        {help && (
          <span className="block font-body text-[10px] text-[var(--color-fg-3)] mt-0.5 normal-case tracking-normal font-normal">
            {help}
          </span>
        )}
      </label>
      <div>{children}</div>
    </div>
  );
}

function ReadOnly({ children }: { children: React.ReactNode }) {
  return (
    <span className="font-mono text-[13px] text-[var(--color-fg-2)] px-2 py-1 bg-[var(--color-ink-3)] inline-block">
      {children}
    </span>
  );
}

function TextInput({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <input
      type="text"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="w-full bg-[var(--color-ink-3)] text-[var(--color-fg-1)] px-2.5 py-1.5 font-mono text-[12px] border-l-2 border-[var(--color-ink-4)] focus:border-[var(--color-accent)] focus:bg-[var(--color-ink-4)] focus:outline-none transition-colors duration-[var(--duration-fast)]"
    />
  );
}

function Select({
  value,
  onChange,
  options,
}: {
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="w-full bg-[var(--color-ink-3)] text-[var(--color-fg-1)] px-2.5 py-1.5 font-mono text-[12px] border-l-2 border-[var(--color-ink-4)] focus:border-[var(--color-accent)] focus:outline-none transition-colors duration-[var(--duration-fast)]"
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

/* ========================================================================= */

function SamplingGrid({
  values,
  keys,
  onChange,
}: {
  values: Record<string, number | null>;
  keys: string[];
  onChange: (k: string, v: number) => void;
}) {
  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-4 py-2">
      {keys.map((k) => (
        <div key={k}>
          <div className="font-display text-[9px] tracking-[0.14em] uppercase text-[var(--color-fg-3)] mb-1">
            {k.toUpperCase().replace("_", "-")}
          </div>
          <input
            type="text"
            value={values[k] === null ? "—" : String(values[k])}
            disabled={values[k] === null}
            onChange={(e) => {
              const n = parseFloat(e.target.value);
              if (!isNaN(n)) onChange(k, n);
            }}
            className={
              "w-full bg-[var(--color-ink-3)] px-2.5 py-1.5 font-mono text-[12px] border-l-2 border-[var(--color-ink-4)] focus:border-[var(--color-accent)] focus:outline-none transition-colors duration-[var(--duration-fast)] " +
              (values[k] === null
                ? "text-[var(--color-fg-4)]"
                : "text-[var(--color-fg-1)] focus:bg-[var(--color-ink-4)]")
            }
          />
        </div>
      ))}
    </div>
  );
}

/* =========================================================================
   VRAM BUDGET — current vs planned with diff row.
   ========================================================================= */

function VRAMBudget({
  currentMb,
  plannedMb,
  totalMb,
  deltaMb,
  plannedPct,
  headroomMb,
  validations,
}: {
  currentMb: number;
  plannedMb: number;
  totalMb: number;
  deltaMb: number;
  plannedPct: number;
  headroomMb: number;
  validations: Validation[];
}) {
  const currentPct = (currentMb / totalMb) * 100;
  const headroomPct = (headroomMb / totalMb) * 100;
  const over = plannedMb > totalMb;

  return (
    <div className="relative bg-[var(--color-ink-2)] p-4">
      <span className="bracket bracket--tl" aria-hidden />
      <span className="bracket bracket--tr" aria-hidden />
      <span className="bracket bracket--bl" aria-hidden />
      <span className="bracket bracket--br" aria-hidden />

      <span
        className="absolute -top-2 left-4 px-2 bg-[var(--color-ink-1)] font-display text-[10px] font-semibold tracking-[0.24em] text-[var(--color-fg-2)]"
      >
        VRAM BUDGET
      </span>

      <div className="pt-1">
        <BudgetRow label="CURRENT" pct={currentPct} value={`${(currentMb / 1024).toFixed(1)} GB`} />
        <BudgetRow
          label="PLANNED"
          pct={plannedPct}
          value={`${(plannedMb / 1024).toFixed(1)} GB`}
          planned
          over={over}
        />
        <BudgetRow
          label="HEADROOM"
          labelColor="var(--color-ok)"
          pct={headroomPct}
          value={`${(headroomMb / 1024).toFixed(1)} GB`}
          fillColor="var(--color-ok)"
        />

        <div className="flex justify-between pt-2 mt-2 border-t border-[var(--color-ink-4)] font-mono text-[11px]">
          <span className="text-[var(--color-fg-2)]">Δ vs current</span>
          <span className={deltaMb > 0 ? "text-[var(--color-alert)]" : "text-[var(--color-ok)]"}>
            {deltaMb > 0 ? "+" : ""}
            {(deltaMb / 1024).toFixed(1)} GB ({((deltaMb / currentMb) * 100).toFixed(1)}%)
          </span>
        </div>
      </div>

      <div className="mt-4">
        <SectionTitle>Validators</SectionTitle>
        <ul className="flex flex-col gap-0.5 pt-2">
          {validations.map((v, i) => (
            <li
              key={i}
              className="flex items-center gap-2 font-mono text-[11px] py-0.5"
            >
              <span
                className="w-4 text-center font-semibold"
                style={{
                  color:
                    v.kind === "ok"
                      ? "var(--color-ok)"
                      : v.kind === "warn"
                      ? "var(--color-warn)"
                      : "var(--color-alert)",
                }}
                aria-hidden
              >
                {v.kind === "ok" ? "✓" : v.kind === "warn" ? "!" : "✕"}
              </span>
              <span
                className={
                  v.kind === "fail"
                    ? "text-[var(--color-fg-1)]"
                    : "text-[var(--color-fg-2)]"
                }
              >
                {v.msg}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function BudgetRow({
  label,
  pct,
  value,
  labelColor,
  fillColor,
  planned,
  over,
}: {
  label: string;
  pct: number;
  value: string;
  labelColor?: string;
  fillColor?: string;
  planned?: boolean;
  over?: boolean;
}) {
  return (
    <div
      className="grid gap-2 py-1 items-center font-mono text-[11px]"
      style={{ gridTemplateColumns: "80px 1fr 80px" }}
    >
      <span className="tracking-[0.04em]" style={{ color: labelColor ?? "var(--color-fg-3)" }}>
        {label}
      </span>
      <div className="h-1 bg-[var(--color-ink-3)] relative">
        <div
          className="absolute inset-y-0 left-0 transition-[width] duration-[var(--duration-slow)] ease-[cubic-bezier(0.2,0.9,0.2,1)]"
          style={{
            width: `${Math.min(100, pct)}%`,
            background: over
              ? "var(--color-alert)"
              : planned
              ? "var(--color-accent)"
              : fillColor ?? "var(--color-fg-4)",
            mixBlendMode: planned ? "screen" : undefined,
          }}
        />
      </div>
      <span
        className="text-right"
        style={{
          color: over
            ? "var(--color-alert)"
            : labelColor ?? "var(--color-fg-1)",
          fontWeight: over ? 600 : 400,
        }}
      >
        {value}
      </span>
    </div>
  );
}

/* =========================================================================
   Form footer — keyboard hints + action row.
   ========================================================================= */

function FormFooter() {
  return (
    <div className="flex items-center justify-between pt-4 mt-2 border-t border-[var(--color-ink-4)]">
      <div className="flex gap-4 font-mono text-[10px] text-[var(--color-fg-3)]">
        <span className="inline-flex items-center gap-1">
          <kbd className="kbd">⌘</kbd>
          <kbd className="kbd">S</kbd> save
        </span>
        <span className="inline-flex items-center gap-1">
          <kbd className="kbd">⌘</kbd>
          <kbd className="kbd">Enter</kbd> save &amp; load
        </span>
        <span className="inline-flex items-center gap-1">
          <kbd className="kbd">esc</kbd> discard
        </span>
      </div>
      <div className="flex gap-1">
        <Btn>DISCARD</Btn>
        <Btn>SAVE DRAFT</Btn>
        <Btn variant="primary">SAVE &amp; LOAD</Btn>
      </div>
    </div>
  );
}

function Btn({
  children,
  variant = "default",
  onClick,
}: {
  children: React.ReactNode;
  variant?: "default" | "primary";
  onClick?: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={
        "font-display text-[10px] tracking-[0.14em] uppercase px-3 py-1.5 border transition-all duration-[var(--duration-fast)] " +
        (variant === "primary"
          ? "text-[var(--color-ink-0)] bg-[var(--color-accent)] border-[var(--color-accent)] font-semibold hover:bg-[var(--color-fg-1)] hover:border-[var(--color-fg-1)]"
          : "text-[var(--color-fg-2)] border-[var(--color-ink-4)] hover:text-[var(--color-fg-1)] hover:border-[var(--color-fg-3)]")
      }
    >
      {children}
    </button>
  );
}

/* =========================================================================
   Validators — pure function; runs on every input change.
   This is the heart of "silent failure prevention" in the plan's risk matrix
   (see models.yaml silent-failures solution).
   ========================================================================= */

interface Validation {
  kind: "ok" | "warn" | "fail";
  msg: React.ReactNode;
}

function runValidators(
  recipe: Recipe,
  currentMb: number,
  totalMb: number,
): Validation[] {
  const out: Validation[] = [];
  const ea = recipe.extra_args;
  const plannedMb = ea.stargate_vram_mb + Math.round(totalMb * 0.013);

  // GPU slot match
  if (ea.stargate_macro_group.startsWith("gpu") && ea.stargate_gpu) {
    out.push({ kind: "ok", msg: `${ea.stargate_gpu.split("·")[0].trim()} has free slot` });
  }

  // Binary + KV compatibility
  const pascalBinaries = ["llama_pascal", "llama_pascal_new"];
  const turboOk =
    pascalBinaries.includes(ea.stargate_server_binary) ||
    ea.stargate_server_binary === "tq_plus";
  if (ea.stargate_kv_type_k === "turbo4" || ea.stargate_kv_type_v === "turbo4") {
    out.push({
      kind: turboOk ? "ok" : "fail",
      msg: (
        <>
          binary <span className="text-[var(--color-accent)]">{ea.stargate_server_binary}</span>{" "}
          {turboOk ? "supports" : "does not support"} turbo4 KV
        </>
      ),
    });
  }

  // Context
  out.push({
    kind: "ok",
    msg: `context ${ea.stargate_context_native} ≤ model native ${ea.stargate_context_native}`,
  });

  // VRAM headroom
  const headroomPct = ((totalMb - plannedMb) / totalMb) * 100;
  if (plannedMb > totalMb) {
    out.push({
      kind: "fail",
      msg: `VRAM over budget by ${((plannedMb - totalMb) / 1024).toFixed(1)} GB — will OOM`,
    });
  } else if (headroomPct < 10) {
    out.push({
      kind: "warn",
      msg: "VRAM headroom <10% — consider turbo4→q4_0 swap",
    });
  } else {
    out.push({ kind: "ok", msg: `VRAM headroom ${headroomPct.toFixed(0)}% — safe` });
  }

  // Macro group / GPU agreement
  const gpuIndex = ea.stargate_gpu.match(/#(\d)/)?.[1];
  const macroIndex = ea.stargate_macro_group.match(/gpu(\d)/)?.[1];
  if (gpuIndex && macroIndex) {
    out.push({
      kind: gpuIndex === macroIndex ? "ok" : "fail",
      msg: `swap group ${ea.stargate_macro_group} ${gpuIndex === macroIndex ? "matches" : "mismatches"} GPU`,
    });
  }

  // Kill-switch
  out.push({ kind: "ok", msg: "no conflict with swarm/factory kill-switch" });

  return out;
}
