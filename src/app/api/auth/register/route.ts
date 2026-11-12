import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { createSessionToken, hashPassword, setSessionCookie } from "@/lib/auth";
import { checkRateLimit, clientKey } from "@/lib/rate-limit";
import { fail, handleRouteError, ok, readJson } from "@/lib/http";
import { registerSchema } from "@/lib/validation";

export const runtime = "nodejs";

const bodySchema = registerSchema.extend({
  role: z.enum(["HOST", "PARTICIPANT"]).default("PARTICIPANT"),
});

/**
 * Creates an account and signs the user in.
 * Hosts can create discussions; participants join them with a code.
 */
export async function POST(request: Request) {
  try {
    // Throttle account creation per client to blunt automated sign-up abuse.
    const limit = checkRateLimit(`register:${clientKey(request)}`, 5, 60_000);
    if (!limit.allowed) {
      return fail("Too many accounts created from this address. Please wait a minute.", 429);
    }

    const body = bodySchema.parse(await readJson(request));

    const existing = await prisma.user.findUnique({ where: { email: body.email } });
    if (existing) {
      return fail("An account with that email already exists. Try signing in instead.", 409);
    }

    const user = await prisma.user.create({
      data: {
        email: body.email,
        name: body.name,
        role: body.role,
        passwordHash: await hashPassword(body.password),
      },
      select: { id: true, email: true, name: true, role: true },
    });

    const token = await createSessionToken(user);
    await setSessionCookie(token);

    return ok({ user }, 201);
  } catch (error) {
    return handleRouteError(error);
  }
}
