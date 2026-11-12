import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

/**
 * Creates the default host and participant accounts.
 * Requires SEED_PASSWORD to be set in .env — never hardcode credentials here.
 *
 * Run with: npm run seed
 */
const prisma = new PrismaClient();

async function upsertUser(input: {
  email: string;
  name: string;
  role: "HOST" | "PARTICIPANT";
  passwordHash: string;
}) {
  return prisma.user.upsert({
    where: { email: input.email.toLowerCase() },
    update: { name: input.name, role: input.role, passwordHash: input.passwordHash },
    create: {
      email: input.email.toLowerCase(),
      name: input.name,
      role: input.role,
      passwordHash: input.passwordHash,
    },
    select: { id: true, email: true, role: true },
  });
}

async function main() {
  const password = process.env.SEED_PASSWORD;
  if (!password || password.length < 8) {
    console.error(
      "SEED_PASSWORD is missing or too short. Add e.g. SEED_PASSWORD=\"change-me-please\" to .env and retry.",
    );
    process.exit(1);
  }

  const passwordHash = await bcrypt.hash(password, 10);

  const host = await upsertUser({
    email: process.env.SEED_HOST_EMAIL ?? "host@quorum.local",
    name: process.env.SEED_HOST_NAME ?? "Discussion Host",
    role: "HOST",
    passwordHash,
  });

  const participant = await upsertUser({
    email: process.env.SEED_PARTICIPANT_EMAIL ?? "participant@quorum.local",
    name: process.env.SEED_PARTICIPANT_NAME ?? "Demo Participant",
    role: "PARTICIPANT",
    passwordHash,
  });

  console.log("Seed complete:");
  console.log(`  host        ${host.email}`);
  console.log(`  participant ${participant.email}`);
  console.log("  password    (value of SEED_PASSWORD)");
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
