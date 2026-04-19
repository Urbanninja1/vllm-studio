// STARGATE:fork-owned — Phase 2 coverage for the llama-swap delegate surface.
// Mocks global fetch; does not hit any real server.
import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import {
  delegateLoad,
  delegateUnload,
  probeLlamaSwap,
  buildLlamaSwapCommand,
  DelegateError,
} from "./llama-swap-delegate";
import {
  isDelegatedBackend,
  DELEGATED_BACKENDS,
  type Backend,
} from "../../../../../shared/src/recipe";
import { parseStargateExtras } from "./stargate-extras-parser";
import type { Recipe } from "../types";
import { asRecipeId } from "../../../types/brand";

const buildRecipe = (overrides: Partial<Recipe> = {}): Recipe => ({
  id: asRecipeId("test-1"),
  name: "test",
  model_path: "/models/test",
  backend: "llama-swap",
  env_vars: null,
  tensor_parallel_size: 1,
  pipeline_parallel_size: 1,
  max_model_len: 4096,
  gpu_memory_utilization: 0.9,
  kv_cache_dtype: "auto",
  max_num_seqs: 256,
  trust_remote_code: true,
  tool_call_parser: null,
  reasoning_parser: null,
  enable_auto_tool_choice: false,
  quantization: null,
  dtype: null,
  host: "0.0.0.0",
  port: 8080,
  served_model_name: null,
  python_path: null,
  max_thinking_tokens: null,
  thinking_mode: "disabled",
  extra_args: {
    stargate: {
      llama_swap_profile: "qwopus-9b",
      llama_swap_url: "http://127.0.0.1:8080",
      llama_swap_filter_url: "http://127.0.0.1:8084",
    },
  },
  ...overrides,
});

describe("isDelegatedBackend predicate", () => {
  it("returns true for llama-swap", () => {
    expect(isDelegatedBackend("llama-swap" satisfies Backend)).toBe(true);
  });
  it("returns false for vllm + others", () => {
    for (const b of ["vllm", "llamacpp", "sglang", "tabbyapi"] as Backend[]) {
      expect(isDelegatedBackend(b)).toBe(false);
    }
  });
  it("DELEGATED_BACKENDS is the single source of truth", () => {
    expect(DELEGATED_BACKENDS).toEqual(["llama-swap"]);
  });
});

describe("parseStargateExtras", () => {
  it("returns null when no stargate namespace present", () => {
    expect(parseStargateExtras({})).toBeNull();
    expect(parseStargateExtras(null)).toBeNull();
    expect(parseStargateExtras({ stargate: null })).toBeNull();
  });
  it("parses a valid stargate block", () => {
    const out = parseStargateExtras({
      stargate: {
        llama_swap_profile: "qwopus-9b",
        llama_swap_url: "http://127.0.0.1:8080",
      },
    });
    expect(out?.llama_swap_profile).toBe("qwopus-9b");
    expect(out?.llama_swap_filter_url).toBe("http://127.0.0.1:8084"); // default
  });
  it("rejects missing required profile", () => {
    expect(() =>
      parseStargateExtras({ stargate: { llama_swap_url: "http://127.0.0.1:8080" } })
    ).toThrow(/invalid stargate extras/);
  });
  it("tolerates unknown keys (passthrough)", () => {
    const out = parseStargateExtras({
      stargate: {
        llama_swap_profile: "qwopus-9b",
        future_field: "whatever",
      },
    });
    expect(out?.llama_swap_profile).toBe("qwopus-9b");
    expect((out as Record<string, unknown>)["future_field"]).toBe("whatever");
  });
});

describe("buildLlamaSwapCommand", () => {
  it("returns an empty array (no spawn)", () => {
    expect(buildLlamaSwapCommand(buildRecipe())).toEqual([]);
  });
});

// ── fetch-mocked delegateLoad / delegateUnload / probeLlamaSwap ─────────────

type FetchResponse = Response | { status: number; body?: unknown; delay?: number };

const originalFetch = globalThis.fetch;

function mockFetch(handler: (url: string, init?: RequestInit) => FetchResponse) {
  globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const res = handler(url, init);
    if (res instanceof Response) return res;
    if (res.delay) await new Promise((r) => setTimeout(r, res.delay));
    return new Response(JSON.stringify(res.body ?? {}), {
      status: res.status,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("delegateLoad", () => {
  it("happy path: warmup + poll returns when profile ready", async () => {
    let pollCount = 0;
    mockFetch((url) => {
      if (url.includes("/v1/chat/completions")) return { status: 200, body: { ok: true } };
      if (url.includes("/running")) {
        pollCount++;
        return {
          status: 200,
          body: {
            running: pollCount >= 2
              ? [{ model: "qwopus-9b", state: "ready" }]
              : [],
          },
        };
      }
      throw new Error(`unexpected URL: ${url}`);
    });
    await expect(delegateLoad(buildRecipe())).resolves.toBeUndefined();
  });

  it("throws missing-profile when extras absent", async () => {
    const r = buildRecipe({ extra_args: {} });
    await expect(delegateLoad(r)).rejects.toThrow(DelegateError);
  });

  it("throws profile-not-found on 404", async () => {
    mockFetch(() => ({ status: 404, body: {} }));
    try {
      await delegateLoad(buildRecipe());
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(DelegateError);
      expect((err as DelegateError).kind).toBe("profile-not-found");
    }
  });

  it("throws llama-swap-unreachable on fetch rejection", async () => {
    globalThis.fetch = mock(async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    try {
      await delegateLoad(buildRecipe());
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(DelegateError);
      expect((err as DelegateError).kind).toBe("llama-swap-unreachable");
    }
  });
});

describe("delegateUnload", () => {
  it("POSTs per-profile /api/models/unload/<model>", async () => {
    const seen: string[] = [];
    mockFetch((url, init) => {
      seen.push(`${init?.method ?? "GET"} ${url}`);
      return { status: 200, body: { ok: true } };
    });
    await delegateUnload(buildRecipe());
    expect(seen).toEqual(["POST http://127.0.0.1:8080/api/models/unload/qwopus-9b"]);
  });

  it("falls back to blanket /api/models/unload on 404", async () => {
    const seen: string[] = [];
    mockFetch((url, init) => {
      seen.push(`${init?.method ?? "GET"} ${url}`);
      if (url.endsWith("/api/models/unload/qwopus-9b")) return { status: 404, body: {} };
      return { status: 200, body: { ok: true } };
    });
    await delegateUnload(buildRecipe());
    expect(seen).toEqual([
      "POST http://127.0.0.1:8080/api/models/unload/qwopus-9b",
      "POST http://127.0.0.1:8080/api/models/unload",
    ]);
  });

  it("throws llama-swap-unreachable on 5xx", async () => {
    mockFetch(() => ({ status: 503, body: {} }));
    await expect(delegateUnload(buildRecipe())).rejects.toThrow(DelegateError);
  });
});

describe("probeLlamaSwap", () => {
  it("returns filter URL + running list", async () => {
    mockFetch(() => ({
      status: 200,
      body: { running: [{ model: "qwopus-9b", state: "ready" }] },
    }));
    const out = await probeLlamaSwap(buildRecipe());
    expect(out.url).toBe("http://127.0.0.1:8084");
    expect(out.running).toHaveLength(1);
    expect(out.running[0]?.model).toBe("qwopus-9b");
  });
});
