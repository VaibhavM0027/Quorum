import Link from "next/link";
import {
  Users2,
  Mic,
  Sparkles,
  FileText,
  ShieldCheck,
  Timer,
  AudioLines,
  GaugeCircle,
} from "lucide-react";
import SystemStatus from "@/components/SystemStatus";

const FEATURES = [
  {
    icon: Users2,
    title: "Invite with a link + code",
    body: "Every discussion gets a unique join code and shareable invite link. Participants join from any desktop or mobile browser — no installs.",
  },
  {
    icon: AudioLines,
    title: "Live transcription",
    body: "Each participant's speech is transcribed in the browser and attributed to the correct speaker in real time.",
  },
  {
    icon: Sparkles,
    title: "AI discussion assistant",
    body: "Detects silence, nudges quiet participants, steers the group back to the topic and asks follow-up questions.",
  },
  {
    icon: GaugeCircle,
    title: "Fair evaluation",
    body: "Contributions are scored against a weighted rubric — relevance, communication, knowledge, participation, reasoning and listening.",
  },
  {
    icon: FileText,
    title: "Downloadable PDF reports",
    body: "Individual and overall reports with scores, evidence and improvement notes, generated as soon as the discussion ends.",
  },
  {
    icon: Timer,
    title: "Timed sessions",
    body: "Set a duration, speaking-time budget and participant cap. The host keeps full control of the room.",
  },
];

const STEPS = [
  { n: "01", title: "Host creates a discussion", body: "Topic, context, rules, duration and participant limit." },
  { n: "02", title: "Participants join", body: "They open the invite link or enter the code, then allow mic access." },
  { n: "03", title: "Live GD happens", body: "Audio/video over LiveKit; speech is transcribed and analysed live." },
  { n: "04", title: "Reports are generated", body: "Every participant gets an evaluated PDF; the host gets the overview." },
];

export default function HomePage() {
  return (
    <main className="mx-auto max-w-6xl px-5 py-12">
      <header className="mb-12 flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-2">
          <span className="grid h-9 w-9 place-items-center rounded-lg bg-accent text-lg font-bold text-[#06170f]">
            Q
          </span>
          <span className="text-lg font-semibold tracking-tight">Quorum</span>
        </div>
        <nav className="flex items-center gap-2">
          <Link href="/join" className="btn-ghost">
            Join a GD
          </Link>
          <Link href="/login" className="btn-primary">
            Sign in
          </Link>
        </nav>
      </header>

      <section className="grid gap-10 lg:grid-cols-[1.4fr_1fr] lg:items-start">
        <div>
          <p className="pill mb-4">
            <ShieldCheck className="h-3.5 w-3.5" /> Host-controlled • Consent-based transcription
          </p>
          <h1 className="text-4xl font-semibold leading-tight tracking-tight sm:text-5xl">
            Run online group discussions that evaluate themselves.
          </h1>
          <p className="mt-4 max-w-2xl text-base leading-relaxed text-muted">
            Quorum hosts a live audio/video discussion, transcribes every speaker, keeps the
            conversation on topic with an AI assistant, and turns the result into downloadable
            performance reports — for each participant and for the group as a whole.
          </p>
          <div className="mt-7 flex flex-wrap gap-3">
            <Link href="/login" className="btn-primary">
              <Mic className="h-4 w-4" /> Create a discussion
            </Link>
            <Link href="/join" className="btn-ghost">
              I have an invite code
            </Link>
          </div>
        </div>

        <aside className="card">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted">
            System status
          </h2>
          <SystemStatus />
          <p className="mt-4 border-t border-line pt-3 text-xs leading-relaxed text-muted">
            Missing a service? Add the matching key to <code className="text-ink">.env</code> and
            restart the dev server.
          </p>
        </aside>
      </section>

      <section className="mt-16">
        <h2 className="mb-6 text-2xl font-semibold tracking-tight">What it does</h2>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {FEATURES.map(({ icon: Icon, title, body }) => (
            <article key={title} className="card">
              <Icon className="mb-3 h-5 w-5 text-accent" />
              <h3 className="mb-1 font-medium text-ink">{title}</h3>
              <p className="text-sm leading-relaxed text-muted">{body}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="mt-16">
        <h2 className="mb-6 text-2xl font-semibold tracking-tight">How a session runs</h2>
        <ol className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {STEPS.map((step) => (
            <li key={step.n} className="card">
              <span className="font-mono text-xs text-accent">{step.n}</span>
              <h3 className="mt-2 font-medium text-ink">{step.title}</h3>
              <p className="mt-1 text-sm leading-relaxed text-muted">{step.body}</p>
            </li>
          ))}
        </ol>
      </section>

      <footer className="mt-16 border-t border-line pt-6 text-xs text-muted">
        Quorum · built with Next.js, Prisma, LiveKit and Google Gemini.
      </footer>
    </main>
  );
}
