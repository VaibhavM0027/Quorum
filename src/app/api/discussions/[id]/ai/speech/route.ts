import { prisma } from "@/lib/prisma";
import { requireSession } from "@/lib/auth";
import { checkRateLimit } from "@/lib/rate-limit";
import { fail, handleRouteError, ok, readJson } from "@/lib/http";
import { aiSpeechReceiptSchema } from "@/lib/validation";
import { recordAiSpeechReceipt } from "@/lib/turns";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

/** Records this browser's completion of one AI voice event. */
export async function POST(request: Request, { params }: Params) {
  try {
    const user = await requireSession();
    const { id } = await params;
    const body = aiSpeechReceiptSchema.parse(await readJson(request));
    const limit = checkRateLimit(`ai-speech:${id}:${user.id}`, 60, 60_000);
    if (!limit.allowed) return fail("Too many AI playback updates.", 429);

    const member = await prisma.discussionParticipant.findUnique({
      where: { discussionId_userId: { discussionId: id, userId: user.id } },
      select: { id: true, removed: true, leftAt: true },
    });
    if (!member || member.removed || member.leftAt) {
      return fail("Join the discussion before reporting AI playback.", 403);
    }

    await recordAiSpeechReceipt({
      discussionId: id,
      participantId: member.id,
      userId: user.id,
      eventId: body.eventId,
      status: body.status,
    });
    return ok({ recorded: true });
  } catch (error) {
    return handleRouteError(error);
  }
}
