// CRITICAL
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { createWriteStream, existsSync, readFileSync } from "node:fs";
import type { WriteStream } from "node:fs";
import { createInterface } from "node:readline";
import { resolve } from "node:path";
import { setTimeout as delayTimeout } from "node:timers/promises";
import { parse as parseYaml } from "yaml";
import type { Config } from "../../../config/env";
import { delay } from "../../../core/async";
import {
  cleanupLogFiles,
  getLogCleanupDefaultsFromEnvironment,
  primaryLogPathFor,
} from "../../../core/log-files";
import type { Logger } from "../../../core/logger";
import type { LaunchResult, ProcessInfo, Recipe } from "../types";
import type { EventManager } from "../../monitoring/event-manager";
import { buildBackendCommand } from "../engines/backends";
import { isDelegatedBackend } from "../../../../../shared/src/recipe";        // STARGATE
import { delegateLoad, DelegateError } from "../engines/llama-swap-delegate"; // STARGATE
import {
  buildEnvironment,
  collectChildren,
  detectBackend,
  extractFlag,
  fetchTabbyModel,
  listProcesses,
  pidExists,
  buildProcessTree,
} from "./process-utilities";

/**
 * Controller process manager.
 */
export interface ProcessManager {
  findInferenceProcess: (port: number) => Promise<ProcessInfo | null>;
  launchModel: (recipe: Recipe) => Promise<LaunchResult>;
  evictModel: (force: boolean) => Promise<number | null>;
  killProcess: (pid: number, force: boolean) => Promise<boolean>;
}

/**
 * Create a process manager.
 * @param config - Runtime config.
 * @param logger - Logger instance.
 * @param eventManager - Event manager for log forwarding.
 * @returns Process manager.
 */
// STARGATE: probe llama-swap for its running set and synthesize a ProcessInfo
// for a DETERMINISTIC ready model so the UI Dashboard's Status section stays
// on one model (no slideshow cycling). We prefer persistent models in this
// priority order; the first match wins.
const PERSISTENT_PRIORITY = [
  "gemma-4-31b-uncensored",     // 3090 #2 persistent (uncensored vision+text, Mode C default)
  "qwen3.5-397b",                // 3090 #3 persistent (frontier aligned)
  "qwen3.6-35b-a3b-hauhau-p6000", // P6000 #0 persistent (fast uncensored)
  "gemma-4-e4b-hauhau-p6000",    // P6000 #1 shelf (OWU task model)
  "qwen3-embed-p6000",            // P6000 #1 shelf (embed)
  "qwen3-reranker-p6000",         // P6000 #1 shelf (rerank)
  "glm-ocr-p6000",                // P6000 #1 shelf (OCR)
];

async function findDelegatedInferenceProcess(): Promise<ProcessInfo | null> {
  const url = process.env["STARGATE_LLAMA_SWAP_FILTER_URL"] ?? "http://127.0.0.1:8084";
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 1500);
    try {
      const res = await fetch(`${url}/running`, { signal: ctl.signal });
      if (!res.ok) return null;
      const body = (await res.json()) as { running?: Array<{ model: string; state: string }> };
      const ready = new Set(
        (body.running ?? []).filter((m) => m.state === "ready").map((m) => m.model)
      );
      if (ready.size === 0) return null;
      // Pick the highest-priority persistent that's ready; fall back to any
      // ready model by stable sort.
      let picked: string | null = null;
      for (const candidate of PERSISTENT_PRIORITY) {
        if (ready.has(candidate)) { picked = candidate; break; }
      }
      if (!picked) {
        picked = [...ready].sort()[0] ?? null;
      }
      if (!picked) return null;
      return {
        pid: 0,
        backend: "llama-swap",
        model_path: picked,
        port: 8080,
        served_model_name: picked,
      };
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return null;
  }
}

