// STARGATE:fork-owned — never touched by upstream sync.
// Owns the full delegation surface for `backend: "llama-swap"` recipes.
// Upstream-hot files (backends.ts, process-manager.ts, inference-client.ts,
// lifecycle-coordinator.ts) carry only 1-3 LOC dispatches — shrinks rebase
// blast radius 5× versus inlining the logic.
//
// llama-swap has NO per-model admin endpoints (verified 2026-04-19 against live
// :8080 — POST /upstream/<profile>/load returns 404). Load is triggered via a
// minimal `/v1/chat/completions` warmup request; unload is either a blanket
// `POST /models/unload` (auto-repreloads persistent members) or a TTL-based
// eviction.
import { parseStargateExtras } from "./stargate-extras-parser";
import type { Recipe } from "../types";

// ── Error discriminated union ───────────────────────────────────────────────

export type DelegateErrorKind =
  | "missing-profile"
  | "llama-swap-unreachable"
  | "profile-not-found"
  | "warmup-timeout"
  | "gpu-oom";

export class DelegateError extends Error {
  constructor(
    public readonly kind: DelegateErrorKind,
    message: string,
    public readonly detail?: Record<string, unknown>
  ) {
    super(message);
    this.name = "DelegateError";
  }
}

// ── Running-set probe ───────────────────────────────────────────────────────

interface LlamaSwapRunningEntry {
  model: string;
  state: string;
  ttl?: number;
  proxy?: string;
  name?: string;
}

async function fetchRunning(
  url: string,
  signal?: AbortSignal
): Promise<LlamaSwapRunningEntry[]> {
  const init: RequestInit = signal ? { signal } : {};
  const res = await fetch(`${url}/running`, init);
  if (!res.ok) {
    throw new DelegateError(
      "llama-swap-unreachable",
      `GET ${url}/running → ${res.status}`
    );
  }
  const body = (await res.json()) as { running?: LlamaSwapRunningEntry[] };
  return body.running ?? [];
}

// ── Warmup load ─────────────────────────────────────────────────────────────

const POLL_DELAYS_MS = [250, 500, 1000, 2000, 2000, 2000, 2000, 2000, 2000, 2000] as const;
const WARMUP_CAP_MS = 60_000;

/**
 * Trigger an on-demand load of a llama-swap profile.
 *
 * Fires a tiny `/v1/chat/completions` request (max_tokens=1) — llama-swap's
 * swap policy evicts conflicting models from the target's group automatically.
 * Polls `/running` with exponential backoff until the profile appears "ready"
 * or the 60 s cap elapses.
 */
export async function delegateLoad(recipe: Recipe): Promise<void> {
  const extras = parseStargateExtras(recipe.extra_args);
  if (!extras?.llama_swap_profile) {
    throw new DelegateError(
      "missing-profile",
      "recipe.extra_args.stargate.llama_swap_profile is required for backend=llama-swap"
    );
  }

  // 1. Warmup request — llama-swap loads the model on-demand. 5 s connect
  //    timeout is fine because the load itself happens behind the scenes;
  //    the warmup HTTP call returns once the chat completion responds.
  const warmupCtl = new AbortController();
  const warmupTimeout = setTimeout(
    () => warmupCtl.abort(),
    Math.min(WARMUP_CAP_MS, 120_000)
  );
  try {
    const res = await fetch(`${extras.llama_swap_url}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: extras.llama_swap_profile,
        messages: [{ role: "user", content: "hi" }],
        max_tokens: 1,
        stream: false,
      }),
      signal: warmupCtl.signal,
    });
    if (res.status === 404) {
      throw new DelegateError("profile-not-found", `llama-swap has no profile ${extras.llama_swap_profile}`, {
        profile: extras.llama_swap_profile,
      });
    }
    // Drain body so keep-alive connection is reusable.
    await res.arrayBuffer();
  } catch (err) {
    if (err instanceof DelegateError) throw err;
    if ((err as { name?: string })?.name === "AbortError") {
      throw new DelegateError("warmup-timeout", "warmup request aborted", {
        profile: extras.llama_swap_profile,
      });
    }
    throw new DelegateError(
      "llama-swap-unreachable",
      `llama-swap at ${extras.llama_swap_url} unreachable: ${String(err)}`
    );
  } finally {
    clearTimeout(warmupTimeout);
  }

  // 2. Poll /running until the profile is ready or we hit the 60 s cap.
  const start = Date.now();
  for (const ms of POLL_DELAYS_MS) {
    if (Date.now() - start > WARMUP_CAP_MS) break;
    const running = await fetchRunning(extras.llama_swap_filter_url);
    if (
      running.some((r) => r.model === extras.llama_swap_profile && r.state === "ready")
    ) {
      return;
    }
    await new Promise((r) => setTimeout(r, ms));
  }
  throw new DelegateError(
    "warmup-timeout",
    `profile ${extras.llama_swap_profile} not ready after ${WARMUP_CAP_MS} ms`,
    { profile: extras.llama_swap_profile, elapsed_ms: Date.now() - start }
  );
}

/**
 * Evict a llama-swap profile.
 *
 * llama-swap only offers blanket `POST /models/unload`. Persistent preloads
 * (from `hooks.on_startup.preload` in config.yaml) auto-restart; on-demand
 * models stay evicted. For per-model eviction an operator can also set the
 * target's TTL to a short value and wait.
 */
export async function delegateUnload(recipe: Recipe): Promise<void> {
  const extras = parseStargateExtras(recipe.extra_args);
  if (!extras?.llama_swap_url) {
    throw new DelegateError(
      "missing-profile",
      "recipe.extra_args.stargate.llama_swap_url is required"
    );
  }
  // Unload a specific profile first (v197+ supports /api/models/unload/<model>).
  // If that misses, fall back to blanket unload.
  const target = `${extras.llama_swap_url}/api/models/unload/${encodeURIComponent(extras.llama_swap_profile)}`;
  let res = await fetch(target, { method: "POST" });
  if (res.status === 404) {
    res = await fetch(`${extras.llama_swap_url}/api/models/unload`, { method: "POST" });
  }
  if (!res.ok) {
    throw new DelegateError(
      "llama-swap-unreachable",
      `POST ${extras.llama_swap_url}/api/models/unload[/profile] → ${res.status}`
    );
  }
}

/**
 * Probe llama-swap's filter proxy for the set of visible models.
 * Used by inference-client.ts to pick the right OpenAI-compat endpoint.
 */
export async function probeLlamaSwap(
  recipe: Recipe
): Promise<{ url: string; running: LlamaSwapRunningEntry[] }> {
  const extras = parseStargateExtras(recipe.extra_args);
  if (!extras?.llama_swap_filter_url) {
    throw new DelegateError(
      "missing-profile",
      "recipe.extra_args.stargate.llama_swap_filter_url is required"
    );
  }
  const running = await fetchRunning(extras.llama_swap_filter_url);
  return { url: extras.llama_swap_filter_url, running };
}

/**
 * Dispatch helper for backends.ts — returns a dummy command since llama-swap
 * is externally managed. Upstream's process-manager treats an empty argv as
 * "nothing to spawn" when the delegated path is taken first.
 */
export function buildLlamaSwapCommand(_recipe: Recipe): string[] {
  return []; // spawn path bypassed — see process-manager.ts dispatch.
}
