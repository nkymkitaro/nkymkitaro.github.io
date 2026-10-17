// audio-input.js: マイクの音を取り込む。試作用。
// - 気合や打突音のような急に大きくなる音が削られないよう、エコー除去・雑音抑制・自動音量調整はすべてオフにする
// - 許可は、試作のページだけで求める(本番のVARはカメラだけ)
const CONSTRAINTS = {
  audio: {
    echoCancellation: false, noiseSuppression: false, autoGainControl: false,
    channelCount: { ideal: 1 },
  },
};

// 許可を先に取っておく(録画を始める合図が来たときに、確認の画面が出て止まらないように)。すぐ閉じる
export async function ensureMicPermission() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return { ok: false, reason: 'この端末のブラウザでは、マイクが使えません' };
  try {
    const s = await navigator.mediaDevices.getUserMedia(CONSTRAINTS);
    s.getTracks().forEach((t) => t.stop());
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: err && err.name === 'NotAllowedError' ? 'マイクの許可がありません' : `マイクが使えません(${err && err.message ? err.message : err})` };
  }
}

// 録画のあいだ開いておくマイク。止めるときは close() を呼ぶ
export async function openMic() {
  if (typeof window !== 'undefined' && window.__labNoMic) return { error: 'マイクが使えません(試験用に切っています)' };
  if (typeof window !== 'undefined' && typeof window.__labMicTrack === 'function') { const t = window.__labMicTrack(); return { track: t, settings: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 }, close: () => {} }; } // 試験用: 擬似の音を使う
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return { error: 'この端末のブラウザでは、マイクが使えません' };
  try {
    const stream = await navigator.mediaDevices.getUserMedia(CONSTRAINTS);
    const track = stream.getAudioTracks()[0];
    if (!track) { stream.getTracks().forEach((t) => t.stop()); return { error: 'マイクの音が取れません' }; }
    const settings = track.getSettings ? track.getSettings() : {};
    return { track, settings, close: () => stream.getTracks().forEach((t) => t.stop()) };
  } catch (err) {
    return { error: err && err.name === 'NotAllowedError' ? 'マイクの許可がありません' : `マイクが使えません(${err && err.message ? err.message : err})` };
  }
}
