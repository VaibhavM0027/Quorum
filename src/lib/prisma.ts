import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";

/**
 * Prisma is created once and cached on `globalThis` so that Next.js hot reloads
 * in development do not open a new connection pool on every rebuild.
 *
 * When DATABASE_URL is absent (e.g., initial AI Studio preview without Cloud SQL),
 * falls back to an in-memory store supporting compound unique keys, relations,
 * ordering, numeric increments, and date comparisons so the full platform runs
 * cleanly in preview mode.
 */
type Row = Record<string, unknown>;

function flattenWhere(where?: Row): Row | undefined {
  if (!where) return undefined;
  const out: Row = {};
  for (const [key, val] of Object.entries(where)) {
    if (
      (key === "discussionId_userId" || key === "participantId_streamId") &&
      val &&
      typeof val === "object"
    ) {
      Object.assign(out, val);
    } else {
      out[key] = val;
    }
  }
  return out;
}

function cmpVal(a: unknown, b: unknown): number {
  if (a instanceof Date) a = a.getTime();
  if (b instanceof Date) b = b.getTime();
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a ?? "").localeCompare(String(b ?? ""));
}

export function createInMemoryPrisma(): PrismaClient {
  console.warn("[AI Studio] Database not connected — using in-memory mock");

  const tables = new Map<string, Row[]>();
  const getTable = (name: string): Row[] => {
    let rows = tables.get(name);
    if (!rows) {
      rows = [];
      tables.set(name, rows);
    }
    return rows;
  };

  const matchesWhere = (row: Row, rawWhere?: Row): boolean => {
    const where = flattenWhere(rawWhere);
    if (!where) return true;
    for (const [key, val] of Object.entries(where)) {
      if (key === "AND" && Array.isArray(val)) {
        if (!val.every((sub) => matchesWhere(row, sub as Row))) return false;
        continue;
      }
      if (key === "OR" && Array.isArray(val)) {
        if (!val.some((sub) => matchesWhere(row, sub as Row))) return false;
        continue;
      }
      if (key === "participants" && val && typeof val === "object") {
        const some = (val as Row).some as Row | undefined;
        if (some) {
          const parts = getTable("discussionParticipant").filter((p) => p.discussionId === row.id);
          if (!parts.some((p) => matchesWhere(p, some))) return false;
        }
        continue;
      }
      if (val && typeof val === "object" && !Array.isArray(val) && !(val instanceof Date)) {
        const cond = val as Row;
        const rv = row[key];
        if ("not" in cond) {
          if (cond.not === null ? rv === null || rv === undefined : rv === cond.not) return false;
        }
        if ("in" in cond && Array.isArray(cond.in)) {
          if (!cond.in.includes(rv)) return false;
        }
        if ("gt" in cond && cmpVal(rv, cond.gt) <= 0) return false;
        if ("gte" in cond && cmpVal(rv, cond.gte) < 0) return false;
        if ("lt" in cond && cmpVal(rv, cond.lt) >= 0) return false;
        if ("lte" in cond && cmpVal(rv, cond.lte) > 0) return false;
        continue;
      }
      if (row[key] !== val) return false;
    }
    return true;
  };

  const applyUpdateData = (existing: Row, data: Row): Row => {
    const next: Row = { ...existing, updatedAt: new Date() };
    for (const [key, val] of Object.entries(data)) {
      if (val && typeof val === "object" && !Array.isArray(val) && !(val instanceof Date)) {
        const op = val as Row;
        if (typeof op.increment === "number") {
          next[key] = (Number(next[key]) || 0) + op.increment;
          continue;
        }
        if (typeof op.decrement === "number") {
          next[key] = (Number(next[key]) || 0) - op.decrement;
          continue;
        }
      }
      next[key] = val;
    }
    return next;
  };

  const applyDefaults = (model: string, data: Row): Row => {
    const now = new Date();
    const base: Row = { id: randomUUID(), createdAt: now, updatedAt: now, ...data };
    if (model === "discussion") {
      return {
        context: "",
        rules: "",
        status: "SCHEDULED",
        mode: "AI_MODERATED",
        durationMin: 30,
        maxParticipants: 12,
        aiEnabled: true,
        transcriptionEnabled: true,
        silencePromptSec: 6,
        inviteResponseSec: 12,
        conversationState: "IDLE",
        conversationStateAt: null,
        lastAiSpokeAt: null,
        aiSpeakingUntil: null,
        activeSpeakerId: null,
        pausedAt: null,
        welcomePosted: false,
        summaryPosted: false,
        breakoutEnabled: false,
        breakoutGroupSize: 8,
        startedAt: null,
        endedAt: null,
        ...base,
      };
    }
    if (model === "discussionParticipant") {
      return {
        isHost: false,
        joinedAt: null,
        leftAt: null,
        removed: false,
        micLocked: false,
        transcriptionConsent: false,
        consentAt: null,
        transcribing: false,
        transcribingAt: null,
        seatNumber: null,
        breakoutRoom: null,
        lastAudioAt: null,
        speakingSince: null,
        invitedCount: 0,
        answeredInviteCount: 0,
        unansweredInviteCount: 0,
        passCount: 0,
        lastInvitedAt: null,
        audioIssueAt: null,
        ...base,
      };
    }
    if (model === "transcriptSegment") {
      return {
        durationMs: 0,
        wordCount: 0,
        confidence: null,
        status: "FINAL",
        streamId: null,
        revision: 0,
        relevance: "PENDING",
        relevanceScore: null,
        relevanceReason: "",
        analysisSource: "pending",
        ...base,
      };
    }
    if (model === "invitation") {
      return {
        status: "PENDING",
        invitedAt: now,
        prompts: 1,
        respondedAt: null,
        responseSegmentId: null,
        aiEventId: null,
        ...base,
      };
    }
    if (model === "aiEvent") {
      return {
        participantId: null,
        source: "gemini",
        dueAt: null,
        ...base,
      };
    }
    if (model === "evaluation") {
      return {
        overallScore: null,
        speakingMs: 0,
        contributions: 0,
        wordCount: 0,
        participationPct: 0,
        relevantCount: 0,
        partialCount: 0,
        irrelevantCount: 0,
        averageRelevance: null,
        dimensions: [],
        notes: {},
        summary: "",
        incomplete: false,
        incompleteReason: null,
        source: "gemini",
        model: null,
        ...base,
      };
    }
    if (model === "recording") {
      return {
        status: "RECORDING",
        storageKey: null,
        mimeType: "audio/webm",
        byteSize: 0,
        durationMs: 0,
        startedAt: now,
        endedAt: null,
        error: "",
        ...base,
      };
    }
    return base;
  };

  const sortRows = (rows: Row[], orderBy?: Row | Row[]): Row[] => {
    if (!orderBy) return rows;
    const specs = Array.isArray(orderBy) ? orderBy : [orderBy];
    return [...rows].sort((a, b) => {
      for (const spec of specs) {
        for (const [k, dir] of Object.entries(spec)) {
          const cmp = cmpVal(a[k], b[k]);
          if (cmp !== 0) return dir === "desc" ? -cmp : cmp;
        }
      }
      return 0;
    });
  };

  const hydrate = (model: string, row: Row, args?: Row): Row => {
    const out: Row = { ...row };
    const spec = (args?.include ?? args?.select) as Row | undefined;
    if (!spec) return out;
    if (model === "discussion") {
      if (spec.host) {
        const host = getTable("user").find((u) => u.id === row.hostId);
        out.host = host ?? { id: row.hostId, name: "Host", email: "" };
      }
      if (spec.participants) {
        const partArgs = typeof spec.participants === "object" ? (spec.participants as Row) : undefined;
        let parts = getTable("discussionParticipant").filter((p) => p.discussionId === row.id);
        if (partArgs?.where) parts = parts.filter((p) => matchesWhere(p, partArgs.where as Row));
        if (partArgs?.orderBy) parts = sortRows(parts, partArgs.orderBy as Row | Row[]);
        out.participants = parts.map((p) => ({
          ...p,
          user: getTable("user").find((u) => u.id === p.userId) ?? {
            id: p.userId,
            name: p.displayName ?? "Participant",
            email: "",
          },
        }));
      }
      if (spec.segments) {
        const segArgs = typeof spec.segments === "object" ? (spec.segments as Row) : undefined;
        let segs = getTable("transcriptSegment").filter((s) => s.discussionId === row.id);
        if (segArgs?.where) segs = segs.filter((s) => matchesWhere(s, segArgs.where as Row));
        if (segArgs?.orderBy) segs = sortRows(segs, segArgs.orderBy as Row | Row[]);
        if (typeof segArgs?.take === "number") segs = segs.slice(0, segArgs.take);
        out.segments = segs.map((s) => ({
          ...s,
          participant: getTable("discussionParticipant").find((p) => p.id === s.participantId) ?? {
            id: s.participantId,
            displayName: "Participant",
            isHost: false,
            userId: "",
          },
        }));
      }
      if (spec.evaluations) {
        out.evaluations = getTable("evaluation").filter((e) => e.discussionId === row.id);
      }
      if (spec.reports) {
        out.reports = getTable("report").filter((r) => r.discussionId === row.id);
      }
      if (spec.recordings) {
        out.recordings = sortRows(
          getTable("recording").filter((r) => r.discussionId === row.id),
          { startedAt: "desc" },
        );
      }
      if (spec._count) {
        out._count = {
          participants: getTable("discussionParticipant").filter((p) => p.discussionId === row.id).length,
          segments: getTable("transcriptSegment").filter(
            (s) => s.discussionId === row.id && s.status === "FINAL",
          ).length,
          evaluations: getTable("evaluation").filter((e) => e.discussionId === row.id).length,
        };
      }
    }
    if (model === "discussionParticipant") {
      if (spec.user) {
        out.user = getTable("user").find((u) => u.id === row.userId) ?? {
          id: row.userId,
          name: row.displayName ?? "Participant",
          email: "",
        };
      }
      if (spec.evaluation) {
        out.evaluation = getTable("evaluation").find((e) => e.participantId === row.id) ?? null;
      }
    }
    if (model === "transcriptSegment" && spec.participant) {
      out.participant = getTable("discussionParticipant").find((p) => p.id === row.participantId) ?? {
        id: row.participantId,
        displayName: "Participant",
        isHost: false,
        userId: "",
      };
    }
    return out;
  };

  const makeModel = (model: string) => ({
    findMany: async (args?: Row) => {
      let rows = getTable(model).filter((r) => matchesWhere(r, args?.where as Row | undefined));
      if (args?.orderBy) rows = sortRows(rows, args.orderBy as Row | Row[]);
      if (typeof args?.take === "number") rows = rows.slice(0, args.take);
      return rows.map((r) => hydrate(model, r, args));
    },
    findFirst: async (args?: Row) => {
      let rows = getTable(model).filter((r) => matchesWhere(r, args?.where as Row | undefined));
      if (args?.orderBy) rows = sortRows(rows, args.orderBy as Row | Row[]);
      return rows[0] ? hydrate(model, rows[0], args) : null;
    },
    findUnique: async (args?: Row) => {
      const row = getTable(model).find((r) => matchesWhere(r, args?.where as Row | undefined));
      return row ? hydrate(model, row, args) : null;
    },
    count: async (args?: Row) =>
      getTable(model).filter((r) => matchesWhere(r, args?.where as Row | undefined)).length,
    create: async (args: Row) => {
      const rawData = { ...((args?.data as Row) ?? {}) };
      const nestedParticipants =
        model === "discussion" && rawData.participants && typeof rawData.participants === "object"
          ? (rawData.participants as Row).create
          : undefined;
      if (nestedParticipants) delete rawData.participants;
      const created = applyDefaults(model, rawData);
      getTable(model).push(created);
      if (nestedParticipants) {
        const list = Array.isArray(nestedParticipants) ? nestedParticipants : [nestedParticipants];
        for (const item of list) {
          getTable("discussionParticipant").push(
            applyDefaults("discussionParticipant", {
              ...(item as Row),
              discussionId: created.id,
            }),
          );
        }
      }
      return hydrate(model, created, args);
    },
    update: async (args: Row) => {
      const rows = getTable(model);
      const idx = rows.findIndex((r) => matchesWhere(r, args?.where as Row | undefined));
      if (idx === -1) return null;
      rows[idx] = applyUpdateData(rows[idx], (args?.data as Row) ?? {});
      return hydrate(model, rows[idx], args);
    },
    updateMany: async (args?: Row) => {
      let count = 0;
      const rows = getTable(model);
      for (let i = 0; i < rows.length; i += 1) {
        if (matchesWhere(rows[i], args?.where as Row | undefined)) {
          rows[i] = applyUpdateData(rows[i], (args?.data as Row) ?? {});
          count += 1;
        }
      }
      return { count };
    },
    upsert: async (args: Row) => {
      const rows = getTable(model);
      const idx = rows.findIndex((r) => matchesWhere(r, args?.where as Row | undefined));
      if (idx >= 0) {
        rows[idx] = applyUpdateData(rows[idx], (args?.update as Row) ?? {});
        return hydrate(model, rows[idx], args);
      }
      const created = applyDefaults(model, (args?.create as Row) ?? {});
      rows.push(created);
      return hydrate(model, created, args);
    },
    delete: async (args?: Row) => {
      const rows = getTable(model);
      const idx = rows.findIndex((r) => matchesWhere(r, args?.where as Row | undefined));
      if (idx === -1) return null;
      const [removed] = rows.splice(idx, 1);
      return removed;
    },
    deleteMany: async (args?: Row) => {
      const rows = getTable(model);
      const kept = rows.filter((r) => !matchesWhere(r, args?.where as Row | undefined));
      const count = rows.length - kept.length;
      tables.set(model, kept);
      return { count };
    },
  });

  const modelCache = new Map<string, ReturnType<typeof makeModel>>();
  const proxy: unknown = new Proxy(
    {},
    {
      get(_, prop: string) {
        if (prop === "$queryRaw" || prop === "$executeRaw") {
          return async () => {
            throw new Error("Database not connected (DATABASE_URL not configured — using in-memory mock)");
          };
        }
        if (prop === "$transaction") {
          return async (arg: unknown) => {
            if (Array.isArray(arg)) return Promise.all(arg);
            if (typeof arg === "function") return arg(proxy);
            return [];
          };
        }
        if (prop === "$connect" || prop === "$disconnect") {
          return async () => {};
        }
        let m = modelCache.get(prop);
        if (!m) {
          m = makeModel(prop);
          modelCache.set(prop, m);
        }
        return m;
      },
    },
  );
  return proxy as PrismaClient;
}

