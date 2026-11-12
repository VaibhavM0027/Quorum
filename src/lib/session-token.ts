import { SignJWT, jwtVerify } from "jose";
import { env } from "./env";

/**
 * Edge-runtime safe session token helpers.
 *
 * This module must stay free of Node-only dependencies (bcrypt, next/headers)
 * because `middleware.ts` imports it and runs on the Edge runtime.
 */

export const SESSION_COOKIE = "quorum_session";
export const SESSION_MAX_AGE_SEC = 60 * 60 * 24 * 7; // 7 days

const secretKey = new TextEncoder().encode(env.jwtSecret);

export type Role = "HOST" | "PARTICIPANT";

export type SessionUser = {
  id: string;
  email: string;
  name: string;
  role: Role;
};

export async function createSessionToken(user: SessionUser): Promise<string> {
  return new SignJWT({ email: user.email, name: user.name, role: user.role })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(user.id)
    .setIssuedAt()
    .setExpirationTime(`${SESSION_MAX_AGE_SEC}s`)
    .sign(secretKey);
}

/** Verifies a session JWT. Returns null for any invalid or expired token. */
export async function verifySessionToken(token: string): Promise<SessionUser | null> {
  try {
    const { payload } = await jwtVerify(token, secretKey, { algorithms: ["HS256"] });
    const { sub, email, name, role } = payload as Record<string, unknown>;
    if (
      typeof sub !== "string" ||
      typeof email !== "string" ||
      typeof name !== "string" ||
      (role !== "HOST" && role !== "PARTICIPANT")
    ) {
      return null;
    }
    return { id: sub, email, name, role };
  } catch {
    return null;
  }
}
