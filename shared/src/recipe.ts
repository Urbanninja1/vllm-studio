export type Backend =
  | "vllm"
  | "mlx"
  | "sglang"
  | "llamacpp"
  | "transformers"
  | "tabbyapi"
  | "exllamav3"
  | "llama-swap"; // STARGATE:fork-owned — routes lifecycle through llama-swap admin surface

/**
 * Backends that skip upstream's spawn path and delegate to an external router.
 * Predicate-based dispatch survives upstream Backend-enum renames better than
 * string-equality checks scattered across the codebase.
 */
export const DELEGATED_BACKENDS = ["llama-swap"] as const satisfies readonly Backend[];

export function isDelegatedBackend(b: Backend): boolean {
  return (DELEGATED_BACKENDS as readonly string[]).includes(b);
}

/**
 * Canonical recipe shape as sent over the wire (JSON).
 *
 * Controller uses a branded `RecipeId` internally; keep `id` as a plain string here
 * so frontend/CLI can depend on one stable definition.
 */
export interface RecipeBase {
  id: string;
  name: string;
  model_path: string;
  backend: Backend;
  env_vars: Record<string, string> | null;
  tensor_parallel_size: number;
  pipeline_parallel_size: number;
  max_model_len: number;
  gpu_memory_utilization: number;
  kv_cache_dtype: string;
  max_num_seqs: number;
  trust_remote_code: boolean;
  tool_call_parser: string | null;
  reasoning_parser: string | null;
  enable_auto_tool_choice: boolean;
  quantization: string | null;
  dtype: string | null;
  host: string;
  port: number;
  served_model_name: string | null;
  python_path: string | null;
  extra_args: Record<string, unknown>;
  max_thinking_tokens: number | null;
  thinking_mode: string;
}

/**
 * Recipe payload accepted by the controller for create/update.
 * Only `id`, `name`, and `model_path` are required; all other fields may be omitted and will be defaulted server-side.
 */
export type RecipePayload =
  & Pick<RecipeBase, "id" | "name" | "model_path">
  & Partial<Omit<RecipeBase, "id" | "name" | "model_path">>;