const globalForPrisma = globalThis as unknown as {
  prisma?: PrismaClient;
  schemaSyncedKeys?: Set<string>;
  schemaSyncInFlight?: Map<string, Promise<void>>;
};

const SCHEMA_SYNC_STATEMENTS: readonly string[] = [
  `ALTER TABLE "Discussion"
    ADD COLUMN IF NOT EXISTS "aiSpeakingUntil" TIMESTAMP(3),
    ADD COLUMN IF NOT EXISTS "activeSpeakerId" TEXT,
    ADD COLUMN IF NOT EXISTS "pausedAt" TIMESTAMP(3),
    ADD COLUMN IF NOT EXISTS "welcomePosted" BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS "summaryPosted" BOOLEAN NOT NULL DEFAULT false`,
  `ALTER TABLE "DiscussionParticipant"
    ADD COLUMN IF NOT EXISTS "micLocked" BOOLEAN NOT NULL DEFAULT false`,
  `ALTER TABLE "TranscriptSegment"
    ADD COLUMN IF NOT EXISTS "confidence" DOUBLE PRECISION`,
  `CREATE INDEX IF NOT EXISTS "TranscriptSegment_discussionId_status_startedAt_idx"
    ON "TranscriptSegment"("discussionId", "status", "startedAt")`,
];

