/**
 * Panel — the single-most-reused primitive in Stargate vLLM Studio.
 *
 * Replaces the default card-with-rounded-corners-and-shadow.
 * Uses ops-HUD corner brackets that extend on hover/focus, a hairline bottom
 * border on the header, and support for a top-layer scanline for live panels.
 *
 * Aesthetic notes:
 *   - No border-radius. No shadow.
 *   - Brackets animate on state change (duration-base + ease-flight).
 *   - `scanning` prop pairs with SSE subscription status — caller hoists the
 *     subscription, Panel just shows the wipe.
 *   - `title` is intentionally uppercase display type — keep it SHORT (≤3 words).
 *
 * Accessibility:
 *   - If the panel is interactive (`as="button"`), caller adds aria-label; we
 *     put `tabIndex={0}` on the container so kbd users can reach it.
 *   - The scanline is decorative — `aria-hidden`.
 *   - For panels with live-updating data, wrap the body in `role="status"` at
 *     the call site, not here (Panel is content-neutral).
 */

"use client";

import { ReactNode, forwardRef } from "react";

export interface PanelProps {
  title?: string;
  count?: string | number;
  actions?: ReactNode;
  scanning?: boolean;
  active?: boolean;
  className?: string;
  contentClassName?: string;
  children: ReactNode;
  /** Makes the whole panel tabbable — pair with onClick for interactive cards. */
  interactive?: boolean;
  onClick?: () => void;
  ariaLabel?: string;
}

export const Panel = forwardRef<HTMLElement, PanelProps>(function Panel(
  {
    title,
    count,
    actions,
    scanning,
    active,
    className,
    contentClassName,
    children,
    interactive,
    onClick,
    ariaLabel,
  },
  ref,
) {
  const Tag = interactive ? "button" : "article";

  return (
    <Tag
      ref={ref as never}
      data-active={active ? "true" : undefined}
      onClick={onClick}
      aria-label={ariaLabel}
      tabIndex={interactive ? 0 : undefined}
      className={[
        "panel relative bg-[var(--color-ink-2)] p-4",
        "flex flex-col gap-2",
        "transition-colors duration-[var(--duration-fast)]",
        interactive ? "cursor-pointer text-left hover:bg-[var(--color-ink-3)]" : "",
        className ?? "",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {/* Four corner brackets — the ops-HUD tell. */}
      <span className="bracket bracket--tl" aria-hidden />
      <span className="bracket bracket--tr" aria-hidden />
      <span className="bracket bracket--bl" aria-hidden />
      <span className="bracket bracket--br" aria-hidden />

      {scanning && <span className="scanline" aria-hidden />}

      {(title || actions) && (
        <header className="flex items-center justify-between border-b border-[var(--color-ink-4)] pb-2 mb-1">
          {title && (
            <h3
              className="font-display text-[11px] font-semibold uppercase tracking-[0.14em] text-[var(--color-fg-2)]"
            >
              {title}
              {count !== undefined && (
                <span className="ml-2 font-mono text-[10px] font-normal text-[var(--color-fg-3)]">
                  · {count}
                </span>
              )}
            </h3>
          )}
          {actions && <div className="flex items-center gap-1">{actions}</div>}
        </header>
      )}

      <div className={contentClassName}>{children}</div>
    </Tag>
  );
});

/**
 * PanelAction — tertiary action button sized to sit in a Panel header.
 * Uppercase, spaced-out display caps. Cyan on hover only.
 */
export function PanelAction({
  children,
  onClick,
  disabled,
  ariaLabel,
}: {
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  ariaLabel?: string;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      aria-label={ariaLabel}
      className="font-mono text-[10px] uppercase tracking-[0.04em] text-[var(--color-fg-3)]
                 px-1.5 py-0.5 transition-colors duration-[var(--duration-fast)]
                 hover:text-[var(--color-accent)] disabled:opacity-40 disabled:pointer-events-none"
    >
      {children}
    </button>
  );
}
