/**
 * Odometer — tabular-numeric display that flips individual digit columns on
 * value change. The differentiator: when VRAM ticks 22.5 → 22.7, only the
 * '5' → '7' digit animates, not the whole number.
 *
 * Keeps string input so callers decide precision/formatting (e.g. "22.5",
 * "262144", "1094"). Does NOT auto-format — that's a locale/semantic decision
 * the caller owns.
 *
 * Honors prefers-reduced-motion — flips become instant swaps with a brief
 * opacity flash instead.
 *
 * Perf note: only re-renders the digit columns whose character changed. For
 * a dashboard with ~40 odometers this is the difference between smooth and
 * janky when the 2s poll fires.
 */

"use client";

import { memo, useEffect, useRef, useState } from "react";

interface OdometerProps {
  value: string | number;
  /** 'flip' = slide from above. 'flash' = brief opacity pulse. Defaults to 'flip'. */
  mode?: "flip" | "flash";
  className?: string;
}

export const Odometer = memo(function Odometer({
  value,
  mode = "flip",
  className,
}: OdometerProps) {
  const str = String(value);
  const chars = str.split("");
  const prev = useRef<string>(str);

  const changed = useRef<boolean[]>(chars.map((_, i) => chars[i] !== prev.current[i]));
  // Recompute change mask on each render, then persist for next time
  useEffect(() => {
    prev.current = str;
  }, [str]);

  // Alignment of digit slots so numbers don't jump around when a digit width
  // changes — tabular-nums + fixed-width '.' + '-' sign.
  return (
    <span
      className={"inline-flex font-mono tabular-nums " + (className ?? "")}
      style={{ fontVariantNumeric: "tabular-nums slashed-zero" }}
    >
      {chars.map((c, i) => (
        <Digit key={i} ch={c} mode={mode} flipped={changed.current[i]} />
      ))}
    </span>
  );
});

function Digit({ ch, mode, flipped }: { ch: string; mode: "flip" | "flash"; flipped: boolean }) {
  // Non-digit chars (., -, /, spaces) stay static — only digits animate.
  const isDigit = /[0-9]/.test(ch);
  const shouldAnimate = flipped && isDigit;

  return (
    <span
      className={
        "inline-block " +
        (shouldAnimate
          ? mode === "flip"
            ? "odo-digit-enter"
            : "animate-[log-flash_var(--duration-base)_var(--ease-flight)]"
          : "")
      }
      style={{ minWidth: isDigit ? "0.62em" : undefined }}
    >
      {ch}
    </span>
  );
}
