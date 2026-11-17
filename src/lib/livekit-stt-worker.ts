import { randomUUID } from "node:crypto";
import type { RemoteTrack } from "@livekit/rtc-node";
import { DataPacket_Kind } from "livekit-server-sdk";
import { prisma } from "./prisma";
import {
  createRoomToken,
  getRoomService,
  livekitReady,
  roomNameFor,
  serverLivekitWsUrl,
} from "./livekit";
import { isAiSpeakingLocked, isMeetingPaused } from "./room-sync";
import { getSttProvider } from "./stt/provider";
import {
  TRANSCRIPT_PARTIAL_TOPIC,
  TRANSCRIPT_UPDATE_TOPIC,
  countWords,
  isDuplicateSegment,
  isMeaningful,
  normalizeTranscript,
} from "./transcript";
import { classifyParticipantResponse } from "./participation";
import { transcriptLog, transcriptWarn } from "./debug-log";

const TARGET_SAMPLE_RATE = 16_000;
const PRE_ROLL_SAMPLES = Math.round(TARGET_SAMPLE_RATE * 0.25);
const PARTIAL_EMIT_INTERVAL_MS = 2800;
const SILENCE_FINALIZE_MS = 1600;
const MAX_UTTERANCE_MS = 45_000;
const MIN_FINAL_SPEECH_MS = 350;

export const WORKER_IDENTITY_PREFIX = "__quorum_stt__";

type WorkerEntry = {
  discussionId: string;
  breakoutRoom: number | null;
  connected: boolean;
  connecting: boolean;
  stopped: boolean;
  disconnect: () => Promise<void>;
  activeStreams: Set<() => void>;
};

function getRegistry(): Map<string, WorkerEntry> {
  const g = globalThis as unknown as { __quorumSttWorkers?: Map<string, WorkerEntry> };
  if (!g.__quorumSttWorkers) {
    g.__quorumSttWorkers = new Map<string, WorkerEntry>();
  }
  return g.__quorumSttWorkers;
}

function workerKey(discussionId: string, breakoutRoom: number | null): string {
  return `${discussionId}:${breakoutRoom ?? 0}`;
}

/** True when a given LiveKit identity belongs to a human participant rather than an internal worker. */
export function isHumanIdentity(identity: string | null | undefined): boolean {
  if (!identity) return false;
  return !identity.startsWith(WORKER_IDENTITY_PREFIX) && !identity.startsWith("quorum-ai-");
}

/** Encodes mono Int16 PCM samples into a RIFF/WAVE Buffer ready for STT providers. */
export function encodeInt16PcmWav(
  samples: Int16Array,
  sampleRate: number = TARGET_SAMPLE_RATE,
): Buffer {
  const bytesPerSample = 2;
  const dataLength = samples.length * bytesPerSample;
  const buffer = Buffer.allocUnsafe(44 + dataLength);
  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(36 + dataLength, 4);
  buffer.write("WAVE", 8, "ascii");
  buffer.write("fmt ", 12, "ascii");
  buffer.writeUInt32LE(16, 16); // PCM chunk size
  buffer.writeUInt16LE(1, 20); // PCM format
  buffer.writeUInt16LE(1, 22); // mono
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * bytesPerSample, 28);
  buffer.writeUInt16LE(bytesPerSample, 32);
  buffer.writeUInt16LE(bytesPerSample * 8, 34);
  buffer.write("data", 36, "ascii");
  buffer.writeUInt32LE(dataLength, 40);

  for (let i = 0; i < samples.length; i += 1) {
    buffer.writeInt16LE(samples[i], 44 + i * 2);
  }
  return buffer;
}

/** Computes normalized RMS amplitude for an Int16 PCM frame. */
export function computeInt16Rms(samples: Int16Array): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const norm = samples[i] / 32768;
    sum += norm * norm;
  }
  return Math.sqrt(sum / samples.length);
}

