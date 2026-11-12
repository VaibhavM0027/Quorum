import { getSession } from "@/lib/auth";
import { handleRouteError, ok } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Returns the signed-in user, or `{ user: null }` when there is no session. */
export async function GET() {
  try {
    const user = await getSession();
    return ok({ user });
  } catch (error) {
    return handleRouteError(error);
  }
}
