"use client";

import { Dashboard } from "@/components/flight-ops/Dashboard";
import "@/components/flight-ops/tokens.css";

export default function FlightOpsPreview() {
  return (
    <main className="min-h-screen bg-[var(--color-bg-0)] text-[var(--color-fg-0)] p-8">
      <Dashboard />
    </main>
  );
}
