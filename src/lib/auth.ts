import { cookies } from "next/headers";
import bcrypt from "bcryptjs";
import { env } from "./env";
import {
  SESSION_COOKIE,
  SESSION_MAX_AGE_SEC,
  createSessionToken,
  verifySessionToken,
  type Role,
  type SessionUser,
} from "./session-token";

export { SESSION_COOKIE, createSessionToken, verifySessionToken };
export type { Role, SessionUser };

/** Hash a password with bcrypt (Node runtime only). */
export function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, 10);
}

export function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

/** Reads and verifies the session from the request cookies. */
export async function getSession(): Promise<SessionUser | null> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  return verifySessionToken(token);
}

export async function setSessionCookie(token: string): Promise<void> {
  const store = await cookies();
  store.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: env.cookieSecure,
    path: "/",
    maxAge: SESSION_MAX_AGE_SEC,
  });
}

export async function clearSessionCookie(): Promise<void> {
  const store = await cookies();
  store.delete(SESSION_COOKIE);
}

/** Throws a 401-style error when there is no valid session. */
export async function requireSession(): Promise<SessionUser> {
  const user = await getSession();
  if (!user) {
    const error = new Error("You must be signed in to do that.");
    (error as Error & { status?: number }).status = 401;
    throw error;
  }
  return user;
}
