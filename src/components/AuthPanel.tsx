"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, LogIn, UserPlus, Sparkles } from "lucide-react";

type Mode = "login" | "register";

type Status = {
  hasUsers: boolean;
  canBootstrap: boolean;
  demoAccounts: { host: string; participant: string };
  aiEnabled: boolean;
};

export default function AuthPanel({ nextPath }: { nextPath: string }) {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>("login");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<"HOST" | "PARTICIPANT">("HOST");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [status, setStatus] = useState<Status | null>(null);
  const [seedPassword, setSeedPassword] = useState("");
  const [bootstrapping, setBootstrapping] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/auth/status")
      .then((res) => res.json())
      .then((data: Status) => {
        if (!cancelled) setStatus(data);
      })
      .catch(() => {
        /* status is a convenience only — ignore failures */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  function finish() {
    router.replace(nextPath);
    router.refresh();
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const endpoint = mode === "login" ? "/api/auth/login" : "/api/auth/register";
      const payload =
        mode === "login" ? { email, password } : { name, email, password, role };

      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(data.error ?? "Something went wrong");

      finish();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
      setBusy(false);
    }
  }

  async function bootstrap(event: React.FormEvent) {
    event.preventDefault();
    setBootstrapping(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/provision", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: seedPassword }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(data.error ?? "Could not create demo accounts");
      finish();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create demo accounts");
      setBootstrapping(false);
    }
  }

  return (
    <div className="card w-full max-w-md">
      <div className="mb-5 grid grid-cols-2 gap-1 rounded-lg border border-line p-1">
        {(["login", "register"] as const).map((value) => (
          <button
            key={value}
            type="button"
            onClick={() => {
              setMode(value);
              setError(null);
            }}
            className={`rounded-md px-3 py-2 text-sm font-medium transition ${
              mode === value ? "bg-accent text-[#06170f]" : "text-muted hover:text-ink"
            }`}
          >
            {value === "login" ? "Sign in" : "Create account"}
          </button>
        ))}
      </div>

      <form onSubmit={submit} className="space-y-4">
        {mode === "register" && (
          <div>
            <label className="label" htmlFor="name">
              Full name
            </label>
            <input
              id="name"
              className="field"
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoComplete="name"
              required
              maxLength={80}
            />
          </div>
        )}

        <div>
          <label className="label" htmlFor="email">
            Email
          </label>
          <input
            id="email"
            type="email"
            className="field"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="email"
            required
          />
        </div>

        <div>
          <label className="label" htmlFor="password">
            Password
          </label>
          <input
            id="password"
            type="password"
            className="field"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete={mode === "login" ? "current-password" : "new-password"}
            minLength={mode === "register" ? 8 : undefined}
            required
          />
          {mode === "register" && (
            <p className="mt-1 text-xs text-muted">At least 8 characters.</p>
          )}
        </div>

        {mode === "register" && (
          <fieldset>
            <legend className="label">I am joining as</legend>
            <div className="grid grid-cols-2 gap-2">
              {(
                [
                  { value: "HOST", title: "Host", body: "Create and run discussions" },
                  { value: "PARTICIPANT", title: "Participant", body: "Join with a code" },
                ] as const
              ).map((option) => (
                <label
                  key={option.value}
                  className={`cursor-pointer rounded-lg border p-3 text-sm transition ${
                    role === option.value
                      ? "border-accent bg-panel-2"
                      : "border-line hover:bg-panel-2"
                  }`}
                >
                  <input
                    type="radio"
                    name="role"
                    value={option.value}
                    checked={role === option.value}
                    onChange={() => setRole(option.value)}
                    className="sr-only"
                  />
                  <span className="block font-medium text-ink">{option.title}</span>
                  <span className="block text-xs text-muted">{option.body}</span>
                </label>
              ))}
            </div>
          </fieldset>
        )}

        {error && (
          <p className="rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">
            {error}
          </p>
        )}

        <button type="submit" className="btn-primary w-full" disabled={busy}>
          {busy ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : mode === "login" ? (
            <LogIn className="h-4 w-4" />
          ) : (
            <UserPlus className="h-4 w-4" />
          )}
          {mode === "login" ? "Sign in" : "Create account"}
        </button>
      </form>

      {status?.canBootstrap && (
        <div className="mt-6 border-t border-line pt-5">
          <h2 className="flex items-center gap-2 text-sm font-medium text-ink">
            <Sparkles className="h-4 w-4 text-accent" /> First run: create demo accounts
          </h2>
          <p className="mt-1 text-xs leading-relaxed text-muted">
            Creates a host (<code className="text-ink">{status.demoAccounts.host}</code>) and a
            participant (<code className="text-ink">{status.demoAccounts.participant}</code>) with the
            password you choose. This only works while the database is empty.
          </p>
          <form onSubmit={bootstrap} className="mt-3 flex gap-2">
            <input
              type="password"
              className="field"
              placeholder="Choose a password (min 8 chars)"
              value={seedPassword}
              onChange={(e) => setSeedPassword(e.target.value)}
              minLength={8}
              required
            />
            <button type="submit" className="btn-ghost shrink-0" disabled={bootstrapping}>
              {bootstrapping ? <Loader2 className="h-4 w-4 animate-spin" /> : "Create"}
            </button>
          </form>
        </div>
      )}
    </div>
  );
}
