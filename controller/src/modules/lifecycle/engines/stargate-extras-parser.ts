// STARGATE:fork-owned — never touched by upstream sync.
// Runtime zod validator for `extra_args.stargate.*`. Lives in controller
// where zod is already a dependency; shared/ stays type-only.
import { z } from "zod";
import type { StargateExtras } from "../../../../../shared/src/stargate-extras";

const Placement = z
  .object({
    cuda_index: z.union([
      z.number().int(),
      z.array(z.number().int()),
      z.string(),
    ]),
    role: z.enum([
      "persistent",
      "on-demand",
      "service-shelf",
      "dual-gpu",
      "4-gpu",
      "swarm",
      "unknown",
    ]),
    swap_group: z.string().nullable(),
    evicts: z.array(z.string()),
    coresident_with: z.array(z.string()),
  })
  .strict();

const Sampling = z
  .object({
    temp: z.number(),
    top_p: z.number(),
    top_k: z.number().optional(),
    min_p: z.number().optional(),
    presence_penalty: z.number().optional(),
    repetition_penalty: z.number().optional(),
  })
  .passthrough();

export const StargateExtrasSchema = z
  .object({
    stargate_schema_version: z.literal(1).optional(),
    llama_swap_profile: z.string().min(1),
    llama_swap_url: z.string().url().default("http://127.0.0.1:8080"),
    llama_swap_filter_url: z.string().url().default("http://127.0.0.1:8084"),
    placement: Placement.optional(),
    server_binary: z.string().optional(),
    quantization: z.string().optional(),
    vram_mb: z.number().int().positive().optional(),
    context_native: z.number().int().positive().optional(),
    batch_size: z.number().int().positive().optional(),
    ubatch_size: z.number().int().positive().optional(),
    sampling_general: Sampling.optional(),
    sampling_thinking: Sampling.optional(),
    kv_cache: z
      .object({ type_k: z.string(), type_v: z.string() })
      .passthrough()
      .optional(),
  })
  .passthrough();

/**
 * Parse the `extra_args.stargate` namespaced block from a Recipe.
 * Returns null if no stargate namespace is present (stock upstream recipe).
 */
export function parseStargateExtras(
  extraArgs: Record<string, unknown> | null | undefined
): StargateExtras | null {
  if (!extraArgs) return null;
  const raw = (extraArgs as Record<string, unknown>)["stargate"];
  if (!raw || typeof raw !== "object") return null;
  const result = StargateExtrasSchema.safeParse(raw);
  if (!result.success) {
    const messages = result.error.issues.map(
      (issue: z.ZodIssue) => `${issue.path.join(".")}: ${issue.message}`
    );
    throw new Error(`invalid stargate extras: ${messages.join(", ")}`);
  }
  return result.data as StargateExtras;
}
