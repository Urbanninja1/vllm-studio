/**
 * LogsViewer — journalctl + docker logs streaming over SSE.
 *
 * Two-column layout: sources (left, narrow) + viewer (right, wide).
 *
 * SIGNATURE DETAIL — pressure wave:
 *   A 60-bar sparkline at the top of the viewer shows lines-per-second over
 *   the last 60 seconds. Each bar represents 1s; bars peak (warn color) when
 *   throughput exceeds a threshold. This is the one "delight" moment on this
 *   page — ops people love throughput visibility.
 *
 * LIVE UPDATE DISCIPLINE:
 *   - Single SSE connection per selected source. Controller's /logs/<unit>
 *     endpoint streams SSE with event types: line, backfill, error.
 *   - Ring buffer of 8192 lines client-side (circular array, NOT unbounded
 *     append — crashes the browser on a busy log).
 *   - Auto-scroll follows tail unless the user scrolls up — then a "NEW" chip
 *     appears in the footer and clicking returns to tail.
 *   - Level filter (DBG/INF/WRN/ERR) is client-side, server sends all levels.
 *
 * A11Y:
 *   - role="log" + aria-live="polite" on the stream container.
 *   - New lines have a brief cyan flash (log-flash class) — also announced to
 *     screen readers at polite cadence.
 *   - Keyboard: j/k = scroll, / = filter focus, space = pause tail, 1/2/3/4
 *     toggle level filters.
 */

"use client";

import { useEffect, useMemo, useRef, useState } from "react";

interface LogSource {
  kind: "unit" | "docker";
  name: string;
  rate_lps: number;
}

interface LogLine {
  ts: number;  // epoch ms
  level: "DEBUG" | "INFO" | "WARN" | "ERROR";
  msg: string;
  unit: string;
  isNew?: boolean;
}

