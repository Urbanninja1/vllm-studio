"use client";

import { useState } from "react";

import { Dashboard } from "@/components/flight-ops/Dashboard";
import { LogsViewer } from "@/components/flight-ops/LogsViewer";
import { ModelsBrowser } from "@/components/flight-ops/ModelsBrowser";
import { RecipeForm } from "@/components/flight-ops/RecipeForm";

import "@/components/flight-ops/tokens.css";

type Tab = "dashboard" | "models" | "logs" | "recipes";

const TABS: { id: Tab; label: string; hotkey: string; liveData: boolean }[] = [
  { id: "dashboard", label: "Dashboard", hotkey: "1", liveData: true },
  { id: "models", label: "Models", hotkey: "2", liveData: false },
  { id: "logs", label: "Logs", hotkey: "3", liveData: false },
  { id: "recipes", label: "Recipes", hotkey: "4", liveData: false },
];

/* ------------------------------------------------------------------
 * Sample data for Models / Logs / Recipes tabs.
 *
 * Dashboard hits the Stargate Agent API (live); the other three tabs
 * are staged with static recipe + log-source + benchmark shapes so the
 * UI renders without requiring the full vLLM Studio controller. Live
 * wiring for these three is a follow-up plan — the components are
 * already prop-driven, so wiring is additive (no component rewrite).
 * ------------------------------------------------------------------ */

const SAMPLE_RECIPES = [
  {
    id: "qwen3.6-35b-a3b-hauhau-p6000",
    name: "qwen3.6-35b-a3b-hauhau-p6000",
    model_hf: "turboderp/Qwen3.6-35B-A3B-hauhau-Q4_K_M-GGUF",
    quant: "Q4_K_M",
    backend: "llama.cpp-pascal",
    vram_mb: 22528,
    ctx_native: 262144,
    ctx_recipe: 262144,
    kind: "persist" as const,
    gpu_label: "P6000 #0",
    extra_args: {
      n_cpu_moe: 0,
      n_gpu_layers: 999,
      batch_size: 4096,
      ubatch_size: 1024,
      cache_type_k: "turbo4" as const,
      cache_type_v: "turbo4" as const,
    },
  },
];

const SAMPLE_BENCHMARKS = [
  { name: "perplexity", score: 4.82, samples: 2891, good: true },
  { name: "mmlu_pro", score: 0.712, samples: 1000, good: true },
  { name: "gpqa_diamond", score: 0.438, samples: 198, good: true },
];

const SAMPLE_LOG_SOURCES = [
  { id: "llama-swap", label: "llama-swap", color: "cyan" as const, active: true },
  { id: "agent-api", label: "agent-api", color: "indigo" as const, active: true },
  { id: "mcp-server", label: "mcp-server", color: "fg-2" as const, active: true },
  { id: "voice-gateway", label: "voice-gateway", color: "fg-3" as const, active: false },
];

export default function FlightOpsPreview() {
  const [tab, setTab] = useState<Tab>("dashboard");

  return (
    <main className="min-h-screen bg-[var(--color-bg-0)] text-[var(--color-fg-0)]">
      <nav className="sticky top-0 z-10 flex items-center gap-0 border-b border-[var(--color-ink-4)] bg-[var(--color-bg-0)]/95 px-8 py-3 backdrop-blur">
        <span className="mr-6 font-mono text-[11px] tracking-[0.1em] text-[var(--color-fg-3)]">
          STARGATE · FLIGHT OPS
        </span>
        {TABS.map((t) => {
          const active = t.id === tab;
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => setTab(t.id)}
              className={[
                "mr-6 flex items-baseline gap-2 py-1 font-display text-[13px] tracking-[-0.005em] transition-colors",
                active
                  ? "text-[var(--color-accent)]"
                  : "text-[var(--color-fg-2)] hover:text-[var(--color-fg-0)]",
              ].join(" ")}
              aria-current={active ? "page" : undefined}
            >
              {t.label}
              <span className="font-mono text-[10px] tracking-[0.1em] text-[var(--color-fg-3)]">
                {t.hotkey}
              </span>
              {!t.liveData && active && (
                <span className="font-mono text-[10px] tracking-[0.1em] text-[var(--color-fg-3)]">
                  · SAMPLE
                </span>
              )}
            </button>
          );
        })}
      </nav>

      <section className="p-8">
        {tab === "dashboard" && <Dashboard />}
        {tab === "models" && <ModelsBrowser recipes={SAMPLE_RECIPES as never} />}
        {tab === "logs" && <LogsViewer sources={SAMPLE_LOG_SOURCES as never} />}
        {tab === "recipes" && (
          <RecipeForm
            recipe={SAMPLE_RECIPES[0] as never}
            benchmarks={SAMPLE_BENCHMARKS as never}
            vramCurrentMb={22528}
            vramTotalMb={24576}
          />
        )}
      </section>
    </main>
  );
}
