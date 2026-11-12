import { PrismaClient } from "@prisma/client";

/**
 * Prisma is created once and cached on `globalThis` so that Next.js hot reloads
 * in development do not open a new connection pool on every rebuild.
 */
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
  });

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
