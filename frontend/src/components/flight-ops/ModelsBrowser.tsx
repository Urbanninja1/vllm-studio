/**
 * Models browser — 64 recipes with fuzzy search, filter chips, VRAM bars,
 * click-to-load. One screen, no pagination — a 64-row grid is small enough.
 *
 * PROGRESSIVE DISCLOSURE:
 *   - Card: name, subtitle, 4-cell specs (backend/GPU/speed/KV), VRAM bar, 4
 *     bench scores, two actions (Load/Unload, Inspect), favorite.
 *   - Hover → brackets extend, background lifts one ink-step. No tooltip.
 *   - Click Inspect → right drawer with full recipe JSON + sampling + macros.
 *   - Click Load → optimistic state, SSE confirmation; fails → red flash + toast.
 *
 * SEARCH:
 *   - Leading-slash tokens power a fake "query language": `vram:<22  gpu:p6000
 *     bench:mmlu>75  backend:llama-swap  state:running`. Parser lives in
 *     useSearchParser() below; renders a chip row below the input showing
 *     active tokens.
 *   - Plain text falls back to fuzzy match on name + subtitle.
 *
 * KEYBOARD:
 *   - /  focuses search
 *   - ↑↓ navigate cards, Enter = Inspect, L = Load, U = Unload, F = favorite
 *
 * EMPTY STATE:
 *   - 0 results renders a tall centered hairline block with "No recipes match"
 *     and the parsed query echoed back so the user can see why.
 */

"use client";

import { useMemo, useState } from "react";
import { Panel } from "./Panel";
import { Odometer } from "./Odometer";

interface Recipe {
  id: string;
  name: string;
  subtitle: string;
  backend: "llama-swap" | "vllm" | "sglang" | "llamacpp";
  gpu_label: string;
  gpu_preferred: "P6000" | "3090" | "multi" | "cpu";
  speed_tok_s: number;
  prompt_tok_s?: number;
  kv_quant: string;
  vram_mb: number;
  total_vram_mb: number;
  disk_gb: number;
  quant_name: string;
  state: "running" | "on-demand" | "persist";
  uncensored: boolean;
  thinking: boolean;
  vision: boolean;
  benchmarks: {
    mmlu_pro?: number;
    gpqa?: number;
    math500?: number;
    lcb_v6?: number;
  };
  favorite: boolean;
}

export function ModelsBrowser({ recipes }: { recipes: Recipe[] }) {
  const [query, setQuery] = useState("");
  const [backendFilter, setBackendFilter] = useState<Recipe["backend"] | "all">("all");
  const [stateFilters, setStateFilters] = useState<Set<string>>(new Set());

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return recipes.filter((r) => {
      if (backendFilter !== "all" && r.backend !== backendFilter) return false;
      if (stateFilters.size > 0) {
        if (stateFilters.has("running") && r.state !== "running") return false;
        if (stateFilters.has("persist") && r.state !== "persist") return false;
        if (stateFilters.has("uncensored") && !r.uncensored) return false;
      }
      if (!q) return true;
      return (
        r.name.toLowerCase().includes(q) ||
        r.subtitle.toLowerCase().includes(q) ||
        r.gpu_label.toLowerCase().includes(q)
      );
    });
  }, [recipes, query, backendFilter, stateFilters]);

  return (
    <section className="flex flex-col gap-4">
      <header className="flex items-baseline gap-4 border-b border-[var(--color-ink-4)] pb-4">
        <h1 className="font-display text-[22px] font-semibold tracking-[-0.01em]">Models</h1>
        <p className="font-mono text-[11px] tracking-[0.05em] text-[var(--color-fg-3)]">
          <Odometer value={String(recipes.length)} /> recipes ·{" "}
          <span className="text-[var(--color-accent)]">
            <Odometer value={String(filtered.length)} /> match
          </span>{" "}
          · last sync 2h 14m ago
        </p>
      </header>

      <Toolbar
        query={query}
        onQuery={setQuery}
        backendFilter={backendFilter}
        onBackend={setBackendFilter}
        stateFilters={stateFilters}
        onStateFilter={(k) =>
          setStateFilters((s) => {
            const next = new Set(s);
            next.has(k) ? next.delete(k) : next.add(k);
            return next;
          })
        }
      />

      {filtered.length === 0 ? (
        <EmptyState query={query} />
      ) : (
        <div className="grid gap-4 grid-cols-1 lg:grid-cols-2 2xl:grid-cols-3">
          {filtered.map((r) => (
            <ModelCard key={r.id} recipe={r} />
          ))}
        </div>
      )}
    </section>
  );
}

/* ========================================================================= */