export function isUnreachableDbError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const code = (err as { code?: string }).code;
  const name = (err as { name?: string }).name ?? "";
  const msg = (err as { message?: string }).message ?? "";
  return (
    code === "P1001" ||
    code === "ECONNREFUSED" ||
    name === "PrismaClientInitializationError" ||
    /Can't reach database server|ECONNREFUSED|connect ECONNREFUSED/i.test(msg)
  );
}

export function isMissingColumnError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const code = (err as { code?: string }).code;
  const msg = (err as { message?: string }).message ?? "";
  return (
    code === "P2022" ||
    code === "42703" ||
    /column .* does not exist/i.test(msg)
  );
}

function isMissingRelationError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const code = (err as { code?: string }).code;
  const msg = (err as { message?: string }).message ?? "";
  const metaCode = (err as { meta?: { code?: string } }).meta?.code;
  return (
    code === "P2021" ||
    code === "42P01" ||
    metaCode === "42P01" ||
    /relation ".*" does not exist/i.test(msg)
  );
}

export async function ensurePostgresSchema(
  client: Pick<PrismaClient, "$executeRawUnsafe">,
  dbKey: string,
  force = false,
): Promise<void> {
  if (!dbKey || dbKey.includes("build:build@localhost")) {
    return;
  }
  const syncedKeys = (globalForPrisma.schemaSyncedKeys ??= new Set<string>());
  const inFlight = (globalForPrisma.schemaSyncInFlight ??= new Map<string, Promise<void>>());

  if (force) {
    syncedKeys.delete(dbKey);
  }
  if (syncedKeys.has(dbKey)) {
    return;
  }

  let running = inFlight.get(dbKey);
  if (!running) {
    running = (async () => {
      try {
        for (const sql of SCHEMA_SYNC_STATEMENTS) {
          await client.$executeRawUnsafe(sql);
        }
        syncedKeys.add(dbKey);
      } catch (err) {
        if (isMissingRelationError(err)) {
          console.warn(
            "[quorum] Base tables do not exist yet — run `npx prisma db push` against DATABASE_URL",
          );
          syncedKeys.add(dbKey);
          return;
        }
        throw err;
      } finally {
        inFlight.delete(dbKey);
      }
    })();
    inFlight.set(dbKey, running);
  }

  await running;
}

