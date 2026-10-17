// mux.js: 録画の区切り(方式B)を、カメラごとに1本のMP4へ組み立てる。試作用。
// - 圧縮済みの映像と音を、そのままMP4の箱に並べるだけ(作り直さない)。数秒で終わり、端末は熱くならない
// - 使う部品: mp4-muxer 5.2.2(MITライセンス)。lab/js/vendor/ に置いたものだけを使い、外部のサーバーからは読み込まない
import { Muxer, ArrayBufferTarget } from './vendor/mp4-muxer.mjs';
import { parseContainer, B_MIME } from './recorder-b.js';

function fromBase64(b64) {
  if (!b64) return undefined;
  const s = atob(b64);
  const u = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i);
  return u;
}

const videoKind = (codec) => (codec.startsWith('avc') ? 'avc' : codec.startsWith('vp09') ? 'vp9' : codec.startsWith('av01') ? 'av1' : codec.startsWith('hev') || codec.startsWith('hvc') ? 'hevc' : null);
const audioKind = (codec) => (codec.startsWith('mp4a') ? 'aac' : codec === 'opus' ? 'opus' : null);

// segs: 1台ぶんの区切り(store の記録)。onProgress(0〜1)。shouldCancel() が true を返したら中止する
// 戻り値: { blob, mime, ext, hasAudio, videoCodec, audioCodec, frames, audioChunks }
export async function buildCameraMp4(segs, { onProgress = () => {}, shouldCancel = () => false } = {}) {
  const list = segs.slice().sort((a, b) => a.t0 - b.t0);
  if (!list.length || list.some((s) => s.mime !== B_MIME)) throw new Error('この録画は、MP4にまとめられない形式です');
  let muxer = null;
  let target = null;
  let vFirst = true; let aFirst = true;
  let frames = 0; let audioChunks = 0; let lastV = -1; let lastA = -1;
  let hasAudio = false; let vCodec = ''; let aCodec = '';
  for (let i = 0; i < list.length; i++) {
    if (shouldCancel()) throw Object.assign(new Error('中止しました'), { cancelled: true });
    const { meta, chunks, audioChunks: ach } = await parseContainer(list[i].blob);
    if (!muxer) {
      const vc = meta.config;
      const kind = videoKind(vc.codec);
      if (!kind) throw new Error(`MP4に入れられない映像です(${vc.codec})`);
      const aud = meta.audio && meta.audio.config ? meta.audio.config : null;
      const akind = aud ? audioKind(aud.codec) : null;
      target = new ArrayBufferTarget();
      muxer = new Muxer({
        target, fastStart: 'in-memory', firstTimestampBehavior: 'cross-track-offset',
        video: { codec: kind, width: vc.codedWidth, height: vc.codedHeight },
        ...(akind ? { audio: { codec: akind, numberOfChannels: aud.numberOfChannels || 1, sampleRate: aud.sampleRate } } : {}),
      });
      hasAudio = !!akind; vCodec = vc.codec; aCodec = aud ? aud.codec : '';
      muxer.__vc = vc; muxer.__aud = akind ? aud : null;
    }
    const vc = muxer.__vc;
    for (const c of chunks) {
      if (c.ts <= lastV) continue; // 時刻が戻るコマは入れない
      const m = vFirst ? { decoderConfig: { codec: vc.codec, description: fromBase64(vc.description), colorSpace: { fullRange: false }, codedWidth: vc.codedWidth, codedHeight: vc.codedHeight } } : undefined;
      muxer.addVideoChunkRaw(c.data, c.type, c.ts, c.dur, m);
      vFirst = false; lastV = c.ts; frames++;
    }
    if (muxer.__aud) {
      const aud = muxer.__aud;
      for (const c of ach) {
        if (c.ts <= lastA) continue;
        const m = aFirst ? { decoderConfig: { codec: aud.codec, description: fromBase64(aud.description), sampleRate: aud.sampleRate, numberOfChannels: aud.numberOfChannels || 1 } } : undefined;
        muxer.addAudioChunkRaw(c.data, 'key', c.ts, c.dur, m);
        aFirst = false; lastA = c.ts; audioChunks++;
      }
    }
    onProgress((i + 1) / list.length);
    await new Promise((r) => setTimeout(r, 0)); // 画面が固まらないように、区切りごとに一息つく
  }
  muxer.finalize();
  const blob = new Blob([target.buffer], { type: 'video/mp4' });
  return { blob, mime: 'video/mp4', ext: 'mp4', hasAudio, videoCodec: vCodec, audioCodec: aCodec, frames, audioChunks };
}
