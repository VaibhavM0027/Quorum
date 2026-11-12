import { prisma } from "@/lib/prisma";
import { requireSession } from "@/lib/auth";
import { loadDiscussionReport } from "@/lib/reports";
import { renderIndividualReport, renderOverallReport } from "@/lib/pdf";
import { fail, handleRouteError } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string; kind: string }> };

/** Makes a filesystem-safe fragment for a download filename. */
function slug(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "report"
  );
}

/**
 * Downloads a discussion report as a PDF.
 *
 * `kind` is either `overall` (the whole room) or `individual` (one participant,
 * identified by `?participantId=`). Access is resolved through the shared report
 * model, so a participant can only ever download a report they are allowed to
 * read — visibility is never re-implemented here.
 */
export async function GET(request: Request, { params }: Params) {
  try {
    const user = await requireSession();
    const { id, kind } = await params;

    if (kind !== "overall" && kind !== "individual") {
      return fail("Unknown report type. Use `overall` or `individual`.", 404);
    }

    const report = await loadDiscussionReport(id, user.id);
    if (!report) return fail("Discussion not found, or you do not have access to it.", 404);

    let bytes: Buffer;
    let filename: string;
    let participantId: string | null = null;

    if (kind === "overall") {
      bytes = await renderOverallReport(report);
      filename = `quorum-${slug(report.discussion.title)}-overall-report.pdf`;
    } else {
      const participantIdParam = new URL(request.url).searchParams.get("participantId");
      if (!participantIdParam) return fail("`participantId` is required for an individual report.", 400);

      const participant = report.participants.find((p) => p.participantId === participantIdParam);
      if (!participant) {
        return fail("That participant's report is not available to you.", 404);
      }

      participantId = participant.participantId;
      bytes = await renderIndividualReport(report, participant);
      filename = `quorum-${slug(report.discussion.title)}-${slug(participant.name)}-report.pdf`;
    }

    // Record the download so the dashboard can show which reports exist.
    const existing = await prisma.report.findFirst({
      where: { discussionId: id, kind: kind === "overall" ? "OVERALL" : "INDIVIDUAL", participantId },
      select: { id: true },
    });
    if (existing) {
      await prisma.report.update({
        where: { id: existing.id },
        data: { lastDownloadedAt: new Date() },
      });
    } else {
      await prisma.report.create({
        data: {
          discussionId: id,
          kind: kind === "overall" ? "OVERALL" : "INDIVIDUAL",
          participantId,
          lastDownloadedAt: new Date(),
        },
      });
    }

    return new Response(new Uint8Array(bytes), {
      status: 200,
      headers: {
        "content-type": "application/pdf",
        "content-disposition": `attachment; filename="${filename}"`,
        "content-length": String(bytes.byteLength),
        "cache-control": "no-store",
      },
    });
  } catch (error) {
    return handleRouteError(error);
  }
}