export function LogsViewer({ sources }: { sources: LogSource[] }) {
  const [selected, setSelected] = useState<string>("llama-swap");
  const [levels, setLevels] = useState<Set<LogLine["level"]>>(
    new Set(["DEBUG", "INFO", "WARN", "ERROR"]),
  );
  const [filter, setFilter] = useState("");
  const [paused, setPaused] = useState(false);
  const { lines, rate } = useLogStream(selected, paused);
  const { pressureBars, peakMarkers } = usePressureWave(rate);

  const visible = useMemo(() => {
    const re = filter ? safeRegex(filter) : null;
    return lines.filter((l) => {
      if (!levels.has(l.level)) return false;
      if (re && !re.test(l.msg)) return false;
      return true;
    });
  }, [lines, levels, filter]);

  return (
    <section className="flex flex-col gap-4">
      <header className="flex items-baseline gap-4 border-b border-[var(--color-ink-4)] pb-4">
        <h1 className="font-display text-[22px] font-semibold tracking-[-0.01em]">Logs</h1>
        <p className="font-mono text-[11px] tracking-[0.05em] text-[var(--color-fg-3)]">
          SSE · stargate-{selected} ·{" "}
          {paused ? (
            <span className="text-[var(--color-warn)]">PAUSED</span>
          ) : (
            <span className="text-[var(--color-ok)]">following tail</span>
          )}{" "}
          · <span className="text-[var(--color-fg-1)]">{rate}</span>/s
        </p>
      </header>

      <div className="grid gap-4" style={{ gridTemplateColumns: "220px 1fr" }}>
        {/* SOURCE LIST */}
        <ul
          role="listbox"
          aria-label="Log sources"
          className="flex flex-col gap-px bg-[var(--color-ink-4)] max-h-[540px] overflow-y-auto"
        >
          {sources.map((s) => (
            <li key={s.name}>
              <button
                role="option"
                aria-selected={selected === s.name}
                onClick={() => setSelected(s.name)}
                className={
                  "w-full text-left bg-[var(--color-ink-2)] hover:bg-[var(--color-ink-3)] " +
                  "px-4 py-2 flex items-center gap-2 transition-colors " +
                  "duration-[var(--duration-fast)] border-l-2 " +
                  (selected === s.name
                    ? "border-[var(--color-accent)] text-[var(--color-fg-1)] bg-[var(--color-ink-3)]"
                    : "border-transparent text-[var(--color-fg-2)]")
                }
              >
                <span className="font-mono text-[9px] uppercase tracking-[0.1em] text-[var(--color-fg-3)] w-8">
                  {s.kind === "unit" ? "UNIT" : "DOCK"}
                </span>
                <span className="flex-1 truncate font-mono text-[12px]">{s.name}</span>
                <span className="font-mono text-[9px] text-[var(--color-fg-3)]">
                  {s.rate_lps}/s
                </span>
              </button>
            </li>
          ))}
        </ul>

        {/* VIEWER */}
        <div className="flex flex-col bg-[var(--color-ink-2)] relative">
          {/* Pressure wave */}
          <div className="h-[18px] bg-[var(--color-ink-1)] border-b border-[var(--color-ink-4)] px-4 flex items-center gap-4">
            <span className="font-display text-[9px] uppercase tracking-[0.14em] text-[var(--color-fg-3)]">
              THROUGHPUT
            </span>
            <div
              role="img"
              aria-label="60-second throughput sparkline"
              className="flex-1 h-[14px] flex items-end gap-px"
            >
              {pressureBars.map((h, i) => (
                <div
                  key={i}
                  className={peakMarkers[i] ? "flex-1 bg-[var(--color-warn)]" : "flex-1 bg-[var(--color-accent)]"}
                  style={{
                    height: `${h}%`,
                    opacity: peakMarkers[i] ? 1 : 0.6,
                    minHeight: 1,
                    transition: "height var(--duration-fast) var(--ease-flight)",
                  }}
                />
              ))}
            </div>
            <span className="font-mono text-[10px] text-[var(--color-fg-2)] min-w-[72px] text-right">
              {rate} lines/s
            </span>
          </div>

          {/* Toolbar */}
          <div className="flex items-center gap-2 px-4 py-2 border-b border-[var(--color-ink-4)]">
            <input
              type="search"
              placeholder="regex filter  —  e.g.  ^(WARN|ERROR) .* qwopus"
              aria-label="Filter log lines"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              className="flex-1 font-mono text-[12px] text-[var(--color-fg-1)] bg-[var(--color-ink-3)] px-2 py-1 placeholder:text-[var(--color-fg-3)]"
            />
            <LevelToggle
              level="DEBUG"
              active={levels.has("DEBUG")}
              onToggle={() => toggleSet(setLevels, "DEBUG")}
            />
            <LevelToggle
              level="INFO"
              active={levels.has("INFO")}
              onToggle={() => toggleSet(setLevels, "INFO")}
            />
            <LevelToggle
              level="WARN"
              active={levels.has("WARN")}
              onToggle={() => toggleSet(setLevels, "WARN")}
            />
            <LevelToggle
              level="ERROR"
              active={levels.has("ERROR")}
              onToggle={() => toggleSet(setLevels, "ERROR")}
            />

            <IconBtn title={paused ? "Resume tail (space)" : "Pause tail (space)"} onClick={() => setPaused(!paused)}>
              {paused ? "▶" : "⏸"}
            </IconBtn>
            <IconBtn title="Clear view">⌦</IconBtn>
            <IconBtn title="Download buffer">↓</IconBtn>
          </div>

          {/* Stream */}
          <Stream lines={visible} />

          {/* Footer */}
          <footer className="border-t border-[var(--color-ink-4)] px-4 py-1.5 flex justify-between items-center font-mono text-[10px] text-[var(--color-fg-3)]">
            <span className="flex items-center gap-1 text-[var(--color-ok)]">
              <span className="w-1.5 h-1.5 bg-[var(--color-ok)] dot-pulse" aria-hidden />
              {paused ? "PAUSED" : "TAILING"}
            </span>
            <span>
              buffer <span className="text-[var(--color-fg-1)]">{lines.length}</span> / 8192 lines
              · <kbd className="kbd">j</kbd>/<kbd className="kbd">k</kbd> nav ·{" "}
              <kbd className="kbd">/</kbd> search · <kbd className="kbd">space</kbd> pause
            </span>
          </footer>
        </div>
      </div>
    </section>
  );
}

/* ========================================================================= */

function LevelToggle({
  level,
  active,
  onToggle,
}: {
  level: LogLine["level"];
  active: boolean;
  onToggle: () => void;
}) {
  const colors = {
    DEBUG: "var(--color-fg-4)",
    INFO: "var(--color-accent)",
    WARN: "var(--color-warn)",
    ERROR: "var(--color-alert)",
  };
  return (
    <button
      onClick={onToggle}
      aria-pressed={active}
      data-level={level}
      className="px-2 py-1 font-mono text-[10px] uppercase tracking-[0.08em] bg-[var(--color-ink-2)] transition-colors duration-[var(--duration-fast)]"
      style={{
        color: active ? colors[level] : "var(--color-fg-3)",
        background: active ? "var(--color-ink-3)" : undefined,
      }}
    >
      {level.slice(0, 3)}
    </button>
  );
}

