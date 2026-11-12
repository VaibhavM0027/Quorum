"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  Loader2,
  Plus,
  LogOut,
  Copy,
  Check,
  Play,
  Square,
  ExternalLink,
  CalendarClock,
  Radio,
  Users2,
} from "lucide-react";

export type DashboardUser = { id: string; name: string; email: string; role: "HOST" | "PARTICIPANT" };

export type DiscussionCard = {
  id: string;
  title: string;
  topic: string;
  status: "SCHEDULED" | "LIVE" | "COMPLETED" | "CANCELLED";
  mode: string;
  joinCode: string;
  inviteUrl: string;
  scheduledAt: string;
  durationMin: number;
  participantCount: number;
  segmentCount: number;
  evaluationCount: number;
  hostName: string;
  isHost: boolean;
};

const STATUS_STYLES: Record<DiscussionCard["status"], string> = {
  SCHEDULED: "border-accent-2/40 text-accent-2",
  LIVE: "border-accent/50 text-accent",
  COMPLETED: "border-line text-muted",
  CANCELLED: "border-danger/40 text-danger",
};

export default function DashboardClient({
  user,
  discussions,
}: {
  user: DashboardUser;
  discussions: DiscussionCard[];
}) {
  const router = useRouter();
  const [showForm, setShowForm] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [joinCode, setJoinCode] = useState("");
  const [joining, setJoining] = useState(false);

  async function signOut() {
    await fetch("/api/auth/logout", { method: "POST" });
    router.replace("/login");
    router.refresh();
  }

  async function copyInvite(discussion: DiscussionCard) {
    try {
      await navigator.clipboard.writeText(discussion.inviteUrl);
      setCopied(discussion.id);
      setTimeout(() => setCopied(null), 1800);
    } catch {
      setError("Could not copy to the clipboard. Copy the code manually instead.");
    }
  }

  async function control(discussion: DiscussionCard, action: "start" | "end") {
    setBusyId(discussion.id);
    setError(null);
    try {
      const res = await fetch(`/api/discussions/${discussion.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(data.error ?? "Could not update the discussion");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not update the discussion");
    } finally {
      setBusyId(null);
    }
  }

  async function joinByCode(event: React.FormEvent) {
    event.preventDefault();
    setJoining(true);
    setError(null);
    try {
      const res = await fetch("/api/discussions/join", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: joinCode }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string; discussionId?: string };
      if (!res.ok) throw new Error(data.error ?? "Could not join that discussion");
      router.push(`/room/${data.discussionId}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not join that discussion");
      setJoining(false);
    }
  }

  return (
    <div className="mx-auto max-w-5xl px-5 py-8">
      <header className="mb-8 flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <span className="grid h-9 w-9 place-items-center rounded-lg bg-accent text-lg font-bold text-[#06170f]">
            Q
          </span>
          <div>
            <p className="font-semibold leading-tight">{user.name}</p>
            <p className="text-xs text-muted">
              {user.role === "HOST" ? "Host account" : "Participant account"} · {user.email}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Link href="/" className="btn-ghost">
            Home
          </Link>
          <button type="button" onClick={signOut} className="btn-ghost">
            <LogOut className="h-4 w-4" /> Sign out
          </button>
        </div>
      </header>

      {error && (
        <p className="mb-5 rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">
          {error}
        </p>
      )}

      {user.role === "HOST" ? (
        <section className="mb-8">
          <div className="mb-4 flex items-center justify-between">
            <h1 className="text-xl font-semibold tracking-tight">Your discussions</h1>
            <button
              type="button"
              className="btn-primary"
              onClick={() => setShowForm((value) => !value)}
            >
              <Plus className="h-4 w-4" /> New discussion
            </button>
          </div>
          {showForm && (
            <CreateDiscussionForm
              onCreated={(id) => {
                setShowForm(false);
                router.refresh();
                void id;
              }}
              onError={setError}
            />
          )}
        </section>
      ) : (
        <section className="mb-8">
          <h1 className="mb-4 text-xl font-semibold tracking-tight">Join a discussion</h1>
          <form onSubmit={joinByCode} className="card flex flex-col gap-3 sm:flex-row sm:items-end">
            <div className="flex-1">
              <label className="label" htmlFor="join-code">
                Join code
              </label>
              <input
                id="join-code"
                className="field font-mono uppercase tracking-widest"
                placeholder="K7QM2P"
                value={joinCode}
                onChange={(e) => setJoinCode(e.target.value)}
                maxLength={12}
                required
              />
            </div>
            <button type="submit" className="btn-primary" disabled={joining}>
              {joining ? <Loader2 className="h-4 w-4 animate-spin" /> : <Radio className="h-4 w-4" />}
              Join
            </button>
          </form>
        </section>
      )}

      <section>
        {user.role === "HOST" && (
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted">
            Scheduled and past sessions
          </h2>
        )}
        {discussions.length === 0 ? (
          <p className="card text-sm text-muted">
            {user.role === "HOST"
              ? "No discussions yet. Create your first one to get a join code and invite link."
              : "You have not joined any discussions yet."}
          </p>
        ) : (
          <ul className="grid gap-4 md:grid-cols-2">
            {discussions.map((discussion) => (
              <li key={discussion.id} className="card flex flex-col gap-3">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <h3 className="font-medium leading-tight text-ink">{discussion.title}</h3>
                    <p className="mt-1 line-clamp-2 text-sm text-muted">{discussion.topic}</p>
                  </div>
                  <span className={`pill shrink-0 ${STATUS_STYLES[discussion.status]}`}>
                    {discussion.status === "LIVE" && <span className="h-1.5 w-1.5 rounded-full bg-accent" />}
                    {discussion.status}
                  </span>
                </div>

                <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
                  <span className="flex items-center gap-1">
                    <Users2 className="h-3.5 w-3.5" /> {discussion.participantCount} participants
                  </span>
                  <span className="flex items-center gap-1">
                    <CalendarClock className="h-3.5 w-3.5" />
                    {new Date(discussion.scheduledAt).toLocaleString()} · {discussion.durationMin} min
                  </span>
                  {!discussion.isHost && <span>Host: {discussion.hostName}</span>}
                </div>

                <div className="flex items-center gap-2 rounded-lg border border-line bg-panel-2 px-3 py-2">
                  <span className="text-xs text-muted">Code</span>
                  <span className="font-mono text-sm tracking-[0.2em] text-ink">{discussion.joinCode}</span>
                  <button
                    type="button"
                    onClick={() => copyInvite(discussion)}
                    className="ml-auto text-muted transition hover:text-ink"
                    title="Copy invite link"
                  >
                    {copied === discussion.id ? (
                      <Check className="h-4 w-4 text-accent" />
                    ) : (
                      <Copy className="h-4 w-4" />
                    )}
                  </button>
                </div>

                <div className="mt-auto flex flex-wrap gap-2">
                  <Link href={`/room/${discussion.id}`} className="btn-ghost">
                    <ExternalLink className="h-4 w-4" /> Open room
                  </Link>
                  {discussion.isHost && discussion.status === "SCHEDULED" && (
                    <button
                      type="button"
                      className="btn-primary"
                      onClick={() => control(discussion, "start")}
                      disabled={busyId === discussion.id}
                    >
                      {busyId === discussion.id ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <Play className="h-4 w-4" />
                      )}
                      Start
                    </button>
                  )}
                  {discussion.isHost && discussion.status === "LIVE" && (
                    <button
                      type="button"
                      className="btn-danger"
                      onClick={() => control(discussion, "end")}
                      disabled={busyId === discussion.id}
                    >
                      {busyId === discussion.id ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <Square className="h-4 w-4" />
                      )}
                      End
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function CreateDiscussionForm({
  onCreated,
  onError,
}: {
  onCreated: (id: string) => void;
  onError: (message: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({
    title: "",
    topic: "",
    context: "",
    rules: "Everyone gets an equal chance to speak. Keep to the topic. Be respectful.",
    durationMin: 30,
    maxParticipants: 8,
    mode: "AI_MODERATED" as "AI_MODERATED" | "FREE_FLOW",
    silencePromptSec: 30,
  });

  function update<K extends keyof typeof form>(key: K, value: (typeof form)[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      const res = await fetch("/api/discussions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...form, aiEnabled: true, transcriptionEnabled: true }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        error?: string;
        discussion?: { id: string };
      };
      if (!res.ok) throw new Error(data.error ?? "Could not create the discussion");
      onCreated(data.discussion!.id);
    } catch (err) {
      onError(err instanceof Error ? err.message : "Could not create the discussion");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="card mb-6 space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="sm:col-span-2">
          <label className="label" htmlFor="title">
            Title
          </label>
          <input
            id="title"
            className="field"
            value={form.title}
            onChange={(e) => update("title", e.target.value)}
            placeholder="Morning GD — Campus Placement Round"
            required
            minLength={3}
            maxLength={120}
          />
        </div>

        <div className="sm:col-span-2">
          <label className="label" htmlFor="topic">
            Topic
          </label>
          <input
            id="topic"
            className="field"
            value={form.topic}
            onChange={(e) => update("topic", e.target.value)}
            placeholder="Is remote work better for early-career employees?"
            required
            minLength={5}
            maxLength={300}
          />
        </div>

        <div className="sm:col-span-2">
          <label className="label" htmlFor="context">
            Background context (optional)
          </label>
          <textarea
            id="context"
            className="field min-h-[70px]"
            value={form.context}
            onChange={(e) => update("context", e.target.value)}
            placeholder="Any facts, definitions or reading the group should keep in mind."
            maxLength={4000}
          />
        </div>

        <div className="sm:col-span-2">
          <label className="label" htmlFor="rules">
            Rules
          </label>
          <textarea
            id="rules"
            className="field min-h-[70px]"
            value={form.rules}
            onChange={(e) => update("rules", e.target.value)}
            maxLength={4000}
          />
        </div>

        <div>
          <label className="label" htmlFor="durationMin">
            Duration (minutes)
          </label>
          <input
            id="durationMin"
            type="number"
            className="field"
            min={5}
            max={180}
            value={form.durationMin}
            onChange={(e) => update("durationMin", Number(e.target.value))}
          />
        </div>

        <div>
          <label className="label" htmlFor="maxParticipants">
            Max participants
          </label>
          <input
            id="maxParticipants"
            type="number"
            className="field"
            min={2}
            max={30}
            value={form.maxParticipants}
            onChange={(e) => update("maxParticipants", Number(e.target.value))}
          />
        </div>

        <div>
          <label className="label" htmlFor="mode">
            Mode
          </label>
          <select
            id="mode"
            className="field"
            value={form.mode}
            onChange={(e) => update("mode", e.target.value as typeof form.mode)}
          >
            <option value="AI_MODERATED">AI moderated</option>
            <option value="FREE_FLOW">Free flow</option>
          </select>
        </div>

        <div>
          <label className="label" htmlFor="silencePromptSec">
            Silence prompt after (seconds)
          </label>
          <input
            id="silencePromptSec"
            type="number"
            className="field"
            min={10}
            max={300}
            value={form.silencePromptSec}
            onChange={(e) => update("silencePromptSec", Number(e.target.value))}
          />
        </div>
      </div>

      <button type="submit" className="btn-primary" disabled={busy}>
        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
        Create discussion
      </button>
    </form>
  );
}