export const createProcessManager = (
  config: Config,
  logger: Logger,
  eventManager?: EventManager
): ProcessManager => {
  /**
   * Locate the inference process by port.
   * @param port - Port to match.
   * @returns Process info or null.
   */
  const findInferenceProcess = async (port: number): Promise<ProcessInfo | null> => {
    // STARGATE: when no native child is spawned but llama-swap is serving a
    // delegated model, synthesize a ProcessInfo so the UI's Dashboard shows
    // Active + Model Loaded.
    const synthesized = await findDelegatedInferenceProcess();
    if (synthesized) return synthesized;
    const processes = listProcesses();
    for (const proc of processes) {
      const backend = detectBackend(proc.args);
      if (!backend) {
        continue;
      }
      const flagPort = extractFlag(proc.args, "--port");
      if (backend === "tabbyapi") {
        if (port !== 8000) {
          continue;
        }
      } else if (!flagPort || Number(flagPort) !== port) {
        continue;
      }
      let modelPath =
        extractFlag(proc.args, "--model") || extractFlag(proc.args, "--model-path");
      if (!modelPath && (backend === "llamacpp" || backend === "exllamav3")) {
        modelPath = extractFlag(proc.args, "-m");
      }
      let servedModelName =
        extractFlag(proc.args, "--served-model-name") ||
        extractFlag(proc.args, "--alias") ||
        extractFlag(proc.args, "-a");

      if (!modelPath) {
        const serveIndex = proc.args.indexOf("serve");
        if (serveIndex >= 0 && serveIndex + 1 < proc.args.length) {
          const candidate = proc.args[serveIndex + 1];
          if (candidate && !candidate.startsWith("-")) {
            modelPath = candidate;
          }
        }
      }

      if (backend === "tabbyapi" && !modelPath) {
        const tabbyDirectory = config.tabby_api_dir || "/opt/tabbyAPI";
        const configFlag = extractFlag(proc.args, "--config");
        if (configFlag) {
          const configPath = resolve(tabbyDirectory, configFlag);
          if (existsSync(configPath)) {
            try {
              const content = readFileSync(configPath, "utf-8");
              const parsed = parseYaml(content) as Record<string, unknown>;
              const model = parsed["model"] as Record<string, unknown> | undefined;
              const modelName = model?.["model_name"];
              if (typeof modelName === "string") {
                modelPath = resolve(config.models_dir, modelName);
                servedModelName = modelName;
              }
            } catch {
              return {
                pid: proc.pid,
                backend,
                model_path: "tabbyapi:unknown",
                port,
                served_model_name: servedModelName ?? "GLM-4.7",
              };
            }
          }
        }
        if (!modelPath) {
          const tabbyResult = await fetchTabbyModel(port, tabbyDirectory, config.models_dir);
          modelPath = tabbyResult.modelPath ?? modelPath;
          servedModelName = tabbyResult.servedModelName ?? servedModelName;
        }
      }

      if (!modelPath && backend === "tabbyapi") {
        return {
          pid: proc.pid,
          backend,
          model_path: "tabbyapi:unknown",
          port,
          served_model_name: servedModelName ?? "GLM-4.7",
        };
      }

      return {
        pid: proc.pid,
        backend,
        model_path: modelPath ?? null,
        port,
        served_model_name: servedModelName ?? null,
      };
    }
    return null;
  };

  /**
   * Kill a process and its children.
   * @param pid - Process id.
   * @param force - Force kill if true.
   * @returns True on success.
   */
  const killProcess = async (pid: number, force: boolean): Promise<boolean> => {
    if (!pidExists(pid)) {
      return true;
    }
    const tree = buildProcessTree();
    const children = new Set<number>();
    collectChildren(tree, pid, children);
    const allPids = [...children, pid];

    const signal = force ? "SIGKILL" : "SIGTERM";
    for (const childPid of allPids) {
      try {
        process.kill(childPid, signal);
      } catch {
        continue;
      }
    }

    if (!force) {
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        if (!pidExists(pid)) {
          break;
        }
        await delayTimeout(250);
      }
      if (pidExists(pid)) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          return false;
        }
      }
    }

    await delay(force ? 500 : 1000);
    return true;
  };

  /**
   * Launch an inference backend for a recipe.
   * @param recipe - Recipe data.
   * @returns Launch result.
   */
  const launchModel = async (recipe: Recipe): Promise<LaunchResult> => {
    const updatedRecipe: Recipe = {
      ...recipe,
      port: config.inference_port,
    };
    // STARGATE: llama-swap backend delegates — no spawn, warmup-request + poll.
    if (isDelegatedBackend(updatedRecipe.backend)) {
      try {
        await delegateLoad(updatedRecipe);
        return {
          success: true,
          pid: null,
          message: `delegated to llama-swap`,
          log_file: primaryLogPathFor(config.data_dir, updatedRecipe.id),
        };
      } catch (err) {
        const message =
          err instanceof DelegateError
            ? `[${err.kind}] ${err.message}`
            : err instanceof Error
              ? err.message
              : String(err);
        return {
          success: false,
          pid: null,
          message,
          log_file: primaryLogPathFor(config.data_dir, updatedRecipe.id),
        };
      }
    }
    let command: string[] | null = null;
    try {
      command = buildBackendCommand(updatedRecipe, config);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        pid: null,
        message,
        log_file: primaryLogPathFor(config.data_dir, updatedRecipe.id),
      };
    }
    if (!command) {
      return {
        success: false,
        pid: null,
        message: "Invalid launch command",
        log_file: primaryLogPathFor(config.data_dir, updatedRecipe.id),
      };
    }

    const logFile = primaryLogPathFor(config.data_dir, updatedRecipe.id);
    // Best-effort retention to prevent unbounded growth over long-running installs.
    cleanupLogFiles(config.data_dir, {
      ...getLogCleanupDefaultsFromEnvironment(),
      excludePaths: new Set([logFile]),
    });
    const env = buildEnvironment(updatedRecipe);

    try {
      const entry = command[0];
      if (!entry) {
        return {
          success: false,
          pid: null,
          message: "Invalid launch command",
          log_file: logFile,
        };
      }
      let spawnError: string | null = null;

      // Use pipes to capture stdout/stderr for forwarding
      const child = spawn(entry, command.slice(1), {
        stdio: ["ignore", "pipe", "pipe"],
        env,
        detached: true,
      }) as ChildProcess;

      child.on("error", (error) => {
        spawnError = String(error);
      });

      // Create log file stream
      let logStream: WriteStream | null = null;
      try {
        logStream = createWriteStream(logFile, { flags: "a" });
      } catch (logError) {
        logger.warn("Failed to open log file", {
          error: String(logError),
        });
      }

      // Forward stdout to log file and event manager
      if (child.stdout) {
        const rl = createInterface({
          input: child.stdout,
          crlfDelay: Infinity,
        });
        rl.on("line", (line) => {
          if (logStream) {
            logStream.write(line + "\n");
          }
          if (eventManager) {
            eventManager.publishLogLine(updatedRecipe.id, line).catch(() => {});
          }
        });
      }

      // Forward stderr to log file and event manager
      if (child.stderr) {
        const rl = createInterface({
          input: child.stderr,
          crlfDelay: Infinity,
        });
        rl.on("line", (line) => {
          if (logStream) {
            logStream.write(line + "\n");
          }
          if (eventManager) {
            eventManager.publishLogLine(updatedRecipe.id, line).catch(() => {});
          }
        });
      }

      // Close log stream when process exits
      child.on("exit", () => {
        if (logStream) {
          logStream.end();
        }
      });

      child.unref();

      await delay(3000);
      if (spawnError) {
        if (logStream) {
          logStream.end();
        }
        return {
          success: false,
          pid: null,
          message: spawnError,
          log_file: logFile,
        };
      }
      if (child.exitCode !== null) {
        if (logStream) {
          logStream.end();
        }
        return {
          success: false,
          pid: null,
          message: "Process exited early",
          log_file: logFile,
        };
      }
      return {
        success: true,
        pid: child.pid ?? null,
        message: "Process started",
        log_file: logFile,
      };
    } catch (error) {
      logger.error("Launch failed", { error: String(error) });
      return {
        success: false,
        pid: null,
        message: String(error),
        log_file: logFile,
      };
    }
  };

  /**
   * Evict the running inference process.
   * @param force - Force kill if true.
   * @returns Evicted pid or null.
   */
  const evictModel = async (force: boolean): Promise<number | null> => {
    const current = await findInferenceProcess(config.inference_port);
    if (!current) {
      return null;
    }
    await killProcess(current.pid, force);
    return current.pid;
  };

  return {
    findInferenceProcess,
    launchModel,
    evictModel,
    killProcess,
  };
};
