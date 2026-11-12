"use client";

import { useEffect, useState } from "react";
import { CheckCircle2, XCircle, Loader2 } from "lucide-react";

type Check = { ok: boolean; error?: string | null; detail?: string };
type Health = {
  status: string;
  checks: { database: Check; ai: Check; realtime: Check };
};

const LABELS: Record<string, string> = {
  database: "Database",
  ai: "AI (Gemini)",
  realtime: "Real-time media",
};

export default function SystemStatus() {
  const [health, setHealth] = useState<Health | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/health")
      .then((res) => res.json())
      .then((data) => {
        if (!cancelled) setHealth(data);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "Could not reach the server");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (error) {
    return <p className="text-sm text-danger">Health check failed: {error}</p>;
  }

  if (!health) {
    return (
      <p className="flex items-center gap-2 text-sm text-muted">
        <Loader2 className="h-4 w-4 animate-spin" /> Checking services…
      </p>
    );
  }

  return (
    <ul className="space-y-2 text-sm">
      {Object.entries(health.checks).map(([key, check]) => (
        <li key={key} className="flex items-start gap-2">
          {check.ok ? (
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-accent" />
          ) : (
            <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-warn" />
          )}
          <span>
            <span className="font-medium text-ink">{LABELS[key] ?? key}</span>
            <span className="block text-xs text-muted">{check.detail ?? check.error}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}
