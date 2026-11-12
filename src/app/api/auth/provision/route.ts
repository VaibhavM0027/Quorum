import { prisma } from "@/lib/prisma";
import { createSessionToken, hashPassword, setSessionCookie } from "@/lib/auth";
import { env } from "@/lib/env";
import { fail, handleRouteError, ok, readJson } from "@/lib/http";
import { checkRateLimit, clientKey } from "@/lib/rate-limit";
import { provisionSchema } from "@/lib/validation";

export const runtime = "nodejs";

/**
 * First-run bootstrap: creates one host and one participant account.
 *
 * Only works while the database has no users, so it cannot be used to add
 * accounts to a live deployment. After that, use /api/auth/register or sign in.
 */
export async function POST(request: Request) {
  try {
    const limit = checkRateLimit(`provision:${clientKey(request)}`, 5, 60_000);
    if (!limit.allowed) return fail("Too many attempts. Please wait a minute.", 429);

    const { password } = provisionSchema.parse(await readJson(request));

    const userCount = await prisma.user.count();
    if (userCount > 0) {
      return fail("Accounts already exist. Please sign in or register instead.", 409);
    }

    const passwordHash = await hashPassword(password);

    const [host, participant] = await prisma.$transaction([
      prisma.user.create({
        data: {
          email: env.seed.hostEmail,
          name: env.seed.hostName,
          role: "HOST",
          passwordHash,
        },
        select: { id: true, email: true, name: true, role: true },
      }),
      prisma.user.create({
        data: {
          email: env.seed.participantEmail,
          name: env.seed.participantName,
          role: "PARTICIPANT",
          passwordHash,
        },
        select: { id: true, email: true, name: true, role: true },
      }),
    ]);

    await setSessionCookie(await createSessionToken(host));

    return ok({ host, participant }, 201);
  } catch (error) {
    return handleRouteError(error);
  }
}
