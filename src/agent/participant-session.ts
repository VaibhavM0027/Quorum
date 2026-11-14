import {
  AudioStream,
  type AudioFrame,
  type RemoteAudioTrack,
} from "@livekit/rtc-node";
import { transcribeAudioClip } from "@/lib/stt";
import { ingestTranscriptChunk } from "@/lib/transcript-ingest";
import { transcriptLog, transcriptWarn } from "@/lib/debug-log";
import { int16ToMonoFloat, UtteranceSegmenter, type Utterance } from "./utterance";

/**
 * One participant's microphone, from the LiveKit track to a stored transcript.
 *
 * There is exactly one of these per published audio track, and that is what
 * keeps attribution honest: the audio, the speech recognition, the timing and
 * the database row all belong to a single identity. Two participants talking at
 * once are two instances running side by side, not one mixed stream that has to
 * be guessed apart afterwards.
 *
 * Utterances are transcribed one at a time per participant, so a slow model
 * call for a long sentence cannot let a later one overtake it and land out of
 * order in the transcript.
 */

/** Mono 16 kHz is plenty for speech and keeps every clip small. */
export const TARGET_SAMPLE_RATE = 16_000;

/** How often the frame counter is logged, so a silent track is still visible. */
const FRAME_LOG_EVERY = 500;

export type SpeakerRef = { id: string; displayName: string };

export type ParticipantTranscriberParams = {
  /** Discussion row the segment belongs to. */
  discussionId: string;
  /** LiveKit room name, e.g. `discussion-<id>` or a breakout room. */
  roomId: string;
  /** LiveKit identity of the speaker — the account they joined with. */
  participantIdentity: string;
  /** LiveKit SID of the audio track, so a stored row can be traced to a track. */
  trackId: string;
  /** Who the participant is in the discussion, resolved before audio starts. */
  speaker: SpeakerRef;
  /** The subscribed microphone track to read. */
  track: RemoteAudioTrack;
};

export class ParticipantTranscriber {
  private readonly params: ParticipantTranscriberParams;

  private reader: ReadableStreamDefaultReader<AudioFrame> | null = null;
  private segmenter: UtteranceSegmenter | null = null;
  private stopped = false;
  private frames = 0;
  private utterances = 0;
  /** Serialises storage so segments for one speaker can never land out of order. */
  private chain: Promise<void> = Promise.resolve();

  constructor(params: ParticipantTranscriberParams) {
    this.params = params;
  }

  /** Identifies this speaker in every log line the worker emits for them. */
  private get fields(): Record<string, unknown> {
    return {
      roomId: this.params.roomId,
      participantId: this.params.speaker.id,
      participantIdentity: this.params.participantIdentity,
      participantName: this.params.speaker.displayName,
      trackId: this.params.trackId,
    };
  }

  /** Subscribes to the track and begins feeding it to the recogniser. */
  start(): void {
    const stream = new AudioStream(this.params.track, {
      sampleRate: TARGET_SAMPLE_RATE,
      numChannels: 1,
    });
    this.reader = stream.getReader();
    this.segmenter = new UtteranceSegmenter(TARGET_SAMPLE_RATE);

    transcriptLog("STT pipeline attached to participant audio", {
      ...this.fields,
      sampleRate: TARGET_SAMPLE_RATE,
    });

    void this.pump();
  }

  /**
   * Detaches from the track, keeping whatever the participant had said.
   *
   * Called for every way audio can stop — mute, unsubscribe, disconnect,
   * room close — so a sentence in progress is never thrown away just because
   * the connection dropped mid-word.
   */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;

    const pending = this.segmenter?.flush();
    if (pending) this.enqueue(pending);

    transcriptLog("participant audio detached", {
      ...this.fields,
      frames: this.frames,
      utterances: this.utterances,
    });

    void this.reader?.cancel().catch(() => {});
    this.reader = null;
  }

  private async pump(): Promise<void> {
    try {
      for (;;) {
        const { done, value } = await this.reader!.read();
        if (done) break;
        this.handle(value);
      }
    } catch (error) {
      if (!this.stopped) {
        transcriptWarn("participant audio stream failed", {
          ...this.fields,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    } finally {
      // The track ended on its own (unsubscribed, or the participant left)
      // rather than through stop(); keep whatever was said.
      this.stop();
    }
  }

  private handle(frame: AudioFrame): void {
    this.frames += 1;
    if (this.frames === 1 || this.frames % FRAME_LOG_EVERY === 0) {
      transcriptLog("audio frames received", {
        ...this.fields,
        frames: this.frames,
        sampleRate: frame.sampleRate,
        channels: frame.channels,
      });
    }

    const mono = int16ToMonoFloat(frame.data, frame.channels);
    const utterance = this.segmenter?.push(mono, Date.now());
    if (utterance) this.enqueue(utterance);
  }

  private enqueue(utterance: Utterance): void {
    this.chain = this.chain
      .then(() => this.store(utterance))
      .catch((error) => {
        transcriptWarn("transcript could not be stored", {
          ...this.fields,
          error: error instanceof Error ? error.message : String(error),
        });
      });
  }

  private async store(utterance: Utterance): Promise<void> {
    this.utterances += 1;
    const index = this.utterances;

    transcriptLog("STT processing started", {
      ...this.fields,
      utterance: index,
      durationMs: utterance.durationMs,
      clipBytes: utterance.wav.byteLength,
    });

    const text = await transcribeAudioClip({ data: utterance.wav, mimeType: "audio/wav" });

    transcriptLog("STT processing completed", {
      ...this.fields,
      utterance: index,
      characters: text.length,
    });

    // Silence is a normal outcome — a cough, a chair scrape, an open
    // microphone in an empty room — and is simply not stored.
    if (!text) return;

    transcriptLog("transcript received", {
      ...this.fields,
      utterance: index,
      transcriptText: text,
    });

    const result = await ingestTranscriptChunk({
      discussionId: this.params.discussionId,
      participant: this.params.speaker,
      text,
      startedAt: utterance.startedAt,
      endedAt: utterance.endedAt,
      durationMs: utterance.durationMs,
      source: "server",
      origin: {
        roomId: this.params.roomId,
        participantIdentity: this.params.participantIdentity,
        trackId: this.params.trackId,
      },
    });

    if (!result.ok) {
      transcriptWarn("transcript rejected by the store", {
        ...this.fields,
        utterance: index,
        status: result.status,
        error: result.error,
      });
    }
  }
}
