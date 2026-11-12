import { prisma } from "@/lib/prisma";
import { env } from "@/lib/env";
import { handleRouteError, ok } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Tells the sign-in page whether the deployment has been bootstrapped yet, so
 * it can offer a one-click "create demo accounts" action on a fresh install.
 */
export async function GET() {
  try {
    const userCount = await prisma.user.count();
    return ok({
      hasUsers: userCount > 0,
      userCount,
      canBootstrap: userCount === 0,
      demoAccounts: {
        host: env.seed.hostEmail,
        participant: env.seed.participantEmail,
      },
      aiEnabled: env.aiEnabled,
      smtpConfigured: env.smtpConfigured,
    });
  } catch (error) {
    return handleRouteError(error);
  }
}
