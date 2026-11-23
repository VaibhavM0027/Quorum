import { describe, expect, it } from "vitest";
import { resolveLivekitServerUrl } from "@/lib/livekit";

describe("LiveKit server endpoint selection", () => {
  it("uses the cloud HTTPS endpoint when only the browser URL overrides the local default", () => {
    expect(
      resolveLivekitServerUrl(
        "http://127.0.0.1:7880",
        "wss://example.livekit.cloud",
      ),
    ).toBe("https://example.livekit.cloud");
  });

  it("preserves an explicitly configured server endpoint", () => {
    expect(
      resolveLivekitServerUrl(
        "https://internal-livekit.example.com",
        "wss://example.livekit.cloud",
      ),
    ).toBe("https://internal-livekit.example.com");
  });

  it("keeps local LiveKit development local", () => {
    expect(
      resolveLivekitServerUrl(
        "http://127.0.0.1:7880",
        "ws://localhost:7880",
      ),
    ).toBe("http://127.0.0.1:7880");
  });
});
