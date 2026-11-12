import { prisma } from "@/lib/prisma";
import { createSessionToken, setSessionCookie, verifyPassword } from "@/lib/auth";
import { checkRateLimit, clientKey } from "@/lib/rate-limit";
import { fail, handleRouteError, ok, readJson } from "@/lib/http";
import { loginSchema } from "@/lib/validation";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const limit = checkRateLimit(`login:${clientKey(request)}`, 10, 60_000);
    if (!limit.allowed) {
      return fail("Too many sign-in attempts. Please wait a minute and try again.", 429);
    }

    const body = loginSchema.parse(await readJson(request));

    const user = await prisma.user.findUnique({ where: { email: body.email } });
    // Always compare against a hash so a missing account and a wrong password
    // take a similar amount of time (avoids user enumeration by timing).
    const passwordOk = user
      ? await verifyPassword(body.password, user.passwordHash)
      : await verifyPassword(body.password, "$2a$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidinv");

    if (!user || !passwordOk) {
      return fail("Incorrect email or password.", 401);
    }

    const session = { id: user.id, email: user.email, name: user.name, role: user.role };
    await setSessionCookie(await createSessionToken(session));

    return ok({ user: session });
  } catch (error) {
    return handleRouteError(error);
  }
}
