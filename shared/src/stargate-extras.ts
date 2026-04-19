// STARGATE:fork-owned — never touched by upstream sync.
// Pure TypeScript types for the stargate namespaced extras block (no zod —
// `shared/` ships type-only symbols so the frontend bundle stays tiny).
// Runtime parsing lives in `controller/src/modules/lifecycle/engines/stargate-extras-parser.ts`.

export interface StargatePlacement {
  cuda_index: number | number[] | string; // "cpu+2" / "cpu+3" for CPU-offload anchors
  role:
    | "persistent"
    | "on-demand"
    | "service-shelf"
    | "dual-gpu"
    | "4-gpu"
    | "swarm"
    | "unknown";
  swap_group: string | null;
  evicts: string[];
  coresident_with: string[];
}

export interface StargateSampling {
  temp: number;
  top_p: number;
  top_k?: number;
  min_p?: number;
  presence_penalty?: number;
  repetition_penalty?: number;
}

export interface StargateExtras {
  stargate_schema_version?: 1;
  llama_swap_profile: string;
  llama_swap_url: string;
  llama_swap_filter_url: string;
  placement?: StargatePlacement;
  server_binary?: string;
  quantization?: string;
  vram_mb?: number;
  context_native?: number;
  batch_size?: number;
  ubatch_size?: number;
  sampling_general?: StargateSampling;
  sampling_thinking?: StargateSampling;
  kv_cache?: { type_k: string; type_v: string };
  // Passthrough-friendly: upstream may add keys we don't know about yet.
  [key: string]: unknown;
}
