"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  BarChart3,
  HardDrive,
  Server,
  Settings,
  Sun,
  Moon,
  Activity,
  Search,
  List,
  Wrench,
} from "lucide-react";
import { StatusDot } from "./app-sidebar/sidebar-status";
import { useAppStore } from "@/store";
import { useShallow } from "zustand/react/shallow";

// STARGATE: nav reshaped for Stargate deploy.
// - /chat + /chat2 removed (Caddy denies them; we use OpenWebUI for chat).
// - /usage, /discover, /jobs, /setup added (upstream left them off the navbar).
// - Labels hidden on mobile (< sm); icons-only so 8 tabs fit on iPhone.
const tabs = [
  { href: "/", label: "Status", icon: BarChart3 },
  { href: "/recipes", label: "Models", icon: HardDrive },
  { href: "/logs", label: "Server", icon: Server },
  { href: "/usage", label: "Usage", icon: Activity },
  { href: "/discover", label: "Discover", icon: Search },
  { href: "/jobs", label: "Jobs", icon: List },
  { href: "/configs", label: "Settings", icon: Settings },
  { href: "/setup", label: "Setup", icon: Wrench },
];

function ThemeToggle() {
  const { themeId, setThemeId } = useAppStore(
    useShallow((s) => ({ themeId: s.themeId, setThemeId: s.setThemeId })),
  );

  const isDark = themeId === "omlx-dark";

  return (
    <button
      onClick={() => setThemeId(isDark ? "omlx-light" : "omlx-dark")}
      className="p-1.5 rounded-md hover:bg-(--surface) transition-colors"
      title={isDark ? "Switch to light mode" : "Switch to dark mode"}
    >
      {isDark ? (
        <Sun className="w-4 h-4 text-(--dim)" />
      ) : (
        <Moon className="w-4 h-4 text-(--dim)" />
      )}
    </button>
  );
}

export function TopNavbar({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();

  if (pathname.startsWith("/setup")) {
    return <div className="h-full w-full">{children}</div>;
  }

  // STARGATE: no chat tab — we use OpenWebUI for chat, not Studio chat.

  return (
    <div className="flex flex-col h-full min-h-0 overflow-hidden">
      {/* Row 1: Logo on the left, theme + status on the right */}
      <nav className="w-full h-12 px-3 sm:px-4 md:px-8 border-b border-(--border) bg-(--bg)/80 backdrop-blur-md shrink-0 flex items-center z-50">
        <div className="max-w-7xl mx-auto w-full flex justify-between items-center gap-2">
          <Link href="/" className="flex items-center gap-2">
            <svg viewBox="0 0 48 48" className="w-7 h-7 text-(--fg)" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round">
              <rect x="6" y="6" width="36" height="36" rx="9" />
              <circle cx="16.5" cy="16" r="2.8" />
              <circle cx="24" cy="24" r="3.2" fill="currentColor" stroke="none" />
              <circle cx="31.5" cy="16" r="2.8" />
              <circle cx="31.5" cy="32" r="2.8" />
              <circle cx="16.5" cy="32" r="2.8" />
              <line x1="16.5" y1="16" x2="24" y2="24" />
              <line x1="31.5" y1="16" x2="24" y2="24" />
              <line x1="16.5" y1="32" x2="24" y2="24" />
              <line x1="31.5" y1="32" x2="24" y2="24" />
              <line x1="16.5" y1="16" x2="31.5" y2="32" />
              <line x1="31.5" y1="16" x2="16.5" y2="32" />
            </svg>
            <span className="font-bold tracking-tight text-sm leading-none text-(--fg)">
              vLLM Studio
            </span>
          </Link>
          <div className="flex items-center gap-3">
            <ThemeToggle />
            <StatusDot />
          </div>
        </div>
      </nav>

      {/* Row 2: full-width tab rail — each tab stretches to share the width equally */}
      <nav className="w-full border-b border-(--border) bg-(--bg)/70 backdrop-blur-md shrink-0 z-40">
        <div className="max-w-7xl mx-auto w-full px-2 sm:px-4 md:px-8">
          <div className="flex items-stretch w-full">
            {tabs.map((tab) => {
              const Icon = tab.icon;
              const isActive =
                tab.href === "/"
                  ? pathname === "/"
                  : pathname.startsWith(tab.href);
              return (
                <Link
                  key={tab.href}
                  href={tab.href}
                  aria-label={tab.label}
                  aria-current={isActive ? "page" : undefined}
                  className={`flex-1 min-w-0 flex flex-col sm:flex-row items-center justify-center gap-1 sm:gap-2 px-1 sm:px-3 py-2.5 text-xs sm:text-sm font-medium transition-colors border-b-2 ${
                    isActive
                      ? "border-(--fg) text-(--fg) bg-(--surface)/50"
                      : "border-transparent text-(--dim) hover:text-(--fg) hover:bg-(--surface)/30"
                  }`}
                >
                  <Icon className="w-4 h-4 shrink-0" />
                  <span className="truncate">{tab.label}</span>
                </Link>
              );
            })}
          </div>
        </div>
      </nav>

      {/* Main content */}
      <main className="flex-1 min-w-0 min-h-0 overflow-y-auto overflow-x-hidden bg-(--bg)">
        {children}
      </main>
    </div>
  );
}
