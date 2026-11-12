"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Loader2, Radio, Users2, Clock } from "lucide-react";

type Preview = {
  id: string;
  title: string;
  topic: string;
  context: string;
  rules: string;
  status: "SCHEDULED" | "LIVE" | "COMPLETED" | "CANCELLED";
  mode: string;
  scheduledAt: string;
  durationMin: number;
  maxParticipants: number;
  participantCount: number;
  hostName: string;
  allowNewJoiners: boolean;
};

export default function JoinClient({
  initialCode,
  signedIn,
}: {
  initialCode: string;
  signedIn: boolean;
}) {
  const router = useRouter();
  const [code, setCode] = useState(initialCode);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const lookup = useCallback(
    async (value: string) => {
      if (value.trim().length < 4) return;
      setBusy(true);
      setError(null);
      try {
        const res = await fetch(`/api/discussions/join?code=${encodeURIComponent(value.trim())}`);
        const data = (await res.json().catch(() => ({}))) as { error?: string; discussion?: Preview };
        if (!res.ok) throw new Error(data.error ?? "Could not find that discussion");
        setPreview(data.discussion!);
      } catch (err) {
        setPreview(null);
        setError(err instanceof Error ? err.message : "Could not find that discussion");
      } finally {
        setBusy(false);
      }
    },
    [],
  );

  useEffect(() => {
    if (initialCode && signedIn) void lookup(initialCode);
  }, [initialCode, signedIn, lookup]);

  async function join() {
    if (!preview) return;
    if (!signedIn) {
      router.push(`/login?next=${encodeURIComponent(`/join?code=${preview ? code : ""}`)}`);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/discussions/join", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string; discussionId?: string };
      if (!res.ok) throw new Error(data.error ?? "Could not join that discussion");
      router.push(`/room/${data.discussionId}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not join that discussion");
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-xl px-5 py-10">
      <header className="mb-8 flex items-center justify-between">
        <Link href="/" className="flex items-center gap-2">
          <span className="grid h-9 w-9 place-items-center rounded-lg bg-accent text-lg font-bold text-[#06170f]">
            Q
          </span>
          <span className="text-lg font-semibold tracking-tight">Quorum</span>
        </Link>
        {!signedIn && (
          <Link href="/login" className="text-sm text-muted hover:text-ink">
            Sign in
          </Link>
        )}
      </header>

      <h1 className="mb-2 text-2xl font-semibold tracking-tight">Join a group discussion</h1>
      <p className="mb-6 text-sm text-muted">
        Enter the 6-character code your host shared, or open the invite link directly.
      </p>

      <form
        className="card flex flex-col gap-3 sm:flex-row sm:items-end"
        onSubmit={(event) => {
          event.preventDefault();
          void lookup(code);
        }}
      >
        <div className="flex-1">
          <label className="label" htmlFor="code">
            Join code
          </label>
          <input
            id="code"
            className="field font-mono uppercase tracking-[0.3em]"
            placeholder="K7QM2P"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            maxLength={12}
            required
          />
        </div>
        <button type="submit" className="btn-ghost" disabled={busy}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : "Find"}
        </button>
      </form>

      {error && (
        <p className="mt-4 rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">
          {error}
        </p>
      )}

      {preview && (
        <div className="card mt-6">
          <div className="mb-3 flex items-start justify-between gap-3">
            <h2 className="font-medium text-ink">{preview.title}</h2>
            <span className="pill">{preview.status}</span>
          </div>
          <p className="text-sm text-muted">{preview.topic}</p>
          {preview.context && (
            <p className="mt-2 text-sm leading-relaxed text-muted">{preview.context}</p>
          )}

          <div className="mt-4 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
            <span className="flex items-center gap-1">
              <Users2 className="h-3.5 w-3.5" /> {preview.participantCount}/{preview.maxParticipants}
            </span>
            <span className="flex items-center gap-1">
              <Clock className="h-3.5 w-3.5" /> {preview.durationMin} minutes
            </span>
            <span>Host: {preview.hostName}</span>
          </div>

          {preview.rules && (
            <details className="mt-4 text-sm text-muted">
              <summary className="cursor-pointer text-ink">Rules</summary>
              <p className="mt-2 whitespace-pre-line leading-relaxed">{preview.rules}</p>
            </details>
          )}

          <button
            type="button"
            onClick={join}
            className="btn-primary mt-5 w-full"
            disabled={busy || (!preview.allowNewJoiners && preview.status !== "LIVE")}
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Radio className="h-4 w-4" />}
            {!preview.allowNewJoiners && preview.status !== "LIVE"
              ? "Joining is closed"
              : signedIn
                ? "Join discussion"
                : "Sign in and join"}
          </button>
        </div>
      )}
    </div>
  );
}
