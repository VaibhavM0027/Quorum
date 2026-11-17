import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import {
  ensurePostgresSchema,
  isMissingColumnError,
  wrapPrismaClient,
} from "@/lib/prisma";

describe("Prisma P2022 detection & automatic schema sync", () => {
  it("recognizes Prisma P2022 and Postgres missing-column errors", () => {
    expect(isMissingColumnError({ code: "P2022" })).toBe(true);
    expect(isMissingColumnError({ code: "42703" })).toBe(true);
    expect(
      isMissingColumnError(
        new Error("The column `Discussion.aiSpeakingUntil` does not exist in the current database."),
      ),
    ).toBe(true);
    expect(isMissingColumnError({ code: "P1001", message: "Can't reach database" })).toBe(false);
    expect(isMissingColumnError(null)).toBe(false);
  });

  it("executes idempotent DDL once per dbKey and skips Docker build placeholder", async () => {
    const exec = vi.fn().mockResolvedValue(0);
    const client = { $executeRawUnsafe: exec };

    await ensurePostgresSchema(client, "postgresql://build:build@localhost:5432/build");
    expect(exec).not.toHaveBeenCalled();

    const key = `postgresql://user:pass@remote.render.com/db_${Math.random()}`;
    await ensurePostgresSchema(client, key);
    expect(exec).toHaveBeenCalledTimes(4);
    expect(exec.mock.calls[0][0]).toContain(`"aiSpeakingUntil"`);
    expect(exec.mock.calls[0][0]).toContain(`"activeSpeakerId"`);
    expect(exec.mock.calls[0][0]).toContain(`"pausedAt"`);
    expect(exec.mock.calls[0][0]).toContain(`"welcomePosted"`);
    expect(exec.mock.calls[0][0]).toContain(`"summaryPosted"`);
    expect(exec.mock.calls[1][0]).toContain(`"micLocked"`);
    expect(exec.mock.calls[2][0]).toContain(`"confidence"`);
    expect(exec.mock.calls[3][0]).toContain(`TranscriptSegment_discussionId_status_startedAt_idx`);

    // Second call uses cached synced state
    await ensurePostgresSchema(client, key);
    expect(exec).toHaveBeenCalledTimes(4);
  });

  it("heals P2022 on model queries and retries transparently", async () => {
    let attempts = 0;
    const findMany = vi.fn(async () => {
      attempts += 1;
      if (attempts === 1) {
        throw Object.assign(
          new Error("The column `Discussion.aiSpeakingUntil` does not exist in the current database."),
          { code: "P2022" },
        );
      }
      return [{ id: "disc-1", title: "Synchronized Room" }];
    });

    const exec = vi.fn().mockResolvedValue(0);
    const fakeClient = {
      $executeRawUnsafe: exec,
      $queryRaw: vi.fn(),
      $executeRaw: vi.fn(),
      $queryRawUnsafe: vi.fn(),
      $transaction: vi.fn(),
      discussion: { findMany },
    } as unknown as PrismaClient;

    const key = `postgresql://user:pass@remote.render.com/retry_${Math.random()}`;
    const wrapped = wrapPrismaClient(fakeClient, {
      dbKey: key,
      allowPreviewFallback: false,
    });

    const rows = await wrapped.discussion.findMany();
    expect(rows).toEqual([{ id: "disc-1", title: "Synchronized Room" }]);
    expect(findMany).toHaveBeenCalledTimes(2);
    // Initial sync (4 statements) + forced re-sync after P2022 (4 statements)
    expect(exec).toHaveBeenCalledTimes(8);
  });

  it("heals P2022 inside $transaction", async () => {
    let txCalls = 0;
    const tx = vi.fn(async () => {
      txCalls += 1;
      if (txCalls === 1) {
        throw Object.assign(new Error("Missing column"), { code: "P2022" });
      }
      return ["ok"];
    });
    const exec = vi.fn().mockResolvedValue(0);
    const fakeClient = {
      $executeRawUnsafe: exec,
      $transaction: tx,
    } as unknown as PrismaClient;

    const wrapped = wrapPrismaClient(fakeClient, {
      dbKey: `postgresql://user:pass@remote.render.com/tx_${Math.random()}`,
      allowPreviewFallback: false,
    });

    const res = await wrapped.$transaction([]);
    expect(res).toEqual(["ok"]);
    expect(tx).toHaveBeenCalledTimes(2);
    expect(exec).toHaveBeenCalledTimes(8);
  });

  it("falls back to in-memory store for localhost P1001, but rethrows for remote DB", async () => {
    const unreachableErr = Object.assign(new Error("Can't reach database server"), {
      code: "P1001",
    });
    const execFail = vi.fn().mockRejectedValue(unreachableErr);
    const fakeClient = {
      $executeRawUnsafe: execFail,
      discussion: { findMany: vi.fn().mockRejectedValue(unreachableErr) },
    } as unknown as PrismaClient;

    const localWrapped = wrapPrismaClient(fakeClient, {
      dbKey: `postgresql://postgres:postgres@localhost:5432/down_${Math.random()}`,
      allowPreviewFallback: true,
    });
    const mockRows = await localWrapped.discussion.findMany();
    expect(mockRows).toEqual([]);

    const remoteWrapped = wrapPrismaClient(fakeClient, {
      dbKey: `postgresql://postgres:postgres@remote.db.internal:5432/down_${Math.random()}`,
      allowPreviewFallback: false,
    });
    await expect(remoteWrapped.discussion.findMany()).rejects.toThrow("Can't reach database server");
  });
});
