// PCM16 / base64 helpers shared by the Realtime session and demo injection.

export const SAMPLE_RATE = 24000;

export function floatToPcm16(float32) {
  const out = new Int16Array(float32.length);
  for (let i = 0; i < float32.length; i++) {
    const s = Math.max(-1, Math.min(1, float32[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

export function base64FromBytes(bytes) {
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

export function bytesFromBase64(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

export const pcm16ToBase64 = (pcm16) =>
  base64FromBytes(new Uint8Array(pcm16.buffer, pcm16.byteOffset, pcm16.byteLength));

// Decode any browser-supported audio (mp3/wav/…) to mono 24 kHz PCM16.
// OfflineAudioContext resamples during decode.
export async function decodeToPcm16(arrayBuffer) {
  const ctx = new OfflineAudioContext(1, 1, SAMPLE_RATE);
  const audio = await ctx.decodeAudioData(arrayBuffer);
  return floatToPcm16(audio.getChannelData(0));
}

export function rms(float32) {
  let sum = 0;
  for (let i = 0; i < float32.length; i++) sum += float32[i] * float32[i];
  return Math.sqrt(sum / (float32.length || 1));
}