/** Concatenates accumulated Int16Array frames into a single contiguous array. */
export function concatInt16Frames(chunks: Int16Array[], totalSamples: number): Int16Array {
  const out = new Int16Array(totalSamples);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/** Broadcasts a LiveKit data packet to the discussion's room(s). */
async function sendRoomData(
  discussionId: string,
  breakoutRoom: number | null,
  topic: string,
  payload: string | Record<string, unknown>,
): Promise<void> {
  const client = getRoomService();
  if (!client) return;
  const room = roomNameFor(discussionId, breakoutRoom);
  const bytes = new TextEncoder().encode(
    typeof payload === "string" ? payload : JSON.stringify(payload),
  );
  try {
    await client.sendData(room, bytes, DataPacket_Kind.RELIABLE, { topic });
  } catch {
    /* clients also recover via polling */
  }
}

async function persistServerTranscriptChunk(params: {
  discussionId: string;
  breakoutRoom: number | null;
  participantIdentity: string;
  streamId: string;
  revision: number;
  mode: "partial" | "final";
  pcm: Int16Array;
  startedAt: Date;
  endedAt: Date;
  durationMs: number;
}): Promise<void> {
  const provider = getSttProvider();
  if (!provider.isAvailable()) return;

  const discussion = await prisma.discussion.findUnique({
    where: { id: params.discussionId },
    select: {
      id: true,
      status: true,
      transcriptionEnabled: true,
    },
  });
  if (!discussion || discussion.status !== "LIVE" || !discussion.transcriptionEnabled) return;

  const member = await prisma.discussionParticipant.findUnique({
    where: {
      discussionId_userId: {
        discussionId: params.discussionId,
        userId: params.participantIdentity,
      },
    },
    select: {
      id: true,
      displayName: true,
      isHost: true,
      removed: true,
      leftAt: true,
      transcriptionConsent: true,
    },
  });
  if (!member || member.removed || member.leftAt || !member.transcriptionConsent) return;

  const wavBuffer = encodeInt16PcmWav(params.pcm, TARGET_SAMPLE_RATE);
  let rawText = "";
  let confidence: number | null = null;
  try {
    const sttInput = {
      audioBase64: wavBuffer.toString("base64"),
      mimeType: "audio/wav",
      language: process.env.NEXT_PUBLIC_SPEECH_LANG || undefined,
    };
    if (provider.transcribeDetailed) {
      const detailed = await provider.transcribeDetailed(sttInput);
      rawText = detailed.text;
      confidence = detailed.confidence;
    } else {
      rawText = await provider.transcribe(sttInput);
    }
  } catch (error) {
    transcriptWarn("server-side STT chunk failed", {
      discussionId: params.discussionId,
      identity: params.participantIdentity,
      error: error instanceof Error ? error.message : String(error),
    });
    return;
  }

  const text = normalizeTranscript(rawText);
  if (!isMeaningful(text)) return;

  if (params.mode === "partial") {
    const data = {
      discussionId: params.discussionId,
      participantId: member.id,
      streamId: params.streamId,
      text,
      startedAt: params.startedAt,
      endedAt: params.endedAt,
      durationMs: Math.round(params.durationMs),
      wordCount: countWords(text),
      confidence,
      status: "PARTIAL" as const,
      revision: params.revision,
    };

    const existing = await prisma.transcriptSegment.findUnique({
      where: {
        participantId_streamId: { participantId: member.id, streamId: params.streamId },
      },
      select: { status: true, revision: true },
    });
    if (existing?.status === "FINAL") return;

    if (existing) {
      await prisma.transcriptSegment.updateMany({
        where: {
          participantId: member.id,
          streamId: params.streamId,
          status: "PARTIAL",
          revision: { lte: params.revision },
        },
        data,
      });
    } else {
      await prisma.transcriptSegment.create({ data }).catch(() => null);
    }

    await prisma.discussionParticipant.update({
      where: { id: member.id },
      data: { transcribing: true, transcribingAt: new Date() },
    });

    await sendRoomData(params.discussionId, params.breakoutRoom, TRANSCRIPT_PARTIAL_TOPIC, {
      type: "partial",
      streamId: params.streamId,
      revision: params.revision,
      text,
      startedAt: params.startedAt.toISOString(),
      participantIdentity: params.participantIdentity,
      participantName: member.displayName,
    });
    return;
  }

  // FINAL segment
  const previous = await prisma.transcriptSegment.findFirst({
    where: { discussionId: params.discussionId, participantId: member.id, status: "FINAL" },
    orderBy: { startedAt: "desc" },
    select: { id: true, text: true, startedAt: true },
  });
  const streamedExisting = await prisma.transcriptSegment.findUnique({
    where: {
      participantId_streamId: { participantId: member.id, streamId: params.streamId },
    },
    select: { id: true, status: true },
  });
  if (!streamedExisting && previous && isDuplicateSegment(previous, text, params.startedAt)) {
    return;
  }

  const finalData = {
    discussionId: params.discussionId,
    participantId: member.id,
    streamId: params.streamId,
    text,
    startedAt: params.startedAt,
    endedAt: params.endedAt >= params.startedAt ? params.endedAt : new Date(params.startedAt.getTime() + params.durationMs),
    durationMs: Math.round(params.durationMs),
    wordCount: countWords(text),
    confidence,
    status: "FINAL" as const,
    revision: params.revision,
  };

  const segment = await prisma.transcriptSegment.upsert({
    where: {
      participantId_streamId: { participantId: member.id, streamId: params.streamId },
    },
    create: finalData,
    update: finalData,
    select: { id: true, text: true },
  });

  const now = new Date();
  await prisma.discussionParticipant.update({
    where: { id: member.id },
    data: { lastAudioAt: now, transcribing: true, transcribingAt: now },
  });

  // Settle pending invitation immediately if this participant answered.
  const pendingInvite = await prisma.invitation.findFirst({
    where: { discussionId: params.discussionId, participantId: member.id, status: "PENDING" },
    select: { id: true, aiEventId: true },
  });
  if (pendingInvite) {
    const kind = classifyParticipantResponse(segment.text);
    const status = kind === "pass" ? "PASSED" : kind === "technical" ? "TECHNICAL" : "ANSWERED";
    await prisma.$transaction([
      prisma.invitation.update({
        where: { id: pendingInvite.id },
        data: { status, respondedAt: now, responseSegmentId: segment.id },
      }),
      ...(pendingInvite.aiEventId
        ? [prisma.aiEvent.update({ where: { id: pendingInvite.aiEventId }, data: { dueAt: null } })]
        : []),
      prisma.discussionParticipant.update({
        where: { id: member.id },
        data:
          kind === "pass"
            ? { passCount: { increment: 1 } }
            : kind === "technical"
              ? { audioIssueAt: now }
              : { answeredInviteCount: { increment: 1 } },
      }),
    ]);
  }

  await sendRoomData(
    params.discussionId,
    params.breakoutRoom,
    TRANSCRIPT_UPDATE_TOPIC,
    "transcript-updated",
  );

  transcriptLog("server LiveKit STT stored segment", {
    discussionId: params.discussionId,
    identity: params.participantIdentity,
    words: finalData.wordCount,
    durationMs: finalData.durationMs,
  });
}

/**
 * Ensures a hidden server-side LiveKit subscriber worker is running for the
 * discussion room so every participant's audio track is transcribed reliably
 * regardless of browser vendor or tab state.
 */
export async function ensureRoomSttWorker(
  discussionId: string,
  breakoutRoom: number | null = null,
): Promise<boolean> {
  if (!livekitReady() || !getSttProvider().isAvailable()) return false;

  const key = workerKey(discussionId, breakoutRoom);
  const registry = getRegistry();
  const existing = registry.get(key);
  if (existing && (existing.connected || existing.connecting) && !existing.stopped) {
    return existing.connected;
  }

  const entry: WorkerEntry = {
    discussionId,
    breakoutRoom,
    connected: false,
    connecting: true,
    stopped: false,
    disconnect: async () => {},
    activeStreams: new Set(),
  };
  registry.set(key, entry);

  void (async () => {
    try {
      const rtc = await import("@livekit/rtc-node");
      if (entry.stopped) return;

      const identity = `${WORKER_IDENTITY_PREFIX}${breakoutRoom ?? 0}`;
      const token = await createRoomToken({
        discussionId,
        identity,
        name: "Quorum Transcriber",
        isHost: false,
        canPublish: false,
        breakoutRoom,
        hidden: true,
      });

      const room = new rtc.Room();
      entry.disconnect = async () => {
        entry.stopped = true;
        entry.connected = false;
        for (const cancelStream of entry.activeStreams) {
          cancelStream();
        }
        entry.activeStreams.clear();
        await room.disconnect().catch(() => {});
      };

      const attachAudioTrack = (track: RemoteTrack, identityId: string) => {
        if (!isHumanIdentity(identityId) || track.kind !== rtc.TrackKind.KIND_AUDIO) return;
        const audioStream = new rtc.AudioStream(track, TARGET_SAMPLE_RATE, 1);
        const reader = audioStream.getReader();
        let cancelled = false;
        const cancel = () => {
          cancelled = true;
          void reader.cancel().catch(() => {});
        };
        entry.activeStreams.add(cancel);

        void (async () => {
          let frames: Int16Array[] = [];
          let totalSamples = 0;
          let preRoll: Int16Array[] = [];
          let preRollSamples = 0;
          let utteranceStartMs: number | null = null;
          let silenceStartMs: number | null = null;
          let lastPartialAtMs = 0;
          let streamId = randomUUID();
          let revision = 0;
          let noiseFloor = 0.002;
          let policyCheckedAt = 0;
          let allowCapture = true;
          let inFlightPartial = false;

          const refreshCapturePolicy = async (now: number) => {
            if (now - policyCheckedAt < 500) return allowCapture;
            policyCheckedAt = now;
            const discussion = await prisma.discussion.findUnique({
              where: { id: discussionId },
              select: {
                status: true,
                transcriptionEnabled: true,
                conversationState: true,
                aiSpeakingUntil: true,
                lastAiSpokeAt: true,
                pausedAt: true,
              },
            });
            if (
              !discussion ||
              discussion.status !== "LIVE" ||
              !discussion.transcriptionEnabled ||
              isMeetingPaused(discussion) ||
              isAiSpeakingLocked(discussion, now)
            ) {
              allowCapture = false;
              return false;
            }
            const member = await prisma.discussionParticipant.findUnique({
              where: { discussionId_userId: { discussionId, userId: identityId } },
              select: { removed: true, leftAt: true, micLocked: true, transcriptionConsent: true },
            });
            allowCapture = Boolean(
              member && !member.removed && !member.leftAt && !member.micLocked && member.transcriptionConsent,
            );
            return allowCapture;
          };

          const flush = async (mode: "partial" | "final") => {
            if (totalSamples === 0 || utteranceStartMs === null) return;
            const durationMs = Math.round((totalSamples / TARGET_SAMPLE_RATE) * 1000);
            if (mode === "final" && durationMs < MIN_FINAL_SPEECH_MS) {
              frames = [];
              totalSamples = 0;
              utteranceStartMs = null;
              silenceStartMs = null;
              streamId = randomUUID();
              revision = 0;
              return;
            }

            const pcm = concatInt16Frames(frames, totalSamples);
            const currentStreamId = streamId;
            const currentRevision = ++revision;
            const startedAt = new Date(utteranceStartMs);
            const endedAt = new Date(utteranceStartMs + durationMs);

            if (mode === "final") {
              frames = [];
              totalSamples = 0;
              utteranceStartMs = null;
              silenceStartMs = null;
              lastPartialAtMs = 0;
              streamId = randomUUID();
              revision = 0;
            } else {
              lastPartialAtMs = Date.now();
            }

            await persistServerTranscriptChunk({
              discussionId,
              breakoutRoom,
              participantIdentity: identityId,
              streamId: currentStreamId,
              revision: currentRevision,
              mode,
              pcm,
              startedAt,
              endedAt,
              durationMs,
            });
          };

          try {
            while (!cancelled && !entry.stopped) {
              const { done, value } = await reader.read();
              if (done || !value) break;

              const now = Date.now();
              const canCapture = await refreshCapturePolicy(now);
              if (!canCapture) {
                if (utteranceStartMs !== null && totalSamples > 0) {
                  await flush("final");
                }
                preRoll = [];
                preRollSamples = 0;
                continue;
              }

              const copy = new Int16Array(value.data);
              const rms = computeInt16Rms(copy);
              const speech = rms >= Math.max(0.008, noiseFloor * 1.6);
              if (!speech) {
                noiseFloor = noiseFloor * 0.98 + rms * 0.02;
              }

              if (utteranceStartMs === null) {
                if (speech) {
                  utteranceStartMs = now - Math.round((preRollSamples / TARGET_SAMPLE_RATE) * 1000);
                  lastPartialAtMs = now;
                  for (const pr of preRoll) {
                    frames.push(pr);
                    totalSamples += pr.length;
                  }
                  preRoll = [];
                  preRollSamples = 0;
                  frames.push(copy);
                  totalSamples += copy.length;
                  silenceStartMs = null;
                } else {
                  preRoll.push(copy);
                  preRollSamples += copy.length;
                  while (preRollSamples > PRE_ROLL_SAMPLES && preRoll.length > 0) {
                    const dropped = preRoll.shift();
                    if (dropped) preRollSamples -= dropped.length;
                  }
                }
                continue;
              }

              frames.push(copy);
              totalSamples += copy.length;
              if (speech) {
                silenceStartMs = null;
              } else if (silenceStartMs === null) {
                silenceStartMs = now;
              }

              const durationMs = (totalSamples / TARGET_SAMPLE_RATE) * 1000;
              const silenceMs = silenceStartMs === null ? 0 : now - silenceStartMs;

              if (durationMs >= MAX_UTTERANCE_MS || silenceMs >= SILENCE_FINALIZE_MS) {
                await flush("final");
              } else if (!inFlightPartial && now - lastPartialAtMs >= PARTIAL_EMIT_INTERVAL_MS && durationMs >= 1200) {
                inFlightPartial = true;
                void flush("partial").finally(() => {
                  inFlightPartial = false;
                });
              }
            }
          } catch {
            /* stream ended or track unsubscribed */
          } finally {
            if (utteranceStartMs !== null && totalSamples > 0) {
              await flush("final").catch(() => {});
            }
            entry.activeStreams.delete(cancel);
          }
        })();
      };

      room
        .on(rtc.RoomEvent.TrackSubscribed, (track, _pub, participant) => {
          attachAudioTrack(track, participant.identity);
        })
        .on(rtc.RoomEvent.Disconnected, () => {
          entry.connected = false;
          entry.connecting = false;
          for (const cancelStream of entry.activeStreams) {
            cancelStream();
          }
          entry.activeStreams.clear();
          if (registry.get(key) === entry) {
            registry.delete(key);
          }
        });

      await room.connect(serverLivekitWsUrl(), token, { autoSubscribe: true, dynacast: false });
      if (entry.stopped) {
        await room.disconnect().catch(() => {});
        return;
      }

      entry.connected = true;
      entry.connecting = false;
      transcriptLog("server LiveKit STT worker connected", {
        discussionId,
        breakoutRoom: breakoutRoom ?? "main",
      });
    } catch (error) {
      entry.connected = false;
      entry.connecting = false;
      if (registry.get(key) === entry) {
        registry.delete(key);
      }
      transcriptWarn("server LiveKit STT worker failed to connect", {
        discussionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  })();

  return entry.connected;
}

/** Disconnects and cleans up all server-side STT workers for a discussion. */
export async function stopRoomSttWorker(discussionId: string): Promise<void> {
  const registry = getRegistry();
  const tasks: Promise<void>[] = [];
  for (const [key, entry] of registry.entries()) {
    if (key.startsWith(`${discussionId}:`)) {
      registry.delete(key);
      tasks.push(entry.disconnect());
    }
  }
  await Promise.allSettled(tasks);
}
