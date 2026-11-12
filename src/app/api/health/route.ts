import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { env } from "@/lib/env";

export const dynamic = "force-dynamic";

/**
 * Liveness/readiness probe. Reports which subsystems are usable so the UI can
 * tell the user exactly what is missing instead of failing silently.
 */
export async function GET() {
  let database = false;
  let databaseError: string | null = null;

  try {
    await prisma.$queryRaw`SELECT 1`;
    database = true;
  } catch (error) {
    databaseError = error instanceof Error ? error.message : "Unknown database error";
  }

  const body = {
    status: database ? "ok" : "degraded",
    timestamp: new Date().toISOString(),
    checks: {
      database: { ok: database, error: databaseError },
      ai: {
        ok: env.aiEnabled,
        detail: env.aiEnabled
          ? `Gemini (${env.geminiFastModel})`
          : "No GEMINI_API_KEY configured — AI features fall back to the built-in lexical model.",
      },
      realtime: {
        ok: env.livekitConfigured,
        detail: env.livekitConfigured
          ? `LiveKit at ${env.livekitUrl || env.livekitHost}`
          : "LIVEKIT_API_KEY / LIVEKIT_API_SECRET are not set — audio/video will not start.",
      },
    },
  };

  return NextResponse.json(body, { status: database ? 200 : 503 });
}
