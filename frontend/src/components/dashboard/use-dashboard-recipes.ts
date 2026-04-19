// CRITICAL
import { useCallback, useEffect, useState } from "react";
import api from "@/lib/api";
import type { ProcessInfo, RecipeWithStatus } from "@/lib/types";

export function useDashboardRecipes(currentProcess: ProcessInfo | null) {
  const [recipes, setRecipes] = useState<RecipeWithStatus[]>([]);
  const [currentRecipe, setCurrentRecipe] = useState<RecipeWithStatus | null>(null);
  const [logs, setLogs] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);

  const selectTargetLogSession = useCallback(
    (
      sessions: Array<{
        id: string;
        recipe_id?: string;
        status: string;
        backend?: string;
        model_path?: string;
        model?: string;
      }>,
      runningRecipe: RecipeWithStatus | null,
    ) => {
      if (sessions.length === 0) return null;

      if (currentProcess) {
        const byProcess = sessions.find((session) => {
          if (session.status !== "running") return false;
          if (session.model_path && currentProcess.model_path) {
            return session.model_path === currentProcess.model_path;
          }
          if (session.model && currentProcess.served_model_name) {
            return session.model === currentProcess.served_model_name;
          }
          return session.backend === currentProcess.backend;
        });
        if (byProcess) return byProcess;

        const servedModel = currentProcess.served_model_name?.toLowerCase();
        if (servedModel) {
          const byName = sessions.find((session) =>
            (session.id ?? "").toLowerCase().includes(servedModel),
          );
          if (byName) return byName;
        }
      }

      if (runningRecipe) {
        const byRecipe = sessions.find(
          (session) => session.status === "running" || session.recipe_id === runningRecipe.id,
        );
        if (byRecipe) return byRecipe;
      }

      return sessions[0];
    },
    [currentProcess],
  );

  const refreshLogs = useCallback(
    async (runningRecipe: RecipeWithStatus | null, limit = 220) => {
      try {
        const sessions = await api.getLogSessions();
        const list = sessions.sessions || [];
        if (list.length === 0) {
          setLogs([]);
          return;
        }
        const targetSession = selectTargetLogSession(list, runningRecipe);
        if (!targetSession) {
          setLogs([]);
          return;
        }
        const logData = await api.getLogs(targetSession.id, limit).catch(() => ({ logs: [] }));
        setLogs(logData.logs || []);
      } catch {
        setLogs([]);
      }
    },
    [selectTargetLogSession],
  );

  const reload = useCallback(async () => {
    try {
      const [data, status] = await Promise.all([
        api.getRecipes(),
        // STARGATE: /status augments each recipe's status with llama-swap
        // readiness so the Dashboard shows ALL 7 preloads as running, not
        // just the synthesized currentProcess one.
        api.getStatus().catch(() => null),
      ]);
      const list = data.recipes || [];

      // STARGATE: merge llama_swap_running into recipe.status.
      const llamaSwapRunning = new Set<string>(
        (status as { llama_swap_running?: string[] } | null)?.llama_swap_running ?? [],
      );
      const merged = list.map((r: RecipeWithStatus) => {
        // Match by recipe.id (our sync sets id === llama_swap_profile) OR by
        // served_model_name / extra_args.stargate.llama_swap_profile.
        const extras = (r.extra_args ?? {}) as Record<string, unknown>;
        const stargate = (extras["stargate"] as Record<string, unknown> | undefined) ?? {};
        const profile =
          (typeof stargate["llama_swap_profile"] === "string" ? stargate["llama_swap_profile"] : null) ??
          r.served_model_name ??
          r.id;
        if (typeof profile === "string" && llamaSwapRunning.has(profile)) {
          return { ...r, status: "running" as const };
        }
        return r;
      });
      setRecipes(merged);

      // Current recipe: prefer the one matching currentProcess.served_model_name.
      const active = currentProcess?.served_model_name ?? null;
      const running =
        (active ? merged.find((r: RecipeWithStatus) => r.id === active) : null) ??
        merged.find((r: RecipeWithStatus) => r.status === "running") ??
        null;
      setCurrentRecipe(running);
      await refreshLogs(running);
    } catch (e) {
      console.error("Failed to load recipes:", e);
    } finally {
      setLoading(false);
    }
  }, [currentProcess, refreshLogs]);

  useEffect(() => {
    reload();
  }, [reload]);

  useEffect(() => {
    const handler = () => {
      void reload();
    };
    window.addEventListener("vllm:recipe-event", handler as EventListener);
    return () => {
      window.removeEventListener("vllm:recipe-event", handler as EventListener);
    };
  }, [reload]);

  useEffect(() => {
    if (!currentProcess) return;
    let cancelled = false;
    const poll = async () => {
      if (cancelled) return;
      await refreshLogs(currentRecipe);
    };
    void poll();
    const interval = window.setInterval(() => {
      void poll();
    }, 4000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [currentProcess, currentRecipe, refreshLogs]);

  return { recipes, currentRecipe, logs, loading, reload };
}
