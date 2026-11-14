/**
 * Encodes raw mono PCM samples as a WAV file.
 *
 * The browser captures the microphone through the Web Audio API, which hands
 * back raw float samples. Sending those on directly would not be decodable —
 * audio needs a container — and the obvious container for a browser,
 * WebM/Opus from `MediaRecorder`, is produced differently by every browser and
 * is not a format the transcription model accepts. A WAV header is a few dozen
 * bytes and is understood everywhere, so the clip that reaches the server is
 * always the same shape regardless of which browser recorded it.
 *
 * Pure and dependency-free so the exact header can be asserted in a test.
 */

/** Bytes per sample written: 16-bit signed little-endian. */
const BYTES_PER_SAMPLE = 2;

/** Clamps a float sample to the signed 16-bit range without wrapping. */
function toPcm16(sample: number): number {
  const clamped = Math.max(-1, Math.min(1, sample));
  // Asymmetric on purpose: -1 maps to -32768, +1 saturates at 32767.
  return clamped < 0 ? Math.round(clamped * 0x8000) : Math.round(clamped * 0x7fff);
}

/**
 * Wraps mono float samples in a canonical 44-byte WAV header.
 *
 * `sampleRate` is written as given rather than resampled, so the decoder is
 * told the truth about the data it receives.
 */
export function encodeWav(samples: Float32Array, sampleRate: number): Uint8Array<ArrayBuffer> {
  const dataBytes = samples.length * BYTES_PER_SAMPLE;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);

  const writeText = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
  };

  writeText(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true); // size of everything after this field
  writeText(8, "WAVE");

  writeText(12, "fmt ");
  view.setUint32(16, 16, true); // PCM header length
  view.setUint16(20, 1, true); // format 1 = uncompressed PCM
  view.setUint16(22, 1, true); // one channel: the participant's own voice
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * BYTES_PER_SAMPLE, true); // byte rate
  view.setUint16(32, BYTES_PER_SAMPLE, true); // block align
  view.setUint16(34, 8 * BYTES_PER_SAMPLE, true); // bits per sample

  writeText(36, "data");
  view.setUint32(40, dataBytes, true);

  let offset = 44;
  for (let i = 0; i < samples.length; i += 1) {
    view.setInt16(offset, toPcm16(samples[i]), true);
    offset += BYTES_PER_SAMPLE;
  }

  return new Uint8Array(buffer);
}

/** Peak absolute amplitude, 0–1. Used to tell speech from an empty room. */
export function peakAmplitude(samples: Float32Array): number {
  let peak = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const value = Math.abs(samples[i]);
    if (value > peak) peak = value;
  }
  return peak;
}
