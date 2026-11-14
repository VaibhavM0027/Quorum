import { env } from "./env";

/**
 * Minimal server-side Google Gemini client.
 *
 * Every AI feature in Quorum goes through here so that model selection, quota,
 * timeouts, retries and error handling live in one place. Keys never reach the
 * browser — this module is only imported from API routes (Node runtime).
 *
 * Model policy: Google retires older models for new API keys without notice, so
 * we call a rolling alias as the fast model and always keep a fallback model
 * configured. Transient capacity errors (503/429) are retried once, then the
 * caller falls back to the next model in the chain.
 */

export class AiUnavailableError extends Error {
  status = 503;
  constructor(message = "The AI assistant is not configured.") {
    super(message);
    this.name = "AiUnavailableError";
  }
}

export class AiRequestError extends Error {
  status: number;
  constructor(message: string, status = 502) {
    super(message);
    this.name = "AiRequestError";
    this.status = status;
  }
}

/** True when an API key is configured and AI has not been switched off. */
export function geminiAvailable(): boolean {
  return env.aiEnabled && Boolean(env.geminiKey);
}

/** Errors worth retrying on the same model before falling back. */
const TRANSIENT_STATUSES = new Set([429, 500, 502, 503, 504]);

type GeminiPayload = {
  candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  error?: { message?: string; status?: string };
};

export type GeminiCallOptions = {
  prompt: string;
  system?: string;
  /** "fast" uses GEMINI_FAST_MODEL, "smart" uses GEMINI_SMART_MODEL. */
  tier?: "fast" | "smart";
  /** Ask the model to reply with parseable JSON. */
  json?: boolean;
  /**
   * A short audio clip sent inline alongside the prompt, as base64.
   *
   * Used for speech to text: the transcription agent sends each finished
   * utterance here as uncompressed WAV, which is a container the model accepts
   * without a codec.
   */
  audio?: { mimeType: string; base64: string };
  temperature?: number;
  maxOutputTokens?: number;
  timeoutMs?: number;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Models to try, in order. The fast model is always the last resort. */
function modelChain(tier: "fast" | "smart"): string[] {
  const primary = tier === "smart" ? env.geminiSmartModel : env.geminiFastModel;
  return [primary, env.geminiFastModel].filter((model, index, all) => model && all.indexOf(model) === index);
}

async function requestOnce(model: string, options: GeminiCallOptions): Promise<string> {
  const base = env.geminiBaseUrl.replace(/\/$/, "");
  const url = `${base}/v1beta/models/${model}:generateContent`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 25_000);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-goog-api-key": env.geminiKey,
      },
      body: JSON.stringify({
        contents: [
          {
            role: "user",
            parts: [
              // Audio first, then the instruction that talks about it.
              ...(options.audio
                ? [{ inlineData: { mimeType: options.audio.mimeType, data: options.audio.base64 } }]
                : []),
              { text: options.prompt },
            ],
          },
        ],
        ...(options.system ? { systemInstruction: { parts: [{ text: options.system }] } } : {}),
        generationConfig: {
          temperature: options.temperature ?? 0.4,
          maxOutputTokens: options.maxOutputTokens ?? 2048,
          ...(options.json ? { responseMimeType: "application/json" } : {}),
        },
      }),
      signal: controller.signal,
    });

    const payload = (await response.json().catch(() => null)) as GeminiPayload | null;

    if (!response.ok) {
      throw new AiRequestError(
        payload?.error?.message ?? `Gemini request failed (${response.status})`,
        response.status,
      );
    }

    const text =
      payload?.candidates?.[0]?.content?.parts
        ?.map((part) => part.text ?? "")
        .join("")
        .trim() ?? "";

    if (!text) throw new AiRequestError("Gemini returned an empty response.");
    return text;
  } catch (error) {
    if (error instanceof AiRequestError) throw error;
    if (error instanceof Error && error.name === "AbortError") {
      throw new AiRequestError("Gemini request timed out.", 504);
    }
    throw new AiRequestError(error instanceof Error ? error.message : "Gemini request failed.");
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Calls Gemini, retrying transient failures and falling back across models.
 * Returns the concatenated text of the first successful candidate.
 */
export async function callGemini(options: GeminiCallOptions): Promise<string> {
  if (!geminiAvailable()) throw new AiUnavailableError();

  const models = modelChain(options.tier ?? "fast");
  let lastError: unknown = null;

  for (const model of models) {
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        return await requestOnce(model, options);
      } catch (error) {
        lastError = error;
        if (!(error instanceof AiRequestError)) throw error;

        const transient = TRANSIENT_STATUSES.has(error.status);
        if (transient && attempt === 1) {
          await sleep(700);
          continue;
        }
        break; // move on to the next model in the chain
      }
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new AiRequestError("Gemini request failed on every configured model.");
}

/**
 * Pulls the first JSON value out of a model reply.
 * Models occasionally wrap JSON in prose or code fences, so we scan for the
 * outermost braces/brackets instead of trusting the whole string.
 */
export function parseJsonReply<T>(raw: string): T {
  const cleaned = raw
    .replace(/^```(?:json)?/i, "")
    .replace(/```$/i, "")
    .trim();

  try {
    return JSON.parse(cleaned) as T;
  } catch {
    /* fall through to scanning */
  }

  const objectStart = cleaned.indexOf("{");
  const arrayStart = cleaned.indexOf("[");
  const start =
    objectStart === -1 ? arrayStart : arrayStart === -1 ? objectStart : Math.min(objectStart, arrayStart);
  if (start === -1) throw new AiRequestError("Gemini reply did not contain JSON.");

  const openChar = cleaned[start];
  const closeChar = openChar === "{" ? "}" : "]";
  const end = cleaned.lastIndexOf(closeChar);
  if (end <= start) throw new AiRequestError("Gemini reply contained malformed JSON.");

  try {
    return JSON.parse(cleaned.slice(start, end + 1)) as T;
  } catch {
    throw new AiRequestError("Gemini reply contained malformed JSON.");
  }
}