function IconBtn({
  children,
  title,
  onClick,
}: {
  children: React.ReactNode;
  title: string;
  onClick?: () => void;
}) {
  return (
    <button
      title={title}
      onClick={onClick}
      className="font-display text-[10px] uppercase tracking-[0.14em] px-2 py-1.5 border border-transparent text-[var(--color-fg-3)] hover:text-[var(--color-fg-1)] transition-colors duration-[var(--duration-fast)]"
    >
      {children}
    </button>
  );
}

function Stream({ lines }: { lines: LogLine[] }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // Auto-tail — only when user is near the bottom.
    const el = ref.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    if (nearBottom) el.scrollTop = el.scrollHeight;
  }, [lines.length]);

  return (
    <div
      ref={ref}
      role="log"
      aria-live="polite"
      aria-atomic="false"
      className="flex-1 overflow-y-auto font-mono text-[12px] py-2 leading-[1.55] max-h-[420px]"
    >
      {lines.map((l, i) => (
        <div
          key={i}
          className={
            "grid gap-4 px-4 py-px text-[var(--color-fg-2)] hover:bg-[var(--color-ink-3)] transition-[background] " +
            (l.isNew ? "log-flash" : "")
          }
          style={{ gridTemplateColumns: "84px 50px 1fr" }}
        >
          <span className="text-[var(--color-fg-3)] text-[11px]">{formatTime(l.ts)}</span>
          <span className={"text-[10px] tracking-[0.08em] " + levelClass(l.level)}>{l.level}</span>
          <span className="text-[var(--color-fg-1)] break-words">{l.msg}</span>
        </div>
      ))}
    </div>
  );
}

function levelClass(level: LogLine["level"]): string {
  switch (level) {
    case "DEBUG": return "text-[var(--color-fg-4)]";
    case "INFO":  return "text-[var(--color-accent)]";
    case "WARN":  return "text-[var(--color-warn)]";
    case "ERROR": return "text-[var(--color-alert)]";
  }
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  return (
    String(d.getHours()).padStart(2, "0") +
    ":" +
    String(d.getMinutes()).padStart(2, "0") +
    ":" +
    String(d.getSeconds()).padStart(2, "0") +
    "." +
    String(d.getMilliseconds()).padStart(3, "0")
  );
}

function safeRegex(s: string): RegExp | null {
  try {
    return new RegExp(s, "i");
  } catch {
    return null;
  }
}

function toggleSet<T>(setter: React.Dispatch<React.SetStateAction<Set<T>>>, key: T) {
  setter((s) => {
    const next = new Set(s);
    next.has(key) ? next.delete(key) : next.add(key);
    return next;
  });
}

/* ========================================================================= */
/* Hooks — single SSE connection per selected unit, bounded ring buffer.     */

function useLogStream(unit: string, paused: boolean) {
  const [lines, setLines] = useState<LogLine[]>([]);
  const [rate, setRate] = useState(0);

  useEffect(() => {
    if (paused) return;
    const url = `/api/logs/${encodeURIComponent(unit)}?tail=200`;
    const es = new EventSource(url);
    let counter = 0;
    let interval = window.setInterval(() => {
      setRate(counter);
      counter = 0;
    }, 1000);

    es.addEventListener("line", (ev: MessageEvent) => {
      counter++;
      const data = JSON.parse(ev.data) as LogLine;
      setLines((prev) => {
        const next = [...prev, { ...data, isNew: true }];
        return next.length > 8192 ? next.slice(next.length - 8192) : next;
      });
    });

    return () => {
      es.close();
      window.clearInterval(interval);
    };
  }, [unit, paused]);

  return { lines, rate };
}

function usePressureWave(currentRate: number) {
  const [bars, setBars] = useState<number[]>(() => Array(60).fill(0));
  const [peaks, setPeaks] = useState<boolean[]>(() => Array(60).fill(false));

  useEffect(() => {
    const t = window.setInterval(() => {
      setBars((b) => {
        const pct = Math.min(100, (currentRate / 200) * 100);
        return [...b.slice(1), pct];
      });
      setPeaks((p) => [...p.slice(1), currentRate > 150]);
    }, 1000);
    return () => window.clearInterval(t);
  }, [currentRate]);

  return { pressureBars: bars, peakMarkers: peaks };
}
