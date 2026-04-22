"use client";

import { useState } from "react";

import { Dashboard } from "@/components/flight-ops/Dashboard";
import { LogsViewer } from "@/components/flight-ops/LogsViewer";
import { ModelsBrowser } from "@/components/flight-ops/ModelsBrowser";
import { RecipeForm } from "@/components/flight-ops/RecipeForm";

import "@/components/flight-ops/tokens.css";

type Tab = "dashboard" | "models" | "logs" | "recipes";

const TABS: { id: Tab; label: string; hotkey: string }[] = [
  { id: "dashboard", label: "Dashboard", hotkey: "1" },
  { id: "models", label: "Models", hotkey: "2" },
  { id: "logs", label: "Logs", hotkey: "3" },
  { id: "recipes", label: "Recipes", hotkey: "4" },
];

/* All four tabs self-fetch from Stargate Agent API via route handlers
 * under /api/stargate/*. No sample data — Dashboard polls /dashboard,
 * Models + Recipes poll /recipes, Logs streams /logs. Components fall
 * back to empty states gracefully if a backend is unreachable. */

export default function FlightOpsPreview() {
  const [tab, setTab] = useState<Tab>("dashboard");
  const selectTab = (next: Tab) => setTab(next);

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
              onClick={() => selectTab(t.id)}
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
            </button>
          );
        })}
      </nav>

      <section className="p-8">
        {tab === "dashboard" && <Dashboard />}
        {tab === "models" && <ModelsBrowser />}
        {tab === "logs" && <LogsViewer />}
        {tab === "recipes" && <RecipeForm />}
      </section>
    </main>
  );
}
