// CRITICAL
import type { AppContext } from "../../types/context";
import { buildLocalUrl, fetchLocal, type LocalFetchOptions } from "../../http/local-fetch";
import type { Recipe } from "../../modules/lifecycle/types";                                      // STARGATE
import { isDelegatedBackend } from "../../../../shared/src/recipe";                               // STARGATE
import { parseStargateExtras } from "../../modules/lifecycle/engines/stargate-extras-parser";    // STARGATE

// STARGATE: when the active recipe delegates to llama-swap, route probes through
// the filter proxy (:8084) instead of the upstream inference port. Caller passes
// the active recipe so we can inspect `extra_args.stargate.llama_swap_filter_url`.
export const resolveProbeUrl = (context: AppContext, recipe: Recipe | null, path: string): string => {
  if (recipe && isDelegatedBackend(recipe.backend)) {
    const extras = parseStargateExtras(recipe.extra_args);
    if (extras?.llama_swap_filter_url) return `${extras.llama_swap_filter_url}${path}`;
  }
  return buildLocalUrl(context.config.inference_port, path);
};

export const buildInferenceUrl = (context: AppContext, path: string): string =>
  buildLocalUrl(context.config.inference_port, path);

export const fetchInference = (context: AppContext, path: string, options: LocalFetchOptions = {}): Promise<Response> =>
  fetchLocal(context.config.inference_port, path, options);

