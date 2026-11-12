import { clearSessionCookie } from "@/lib/auth";
import { handleRouteError, ok } from "@/lib/http";

export const runtime = "nodejs";

export async function POST() {
  try {
    await clearSessionCookie();
    return ok({ signedOut: true });
  } catch (error) {
    return handleRouteError(error);
  }
}
