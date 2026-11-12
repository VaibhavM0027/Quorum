import { NextResponse } from "next/server";
import { ZodError } from "zod";

/** Successful JSON response. */
export function ok<T>(data: T, status = 200) {
  return NextResponse.json(data, { status });
}

/** Error JSON response with a machine-readable `error` field. */
export function fail(message: string, status = 400, extra: Record<string, unknown> = {}) {
  return NextResponse.json({ error: message, ...extra }, { status });
}

/**
 * Converts an unknown thrown value into a safe JSON response.
 * Zod issues are surfaced to the client; anything else is logged and hidden.
 */
export function handleRouteError(error: unknown) {
  if (error instanceof ZodError) {
    return fail("Validation failed", 422, {
      issues: error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    });
  }

  // Errors thrown by helpers such as requireSession() carry their own status.
  const status = (error as { status?: unknown } | null)?.status;
  if (typeof status === "number" && status >= 400 && status < 500) {
    const message = error instanceof Error ? error.message : "Request failed";
    return fail(message, status);
  }

  console.error("[api]", error);
  const message = error instanceof Error ? error.message : "Unexpected server error";
  return fail(message, 500);
}

/** Largest JSON request body we accept, in bytes. */
const MAX_BODY_BYTES = 64 * 1024;

/** Builds an error that `handleRouteError` will surface with its status. */
function httpError(message: string, status: number): Error {
  return Object.assign(new Error(message), { status });
}

/**
 * Parses a JSON body, rejecting oversized or malformed payloads.
 * The declared `content-length` is checked first so an oversized upload can be
 * refused before it is buffered into memory.
 */
export async function readJson(request: Request): Promise<unknown> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    throw httpError("Expected a JSON request body", 415);
  }

  const declaredLength = Number(request.headers.get("content-length") ?? "");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    throw httpError("Request body is too large.", 413);
  }

  const raw = await request.text();
  if (raw.length > MAX_BODY_BYTES) {
    throw httpError("Request body is too large.", 413);
  }

  try {
    return JSON.parse(raw);
  } catch {
    throw httpError("Request body must be valid JSON.", 400);
  }
}

