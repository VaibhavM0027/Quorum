"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Sparkles } from "lucide-react";

/**
 * Lets the host (re)run the evaluation from the report page. Rendered only for
 * the host, because running the evaluation consumes AI quota.
 */
export default function RunEvaluationButton({ discussionId }: { discussionId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/discussions/${discussionId}/evaluate`, { method: "POST" });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(data.error ?? "The evaluation could not be run");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "The evaluation could not be run");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <button type="button" className="btn-primary" onClick={() => void run()} disabled={busy}>
        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
        {busy ? "Assessing…" : "Run evaluation"}
      </button>
      {error && <p className="text-xs text-danger">{error}</p>}
    </div>
  );
}
