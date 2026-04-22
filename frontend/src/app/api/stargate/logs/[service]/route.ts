/**
 * Logs proxy — thin pass-through to the Stargate Agent API's /system/logs.
 *
 * Endpoint: GET /api/stargate/logs/<service>?lines=<N>&since=<duration>
 *
 * Agent API returns `{ lines: string[] }` (journalctl tail). We parse each
 * line into the Flight Ops LogLine shape (ts, level, msg, unit) and return
 * as JSON. Browser polls this every 2s and merge-dedupes by ts+msg.
 *
 * Why polling, not SSE: keeps the Agent API surface stable (no new route),
 * avoids a long-lived proxy connection through Next.js, and the 2s cadence
 * is well within human perception of "following tail".
 */

import { NextResponse } from "next/server";

const AGENT_API = process.env.STARGATE_AGENT_API_URL ?? "http://localhost:8096";

const LEVEL_RE = /\b(DEBUG|INFO|WARN(?:ING)?|ERROR|CRITICAL|FATAL)\b/i;
// journalctl timestamps e.g. "2026-04-22T19:23:45.123456+00:00 hostname unit[pid]: ..."
const ISO_TS_RE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)/;

type LogLevel = "DEBUG" | "INFO" | "WARN" | "ERROR";

interface LogLine {
  ts: number;
  level: LogLevel;
  msg: string;
  unit: string;
}

function classifyLevel(line: string): LogLevel {
  const m = LEVEL_RE.exec(line);
  if (!m) return "INFO";
  const tok = m[1].toUpperCase();
  if (tok === "DEBUG") return "DEBUG";
  if (tok === "WARN" || tok === "WARNING") return "WARN";
  if (tok === "ERROR" || tok === "CRITICAL" || tok === "FATAL") return "ERROR";
  return "INFO";
}

function parseTimestamp(line: string): number {
  const m = ISO_TS_RE.exec(line);
  if (!m) return Date.now();
  const d = new Date(m[1]);
  return isFinite(d.getTime()) ? d.getTime() : Date.now();
}

function parseLine(raw: string, unit: string): LogLine {
  return {
    ts: parseTimestamp(raw),
    level: classifyLevel(raw),
    msg: raw,
    unit,
  };
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ service: string }> },
) {
  const { service } = await params;
  const url = new URL(req.url);
  const lines = url.searchParams.get("lines") ?? "200";
  const since = url.searchParams.get("since") ?? "5m";

  const target = `${AGENT_API}/system/logs?service=${encodeURIComponent(
    service,
  )}&lines=${encodeURIComponent(lines)}&since=${encodeURIComponent(since)}`;

  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 4000);
    const res = await fetch(target, { signal: ctl.signal, cache: "no-store" });
    clearTimeout(t);
    if (!res.ok) {
      return NextResponse.json(
        { lines: [], error: `agent-api ${res.status}` },
        { status: 200 },
      );
    }
    const body = (await res.json()) as {
      lines?: string[];
      error?: string;
      valid?: string[];
    };
    if (body.error) {
      return NextResponse.json({ lines: [], error: body.error }, { status: 200 });
    }
    const parsed = (body.lines ?? [])
      .filter((l) => l.trim().length > 0)
      .map((l) => parseLine(l, service));
    return NextResponse.json({
      lines: parsed,
      service,
      fetched_at: new Date().toISOString(),
    });
  } catch (err) {
    return NextResponse.json(
      { lines: [], error: String(err) },
      { status: 200 },
    );
  }
}
