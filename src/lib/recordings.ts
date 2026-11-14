import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { env } from "./env";

/**
 * Session recording storage.
 *
 * The audio of a discussion is captured in the moderator's browser (the one
 * client everybody's tracks reach) and uploaded once the discussion ends. The
 * bytes are written to the recording store on disk and the matching `Recording`
 * row records who captured them, how long they are and where they live. Keeping
 * the bytes out of Postgres keeps the database small and lets playback be served
 * with `Range` requests instead of loading a whole session into memory twice.
 *
 * The pure helpers at the top are unit tested; the filesystem functions are the
 * only part that touches disk.
 */

/** Audio containers a browser MediaRecorder realistically produces. */
const MIME_EXTENSIONS: Record<string, string> = {
  "audio/webm": "webm",
  "audio/ogg": "ogg",
  "audio/mp4": "m4a",
  "audio/aac": "m4a",
  "audio/mpeg": "mp3",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
};

export const DEFAULT_RECORDING_MIME = "audio/webm";

/**
 * Maps a MediaRecorder MIME type to a file extension. MediaRecorder reports
 * codec parameters with the container (`audio/webm;codecs=opus`), and browsers
 * disagree about casing, so both are normalised before the lookup.
 */
export function extensionForMimeType(mimeType: string): string {
  return MIME_EXTENSIONS[containerOf(mimeType)] ?? "webm";
}

/** True when the container is one we are willing to store. */
export function isSupportedRecordingMime(mimeType: string): boolean {
  return containerOf(mimeType) in MIME_EXTENSIONS;
}

/** The container part of a MIME type, lowercased: `audio/webm;codecs=opus` → `audio/webm`. */
function containerOf(mimeType: string): string {
  return mimeType.split(";")[0].trim().toLowerCase();
}

/** Storage keys we are willing to resolve to a path on disk. */
const STORAGE_KEY_PATTERN = /^[a-z0-9_-]+\/[a-z0-9_-]+\.(webm|ogg|m4a|mp3|wav)$/;

/**
 * Builds the storage key for a recording: one directory per discussion, one
 * file per recording. Container-derived rather than client-supplied so a
 * participant cannot choose where their upload lands.
 */
export function recordingStorageKey(
  discussionId: string,
  recordingId: string,
  mimeType: string,
): string {
  return `${discussionId}/${recordingId}.${extensionForMimeType(mimeType)}`;
}

/** True when a key is exactly `"<discussion>/<recording>.<ext>"`. */
export function isSafeStorageKey(key: string): boolean {
  return STORAGE_KEY_PATTERN.test(key);
}

/** Human-readable file size for the report page. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 MB";
  const mb = bytes / (1024 * 1024);
  if (mb < 1) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${mb.toFixed(mb < 10 ? 1 : 0)} MB`;
}

/**
 * Absolute path of the recording store, resolved against the app root.
 *
 * `RECORDING_DIR` is deployment configuration, so the path is not known when the
 * bundle is built. The ignore comment keeps the bundler from tracing the whole
 * project into the server output looking for files that only exist at runtime.
 */
export function recordingStoreRoot(): string {
  return path.resolve(/* turbopackIgnore: true */ process.cwd(), env.recordingDir);
}

/**
 * Resolves a storage key to an absolute path, refusing anything that is not a
 * plain `discussion/file.ext` key. An absolute or traversing key can therefore
 * never reach outside the store.
 */
export function resolveRecordingPath(key: string): string {
  if (!isSafeStorageKey(key)) {
    throw new Error(`Unsafe recording storage key: ${key}`);
  }
  const root = recordingStoreRoot();
  const target = path.resolve(/* turbopackIgnore: true */ root, key);
  if (!target.startsWith(root + path.sep)) {
    throw new Error(`Recording path escapes the store: ${key}`);
  }
  return target;
}

/** Writes a recording to the store, creating the discussion directory. */
export async function saveRecording(key: string, bytes: Uint8Array): Promise<void> {
  const target = resolveRecordingPath(key);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, bytes);
}

/** Reads a stored recording. Returns null when the file is gone. */
export async function loadRecording(key: string): Promise<Buffer | null> {
  try {
    return await readFile(resolveRecordingPath(key));
  } catch {
    return null;
  }
}

/** Deletes a stored recording. A missing file is not an error. */
export async function removeRecording(key: string): Promise<void> {
  try {
    await unlink(resolveRecordingPath(key));
  } catch {
    /* the row is the source of truth; a missing file needs no cleanup */
  }
}

/**
 * Storage key behind the recording's route URL, used by the reports page and
 * the player. Returns null when the recording has no stored file yet.
 */
export function recordingDownloadUrl(discussionId: string, recordingId: string): string {
  return `/api/discussions/${discussionId}/recordings/${recordingId}`;
}

/**
 * Parses a single-range `Range: bytes=…` header against a known file size.
 *
 * Audio playback seeks by asking for a byte range, and a `206` answer is what
 * makes the scrubber work on a long session. Returns null when the header is
 * absent or unsatisfiable, in which case the whole file is sent instead.
 */
export function parseByteRange(
  header: string | null,
  size: number,
): { start: number; end: number } | null {
  if (!header || size <= 0) return null;

  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;
  const [, rawStart, rawEnd] = match;
  if (rawStart === "" && rawEnd === "") return null;

  let start: number;
  let end: number;
  if (rawStart === "") {
    // Suffix form: the last N bytes of the file.
    const suffix = Number(rawEnd);
    if (!Number.isFinite(suffix) || suffix <= 0) return null;
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(rawStart);
    end = rawEnd === "" ? size - 1 : Number(rawEnd);
  }

  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  if (start > end || start >= size) return null;
  return { start, end: Math.min(end, size - 1) };
}
