import { prisma } from "@/lib/prisma";
import { requireSession } from "@/lib/auth";
import { fail, handleRouteError, ok, readJson } from "@/lib/http";
import { consentSchema } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

/**
 * Records a participant's explicit consent (or refusal) to be transcribed.
 * Transcription only runs for members who have opted in, and consent can be
 * withdrawn at any time.
 */
export async function POST(request: Request, { params }: Params) {
  try {
    const user = await requireSession();
    const { id } = await params;
    const { consent } = consentSchema.parse(await readJson(request));

    const discussion = await prisma.discussion.findUnique({
      where: { id },
      select: { id: true, status: true, transcriptionEnabled: true },
    });
    if (!discussion) return fail("Discussion not found.", 404);
    if (!discussion.transcriptionEnabled) {
      return fail("Transcription is disabled for this discussion.", 409);
    }
    if (discussion.status === "CANCELLED") {
      return fail("This discussion was cancelled.", 409);
    }

    const member = await prisma.discussionParticipant.findUnique({
      where: { discussionId_userId: { discussionId: id, userId: user.id } },
      select: { id: true, removed: true },
    });
    if (!member) return fail("Join the discussion before recording consent.", 403);
    if (member.removed) return fail("You were removed from this discussion.", 403);

    const updated = await prisma.discussionParticipant.update({
      where: { id: member.id },
      data: { transcriptionConsent: consent, consentAt: new Date() },
      select: { transcriptionConsent: true, consentAt: true },
    });

    return ok({
      transcriptionConsent: updated.transcriptionConsent,
      consentAt: updated.consentAt?.toISOString() ?? null,
    });
  } catch (error) {
    return handleRouteError(error);
  }
}