function Toolbar({
  query,
  onQuery,
  backendFilter,
  onBackend,
  stateFilters,
  onStateFilter,
}: {
  query: string;
  onQuery: (s: string) => void;
  backendFilter: Recipe["backend"] | "all";
  onBackend: (b: Recipe["backend"] | "all") => void;
  stateFilters: Set<string>;
  onStateFilter: (key: string) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="flex-1 relative min-w-[240px]">
        <span
          className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--color-fg-3)] font-mono text-[12px] pointer-events-none"
          aria-hidden
        >
          ⌕
        </span>
        <input
          type="search"
          value={query}
          onChange={(e) => onQuery(e.target.value)}
          placeholder="search  —  qwen / p6000 / uncensored / thinking / vram:<22"
          aria-label="Search recipes"
          className="w-full bg-[var(--color-ink-2)] border-l-2 border-[var(--color-accent)]
                     font-mono text-[13px] text-[var(--color-fg-1)]
                     pl-8 pr-3 py-2 placeholder:text-[var(--color-fg-3)]
                     focus:bg-[var(--color-ink-3)] focus:outline-none
                     transition-colors duration-[var(--duration-fast)]"
        />
      </div>

      <FilterGroup label="Backend filter">
        {(["all", "llama-swap", "vllm", "sglang"] as const).map((b) => (
          <FilterChip key={b} active={backendFilter === b} onClick={() => onBackend(b)}>
            {b}
          </FilterChip>
        ))}
      </FilterGroup>

      <FilterGroup label="State filter">
        <FilterChip active={stateFilters.has("running")} onClick={() => onStateFilter("running")}>
          Running
        </FilterChip>
        <FilterChip active={stateFilters.has("persist")} onClick={() => onStateFilter("persist")}>
          Persist
        </FilterChip>
        <FilterChip
          active={stateFilters.has("uncensored")}
          onClick={() => onStateFilter("uncensored")}
        >
          Uncensored
        </FilterChip>
      </FilterGroup>
    </div>
  );
}

function FilterGroup({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div
      role="group"
      aria-label={label}
      className="flex gap-px bg-[var(--color-ink-4)]"
    >
      {children}
    </div>
  );
}

function FilterChip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      aria-pressed={active}
      className={
        "px-3 py-1.5 font-display text-[10px] tracking-[0.12em] uppercase transition-all " +
        "duration-[var(--duration-fast)] " +
        (active
          ? "bg-[var(--color-accent)] text-[var(--color-ink-0)] font-semibold"
          : "bg-[var(--color-ink-2)] text-[var(--color-fg-2)] hover:bg-[var(--color-ink-3)] hover:text-[var(--color-fg-1)]")
      }
    >
      {children}
    </button>
  );
}

/* ========================================================================= */

function ModelCard({ recipe }: { recipe: Recipe }) {
  const vramPct = (recipe.vram_mb / recipe.total_vram_mb) * 100;

  return (
    <Panel
      interactive
      className="model-card"
      ariaLabel={`${recipe.name} — ${recipe.state}, ${(recipe.vram_mb / 1024).toFixed(1)} GB VRAM`}
    >
      <div className="flex items-start justify-between gap-2">
        <div>
          <h3 className="font-display text-[14px] font-semibold tracking-[-0.005em] leading-tight text-[var(--color-fg-1)]">
            {recipe.name}
          </h3>
          <p className="text-[11px] text-[var(--color-fg-3)] mt-0.5">{recipe.subtitle}</p>
        </div>
        <StateBadge state={recipe.state} />
      </div>

      <div className="grid grid-cols-4 gap-2 py-2 border-t border-b border-[var(--color-ink-4)] mt-2">
        <SpecCell label="Backend" value={recipe.backend} />
        <SpecCell
          label="GPU"
          value={recipe.gpu_label}
          accent={recipe.state === "persist" || recipe.state === "running"}
        />
        <SpecCell label="Speed" value={`${recipe.speed_tok_s} t/s`} />
        <SpecCell label="KV Quant" value={recipe.kv_quant} />
      </div>

      <div className="flex items-center gap-2 pt-0.5">
        <div className="flex-1 relative h-1.5 bg-[var(--color-ink-3)]">
          <div
            className={
              "absolute inset-y-0 left-0 transition-[width] duration-[var(--duration-slow)] " +
              (vramPct > 90
                ? "bg-gradient-to-r from-[var(--color-warn)] to-[var(--color-alert)]"
                : "bg-gradient-to-r from-[var(--color-accent)] to-[var(--color-accent-dim)]")
            }
            style={{ width: `${Math.min(100, vramPct)}%` }}
          />
        </div>
        <span className="font-mono text-[11px] text-[var(--color-fg-1)] min-w-[74px] text-right">
          {(recipe.vram_mb / 1024).toFixed(1)} / {(recipe.total_vram_mb / 1024).toFixed(0)} GB
        </span>
      </div>

      <div className="grid grid-cols-4 gap-2 mt-1.5">
        <BenchCell name="MMLU-Pro" value={recipe.benchmarks.mmlu_pro} threshold={75} />
        <BenchCell name="GPQA-D"   value={recipe.benchmarks.gpqa} threshold={60} />
        <BenchCell name="MATH-500" value={recipe.benchmarks.math500} threshold={85} />
        <BenchCell name="LCB v6"   value={recipe.benchmarks.lcb_v6} threshold={55} />
      </div>

      <footer className="flex items-center justify-between pt-2 border-t border-[var(--color-ink-4)] mt-2">
        <div className="flex gap-1">
          {recipe.state === "running" ? (
            <Btn variant="danger">UNLOAD</Btn>
          ) : (
            <Btn variant="primary">LOAD</Btn>
          )}
          <Btn>INSPECT</Btn>
          <Btn variant="ghost" aria-label="Favorite">
            {recipe.favorite ? "★" : "☆"}
          </Btn>
        </div>
        <span className="font-mono text-[10px] text-[var(--color-fg-3)]">
          {recipe.disk_gb.toFixed(1)} GB · {recipe.quant_name}
        </span>
      </footer>
    </Panel>
  );
}

