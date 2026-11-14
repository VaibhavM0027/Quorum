import { describe, expect, it } from "vitest";
import {
  extensionForMimeType,
  formatBytes,
  isSafeStorageKey,
  isSupportedRecordingMime,
  parseByteRange,
  recordingDownloadUrl,
  recordingStorageKey,
} from "@/lib/recordings";

describe("recording storage", () => {
  describe("extensionForMimeType", () => {
    it("maps the containers a browser records to a file extension", () => {
      expect(extensionForMimeType("audio/webm")).toBe("webm");
      expect(extensionForMimeType("audio/ogg")).toBe("ogg");
      expect(extensionForMimeType("audio/mp4")).toBe("m4a");
      expect(extensionForMimeType("audio/wav")).toBe("wav");
    });

    it("ignores codec parameters and casing", () => {
      expect(extensionForMimeType("audio/webm;codecs=opus")).toBe("webm");
      expect(extensionForMimeType("AUDIO/OGG")).toBe("ogg");
      expect(extensionForMimeType(" audio/mp4 ; codecs=mp4a.40.2")).toBe("m4a");
    });

    it("falls back to webm for anything it does not know", () => {
      expect(extensionForMimeType("video/mp4")).toBe("webm");
      expect(extensionForMimeType("")).toBe("webm");
    });
  });

  describe("isSupportedRecordingMime", () => {
    it("accepts audio containers", () => {
      expect(isSupportedRecordingMime("audio/webm;codecs=opus")).toBe(true);
      expect(isSupportedRecordingMime("audio/mpeg")).toBe(true);
    });

    it("rejects anything that is not a known audio container", () => {
      expect(isSupportedRecordingMime("video/webm")).toBe(false);
      expect(isSupportedRecordingMime("text/html")).toBe(false);
    });
  });

  describe("recordingStorageKey", () => {
    it("puts each discussion in its own directory", () => {
      expect(recordingStorageKey("gd123", "rec456", "audio/webm")).toBe("gd123/rec456.webm");
      expect(recordingStorageKey("gd123", "rec456", "audio/mp4")).toBe("gd123/rec456.m4a");
    });

    it("never produces a key that escapes the store", () => {
      const key = recordingStorageKey("../../etc", "../../passwd", "audio/webm");
      expect(isSafeStorageKey(key)).toBe(false);
    });
  });

  describe("isSafeStorageKey", () => {
    it("accepts exactly a discussion directory and a recording file", () => {
      expect(isSafeStorageKey("gd123/rec456.webm")).toBe(true);
      expect(isSafeStorageKey("gd123/rec456.m4a")).toBe(true);
    });

    it("rejects traversal, absolute paths, sub-directories and odd extensions", () => {
      expect(isSafeStorageKey("../gd123/rec456.webm")).toBe(false);
      expect(isSafeStorageKey("gd123/../../rec456.webm")).toBe(false);
      expect(isSafeStorageKey("/etc/passwd.webm")).toBe(false);
      expect(isSafeStorageKey("gd123/nested/rec456.webm")).toBe(false);
      expect(isSafeStorageKey("gd123\\rec456.webm")).toBe(false);
      expect(isSafeStorageKey("gd123/rec456.exe")).toBe(false);
      expect(isSafeStorageKey("gd123/rec456.webm.js")).toBe(false);
    });
  });

  describe("formatBytes", () => {
    it("reports zero for an empty or nonsensical size", () => {
      expect(formatBytes(0)).toBe("0 MB");
      expect(formatBytes(Number.NaN)).toBe("0 MB");
    });

    it("uses kilobytes below a megabyte", () => {
      expect(formatBytes(2048)).toBe("2 KB");
      expect(formatBytes(512 * 1024)).toBe("512 KB");
    });

    it("uses megabytes above a megabyte", () => {
      expect(formatBytes(1024 * 1024)).toBe("1.0 MB");
      expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MB");
      expect(formatBytes(24 * 1024 * 1024)).toBe("24 MB");
    });
  });

  describe("parseByteRange", () => {
    it("returns null when there is nothing to serve a range from", () => {
      expect(parseByteRange(null, 100)).toBeNull();
      expect(parseByteRange("bytes=0-10", 0)).toBeNull();
      expect(parseByteRange("bytes=-", 100)).toBeNull();
      expect(parseByteRange("bytes=abc", 100)).toBeNull();
      expect(parseByteRange("items=0-10", 100)).toBeNull();
    });

    it("parses a closed range", () => {
      expect(parseByteRange("bytes=0-49", 100)).toEqual({ start: 0, end: 49 });
      expect(parseByteRange("bytes=0-0", 100)).toEqual({ start: 0, end: 0 });
    });

    it("parses an open-ended range to the end of the file", () => {
      expect(parseByteRange("bytes=50-", 100)).toEqual({ start: 50, end: 99 });
    });

    it("parses a suffix range as the last N bytes", () => {
      expect(parseByteRange("bytes=-20", 100)).toEqual({ start: 80, end: 99 });
      expect(parseByteRange("bytes=-500", 100)).toEqual({ start: 0, end: 99 });
    });

    it("clamps an end past the file instead of failing", () => {
      expect(parseByteRange("bytes=90-200", 100)).toEqual({ start: 90, end: 99 });
    });

    it("rejects unsatisfiable or inverted ranges", () => {
      expect(parseByteRange("bytes=100-200", 100)).toBeNull();
      expect(parseByteRange("bytes=50-10", 100)).toBeNull();
    });
  });

  describe("recordingDownloadUrl", () => {
    it("points at the recording's streaming route", () => {
      expect(recordingDownloadUrl("gd123", "rec456")).toBe("/api/discussions/gd123/recordings/rec456");
    });
  });
});
