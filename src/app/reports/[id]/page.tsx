import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import {
  ArrowLeft,
  Download,
  FileText,
  Gauge,
  MessageSquareQuote,
  Mic,
  Users2,
  AlertTriangle,
} from "lucide-react";
import { getSession } from "@/lib/auth";
import { loadDiscussionReport, needsMoreEvidence, orderedDimensions } from "@/lib/reports";
import { formatBytes } from "@/lib/recordings";
import { scoreBand } from "@/lib/rubric";
import ReportCharts from "@/components/ReportCharts";
import RunEvaluationButton from "@/components/RunEvaluationButton";
import ThemeToggle from "@/components/ThemeToggle";

export const dynamic = "force-dynamic";

function formatDuration(ms: number): string {
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m ${String(seconds).padStart(2, "0")}s` : `${seconds}s`;
}

function toneClass(score: number | null): string {
  if (score === null) return "text-muted";
  const tone = scoreBand(score).tone;
  return tone === "good" ? "text-accent" : tone === "ok" ? "text-warn" : "text-danger";
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="card">
      <p className="text-xs font-medium uppercase tracking-wide text-muted">{label}</p>
      <p className="mt-1 text-2xl font-semibold">{value}</p>
      {hint && <p className="mt-1 text-xs text-muted">{hint}</p>}
    </div>
  );
}

export default async function ReportsPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await getSession();
  const { id } = await params;
  if (!user) redirect(`/login?next=/reports/${id}`);

  const report = await loadDiscussionReport(id, user.id);
  if (!report) notFound();

  const aggregate = report.aggregate;
  const assessed = report.participants.filter((participant) => !needsMoreEvidence(participant));

  return (
    <main className="mx-auto flex max-w-5xl flex-col gap-5 px-5 py-6">
      <header className="flex flex-wrap items-center gap-3">
        <Link href="/dashboard" className="btn-ghost">
          <ArrowLeft className="h-4 w-4" /> Dashboard
        </Link>
        <div className="min-w-0">
          <h1 className="truncate text-lg font-medium leading-tight">{report.discussion.title}</h1>
          <p className="truncate text-xs text-muted">
            {report.discussion.topic} · Host {report.discussion.hostName} · {report.discussion.status}
          </p>
        </div>
        <ThemeToggle />
        <a
          href={`/api/discussions/${report.discussion.id}/transcript?format=csv`}
          className="btn-ghost ml-auto"
        >
          <FileText className="h-4 w-4" /> Transcript CSV
        </a>
        <a
          href={`/api/discussions/${report.discussion.id}/reports/overall`}
          className="btn-primary"
        >
          <Download className="h-4 w-4" /> Overall PDF
        </a>
      </header>

      {!report.viewer.seesEveryone && (
        <p className="pill w-fit">
          <FileText className="h-3.5 w-3.5" /> You are seeing your own report only
        </p>
      )}

      {aggregate.evaluatedCount === 0 && (
        <div className="card border-warn/40">
          <h2 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-warn">
            <AlertTriangle className="h-4 w-4" /> No scored evaluations yet
          </h2>
          <p className="mt-2 text-sm text-muted">
            {aggregate.totalContributions === 0
              ? "No speech was transcribed during this discussion, so there is nothing to assess. Reports need a transcript."
              : "The transcript exists but no participant has been assessed yet. Run the evaluation to score contributions against the rubric."}
          </p>
          {report.viewer.isHost && (
            <div className="mt-3">
              <RunEvaluationButton discussionId={report.discussion.id} />
            </div>
          )}
        </div>
      )}

      <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat
          label="Average score"
          value={aggregate.averageOverall !== null ? `${aggregate.averageOverall.toFixed(1)}` : "—"}
          hint={`${aggregate.evaluatedCount} of ${aggregate.participantCount} participants assessed`}
        />
        <Stat
          label="Balance"
          value={aggregate.fairnessIndex !== null ? `${aggregate.fairnessIndex.toFixed(0)}` : "—"}
          hint="100 = everyone spoke an equal share"
        />
        <Stat
          label="Talking time"
          value={formatDuration(aggregate.totalSpeakingMs)}
          hint={`${aggregate.totalContributions} contributions · ${aggregate.totalWords} words`}
        />
        <Stat
          label="On-topic speech"
          value={String(aggregate.relevanceMix.highly + aggregate.relevanceMix.relevant)}
          hint={`${aggregate.relevanceMix.partial} partial · ${aggregate.relevanceMix.irrelevant} off-topic`}
        />
      </section>

      {aggregate.evaluatedCount > 0 && (
        <ReportCharts title="Rubric averages across the room" data={aggregate.dimensionAverages} />
      )}

      {aggregate.evaluatedCount > 0 && (
        <ReportCharts
          title="Overall score by participant"
          data={report.participants
            .filter((participant) => participant.overallScore !== null)
            .map((participant) => ({ label: participant.name, score: participant.overallScore ?? 0 }))}
        />
      )}

      <section className="flex flex-col gap-4">
        <h2 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-muted">
          <Users2 className="h-4 w-4" /> Participant reports
        </h2>

        {report.participants.length === 0 && (
          <p className="card text-sm text-muted">No participant reports are available to you.</p>
        )}

        {report.participants.map((participant) => {
          const dimensions = orderedDimensions(participant);
          const scored = !needsMoreEvidence(participant);
          return (
            <article key={participant.participantId} className="card">
              <div className="flex flex-wrap items-center gap-3">
                <div className="min-w-0">
                  <h3 className="truncate font-medium">
                    {participant.name}
                    {participant.isHost && <span className="ml-2 text-xs text-muted">host</span>}
                    {participant.removed && <span className="ml-2 text-xs text-danger">removed</span>}
                  </h3>
                  <p className="text-xs text-muted">
                    {formatDuration(participant.speakingMs)} · {participant.participationPct.toFixed(1)}%
                    of talking time · {participant.contributions} contributions ·{" "}
                    {participant.wordCount} words
                  </p>
                </div>

                <div className="ml-auto flex items-center gap-3">
                  <div className="text-right">
                    <p className={`text-2xl font-semibold ${toneClass(participant.overallScore)}`}>
                      {participant.overallScore !== null ? participant.overallScore.toFixed(1) : "—"}
                    </p>
                    <p className="text-xs text-muted">
                      {participant.band?.label ?? (scored ? "" : "not assessed")}
                    </p>
                  </div>
                  <a
                    className="btn-ghost"
                    href={`/api/discussions/${report.discussion.id}/reports/individual?participantId=${participant.participantId}`}
                  >
                    <Download className="h-4 w-4" /> PDF
                  </a>
                </div>
              </div>

              {!scored && (
                <p className="mt-3 flex items-start gap-2 rounded-lg border border-warn/40 bg-warn/10 px-3 py-2 text-sm text-warn">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                  <span>
                    No score was awarded.{" "}
                    {participant.incompleteReason ??
                      "There was not enough spoken content to assess this participant reliably."}
                  </span>
                </p>
              )}

              {scored && (
                <ul className="mt-4 space-y-2">
                  {dimensions.map((dimension) => (
                    <li key={dimension.key}>
                      <div className="flex items-center gap-2 text-sm">
                        <span>{dimension.label}</span>
                        <span className="text-xs text-muted">{dimension.weight}%</span>
                        <span className={`ml-auto font-medium ${toneClass(dimension.score)}`}>
                          {dimension.score.toFixed(0)}
                        </span>
                      </div>
                      <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-input">
                        <div
                          className={`h-full rounded-full ${
                            scoreBand(dimension.score).tone === "good"
                              ? "bg-accent"
                              : scoreBand(dimension.score).tone === "ok"
                                ? "bg-warn"
                                : "bg-danger"
                          }`}
                          style={{ width: `${Math.max(2, Math.min(100, dimension.score))}%` }}
                        />
                      </div>
                      {dimension.rationale && (
                        <p className="mt-1 text-xs text-muted">{dimension.rationale}</p>
                      )}
                    </li>
                  ))}
                </ul>
              )}

              {participant.summary && (
                <p className="mt-4 text-sm leading-relaxed text-ink">{participant.summary}</p>
              )}

              <div className="mt-4 grid gap-4 sm:grid-cols-2">
                {participant.notes.strengths.length > 0 && (
                  <div>
                    <h4 className="text-xs font-semibold uppercase tracking-wide text-accent">
                      Strengths
                    </h4>
                    <ul className="mt-1 space-y-1 text-sm text-muted">
                      {participant.notes.strengths.map((item) => (
                        <li key={item}>• {item}</li>
                      ))}
                    </ul>
                  </div>
                )}
                {participant.notes.improvements.length > 0 && (
                  <div>
                    <h4 className="text-xs font-semibold uppercase tracking-wide text-warn">
                      Areas to improve
                    </h4>
                    <ul className="mt-1 space-y-1 text-sm text-muted">
                      {participant.notes.improvements.map((item) => (
                        <li key={item}>• {item}</li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>

              {participant.notes.evidence.length > 0 && (
                <div className="mt-4">
                  <h4 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted">
                    <MessageSquareQuote className="h-3.5 w-3.5" /> Evidence
                  </h4>
                  <ul className="mt-1 space-y-1 text-sm italic text-muted">
                    {participant.notes.evidence.map((quote) => (
                      <li key={quote}>&ldquo;{quote}&rdquo;</li>
                    ))}
                  </ul>
                </div>
              )}
            </article>
          );
        })}
      </section>

      {report.recording && (
        <section className="card">
          <h2 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-muted">
            <Mic className="h-4 w-4" /> Session recording
            <span className="ml-auto text-xs font-normal normal-case">
              {formatDuration(report.recording.durationMs)} · {formatBytes(report.recording.byteSize)}
            </span>
          </h2>
          {/* Served from the stored file with range support, so long sessions seek. */}
          <audio className="mt-3 w-full" controls preload="metadata" src={report.recording.url} />
          <p className="mt-2 text-xs text-muted">
            Captured live from the moderator&rsquo;s browser and stored on the server.
          </p>
        </section>
      )}

      {report.transcript.length > 0 && (
        <section className="card">
          <h2 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-muted">
            <Gauge className="h-4 w-4" /> Transcript ({report.transcript.length} lines)
          </h2>
          <ol className="mt-3 max-h-96 space-y-2 overflow-y-auto pr-1">
            {report.transcript.map((line) => (
              <li key={line.id} className="text-sm">
                <span className="mr-2 font-medium text-accent">
                  {line.speaker}
                  {line.speakerIsHost ? " (host)" : ""}
                </span>
                <span className="text-xs text-muted">
                  {line.startedAt.toISOString().slice(11, 19)} UTC ·{" "}
                  {line.relevance.toLowerCase().replace(/_/g, " ")}
                </span>
                <p className="text-ink">{line.text}</p>
              </li>
            ))}
          </ol>
        </section>
      )}

      {assessed.length > 0 && (
        <p className="text-xs text-muted">
          Scores are produced by the AI examiner against a weighted rubric; the overall score is
          computed on the server from the rubric weights. Participants without enough spoken content
          are reported as not assessed rather than being given a score.
        </p>
      )}
    </main>
  );
}