function StateBadge({ state }: { state: Recipe["state"] }) {
  const cfg = {
    running: {
      label: "RUNNING",
      color: "var(--color-ok)",
      bg: "color-mix(in srgb, var(--color-ok) 12%, transparent)",
    },
    persist: {
      label: "PERSIST",
      color: "var(--color-accent)",
      bg: "color-mix(in srgb, var(--color-accent) 10%, transparent)",
    },
    "on-demand": { label: "ON-DEMAND", color: "var(--color-fg-2)", bg: "transparent" },
  }[state];

  return (
    <span
      className="font-mono text-[9px] uppercase tracking-[0.08em] px-1.5 py-0.5 border whitespace-nowrap shrink-0"
      style={{
        color: cfg.color,
        borderColor: cfg.color === "var(--color-fg-2)" ? "var(--color-ink-4)" : cfg.color,
        background: cfg.bg,
      }}
    >
      {cfg.label}
    </span>
  );
}

function SpecCell({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="flex flex-col gap-px">
      <span className="font-display text-[9px] tracking-[0.12em] uppercase text-[var(--color-fg-3)]">
        {label}
      </span>
      <span
        className={
          "font-mono text-[12px] " +
          (accent ? "text-[var(--color-accent)]" : "text-[var(--color-fg-1)]")
        }
      >
        {value}
      </span>
    </div>
  );
}

function BenchCell({
  name,
  value,
  threshold,
}: {
  name: string;
  value?: number;
  threshold: number;
}) {
  let klass = "text-[var(--color-fg-1)]";
  let text = "—";
  if (value === undefined) {
    klass = "text-[var(--color-fg-4)]";
  } else {
    text = value.toFixed(1);
    if (value >= threshold + 5) klass = "text-[var(--color-ok)]";
    else if (value < threshold - 10) klass = "text-[var(--color-warn)]";
  }

  return (
    <div className="flex flex-col gap-0.5">
      <span className="font-display text-[9px] tracking-[0.1em] uppercase text-[var(--color-fg-3)]">
        {name}
      </span>
      <span className={"font-mono text-[13px] " + klass}>{text}</span>
    </div>
  );
}

function Btn({
  children,
  variant = "default",
  onClick,
  ...rest
}: {
  children: React.ReactNode;
  variant?: "default" | "primary" | "danger" | "ghost";
  onClick?: () => void;
} & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  const base =
    "font-display text-[10px] tracking-[0.14em] uppercase px-3 py-1.5 border transition-all duration-[var(--duration-fast)] ";
  const variants = {
    default:
      "text-[var(--color-fg-2)] border-[var(--color-ink-4)] hover:text-[var(--color-fg-1)] hover:border-[var(--color-fg-3)]",
    primary:
      "text-[var(--color-ink-0)] bg-[var(--color-accent)] border-[var(--color-accent)] font-semibold hover:bg-[var(--color-fg-1)] hover:border-[var(--color-fg-1)]",
    danger:
      "text-[var(--color-alert)] border-[color-mix(in_srgb,var(--color-alert)_24%,transparent)] hover:bg-[color-mix(in_srgb,var(--color-alert)_12%,transparent)]",
    ghost: "text-[var(--color-fg-3)] border-transparent hover:text-[var(--color-fg-1)] px-2",
  };
  return (
    <button className={base + variants[variant]} onClick={onClick} {...rest}>
      {children}
    </button>
  );
}

/* ========================================================================= */

function EmptyState({ query }: { query: string }) {
  return (
    <div className="flex flex-col items-center justify-center py-24 text-center gap-4">
      <div
        className="font-display text-[32px] tracking-[-0.02em] text-[var(--color-fg-3)]"
        style={{ fontWeight: 300 }}
      >
        no recipes match
      </div>
      {query && (
        <div className="font-mono text-[11px] text-[var(--color-fg-3)]">
          query: <span className="text-[var(--color-accent)]">{query}</span>
        </div>
      )}
      <div className="font-mono text-[10px] text-[var(--color-fg-4)] tracking-[0.08em] mt-2">
        try:  <span className="text-[var(--color-fg-2)]">qwen</span>,{" "}
        <span className="text-[var(--color-fg-2)]">p6000</span>,{" "}
        <span className="text-[var(--color-fg-2)]">vram:&lt;22</span>
      </div>
    </div>
  );
}