export interface WrapPrismaOptions {
  dbKey: string;
  allowPreviewFallback: boolean;
  createFallback?: () => PrismaClient;
}

export function wrapPrismaClient(
  realClient: PrismaClient,
  options: WrapPrismaOptions,
): PrismaClient {
  const { dbKey, allowPreviewFallback } = options;
  const makeFallback = options.createFallback ?? createInMemoryPrisma;

  let fallbackClient: PrismaClient | null = null;
  const activateFallback = (): PrismaClient => {
    if (!fallbackClient) {
      console.warn(
        "[AI Studio] Local PostgreSQL unreachable — switching to in-memory preview fallback",
      );
      fallbackClient = makeFallback();
    }
    return fallbackClient;
  };

  const ensureReady = async (force = false): Promise<PrismaClient | null> => {
    if (fallbackClient) return fallbackClient;
    const syncedKeys = globalForPrisma.schemaSyncedKeys;
    if (!force && syncedKeys?.has(dbKey)) {
      return null;
    }
    try {
      await ensurePostgresSchema(realClient, dbKey, force);
      return null;
    } catch (err) {
      if (allowPreviewFallback && isUnreachableDbError(err)) {
        return activateFallback();
      }
      throw err;
    }
  };

  return new Proxy(realClient, {
    get(target, prop: string | symbol) {
      if (typeof prop === "symbol" || prop === "then") {
        return Reflect.get(target, prop);
      }
      if (
        prop === "$queryRaw" ||
        prop === "$executeRaw" ||
        prop === "$queryRawUnsafe" ||
        prop === "$executeRawUnsafe"
      ) {
        const active = fallbackClient ?? target;
        const fn = Reflect.get(active, prop) as (...a: unknown[]) => Promise<unknown>;
        return typeof fn === "function" ? fn.bind(active) : fn;
      }
      if (prop === "$transaction") {
        return async (arg: unknown) => {
          const fbOnInit = await ensureReady(false);
          if (fbOnInit) {
            return (fbOnInit.$transaction as (a: unknown) => Promise<unknown>)(arg);
          }
          try {
            return await (target.$transaction as (a: unknown) => Promise<unknown>)(arg);
          } catch (err) {
            if (isMissingColumnError(err)) {
              await ensureReady(true);
              return await (target.$transaction as (a: unknown) => Promise<unknown>)(arg);
            }
            if (allowPreviewFallback && isUnreachableDbError(err)) {
              const fb = activateFallback();
              return (fb.$transaction as (a: unknown) => Promise<unknown>)(arg);
            }
            throw err;
          }
        };
      }

      const rawMember = Reflect.get(target, prop);
      if (rawMember && typeof rawMember === "object") {
        return new Proxy(rawMember, {
          get(modelTarget, op: string | symbol) {
            return async (...args: unknown[]) => {
              const fbOnInit = await ensureReady(false);
              if (fbOnInit) {
                const fbModel = Reflect.get(fbOnInit, prop) as Record<
                  string | symbol,
                  (...a: unknown[]) => Promise<unknown>
                >;
                return fbModel[op](...args);
              }
              const fn = Reflect.get(modelTarget, op) as (...a: unknown[]) => Promise<unknown>;
              try {
                return await fn.apply(modelTarget, args);
              } catch (err) {
                if (isMissingColumnError(err)) {
                  await ensureReady(true);
                  return await fn.apply(modelTarget, args);
                }
                if (allowPreviewFallback && isUnreachableDbError(err)) {
                  const fb = activateFallback();
                  const fbModel = Reflect.get(fb, prop) as Record<
                    string | symbol,
                    (...a: unknown[]) => Promise<unknown>
                  >;
                  return fbModel[op](...args);
                }
                throw err;
              }
            };
          },
        });
      }

      return typeof rawMember === "function" ? rawMember.bind(target) : rawMember;
    },
  });
}

function initPrisma(): PrismaClient {
  const url = process.env.DATABASE_URL ?? "";
  if (!url) {
    return createInMemoryPrisma();
  }

  let realClient: PrismaClient;
  try {
    realClient = new PrismaClient({
      log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
    });
  } catch {
    return createInMemoryPrisma();
  }

  if (process.env.NODE_ENV === "test") {
    return realClient;
  }

  const allowPreviewFallback = /(127\.0\.0\.1|localhost)/.test(url);
  return wrapPrismaClient(realClient, {
    dbKey: url,
    allowPreviewFallback,
  });
}

export const prisma = globalForPrisma.prisma ?? initPrisma();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
