// relay.js: 中継(携帯回線どうしをつなぐ。TURN)の小さな試作(2026-10-28。依頼: 2026-10-28-to-coder-relay-prototype.md)。
// - URL に ?relay=1 を付けて開いたときだけ有効。付けないときは、今までと同じ動き(このファイルは何もしない)
// - 中継は最後の手段。接続の仕組み(ICE)は、直接の経路を先に試す。直接つながれないときだけ中継を通る
// - 合言葉は relay/worker.js(Cloudflare Workers)から取る。取れなかったときは、今の設定で続ける(画面にエラーは出さない)
// - 中継を通っているときは、映像を送る側(子機)が送る量を下げ、親機・子機の両方に1回だけ知らせる
// - 計測(GA4)には何も足さない。経路は「試験用」の数値のコピーにだけ載せる
import { showToast } from './toast.js';

// 合言葉を発行する Worker の URL(relay/README.md の手順で作ったあと、ここに入れる。空のあいだは、?relay=1 を付けても何も起きない)
export const RELAY_WORKER_URL = '';

const RELAY_MAX_BITRATE = 500000; // 中継のときの映像の上限(約0.5Mbps。1時間あたり約0.2GBの見込み)
const POLL_MS = 3000;
const NOTICE_MS = 5000;
const NOTICE_FADE_MS = 500;
const BASE_ICE = [{ urls: 'stun:stun.l.google.com:19302' }];

export function isRelayTrial() {
  return /[?&]relay=1(&|$)/.test(window.location.search);
}

let extraIce = null; // 取れた合言葉(iceServers)

// ページを開いたときに1回呼ぶ。待たない(取れた時点から使う)
export function prefetchRelayConfig() {
  if (!isRelayTrial() || !RELAY_WORKER_URL) return;
  const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), 5000) : null;
  fetch(RELAY_WORKER_URL, { signal: ctrl ? ctrl.signal : undefined })
    .then((r) => (r.ok ? r.json() : null))
    .then((data) => { if (data && Array.isArray(data.iceServers) && data.iceServers.length) extraIce = data.iceServers; })
    .catch(() => { /* 取れなければ、今の設定で続ける */ })
    .finally(() => clearTimeout(timer));
}

// new Peer(...) の最後の引数。中継を使わないとき(または合言葉が取れていないとき)は、今のまま(空)
export function peerOptions() {
  if (!extraIce) return undefined;
  return { config: { iceServers: [...BASE_ICE, ...extraIce] } };
}

// いまの経路: 'relay' | 'direct' | null(まだ決まっていない)
async function currentRoute(pc) {
  try {
    const stats = await pc.getStats();
    let pair = null;
    stats.forEach((s) => { if (s.type === 'transport' && s.selectedCandidatePairId) pair = stats.get(s.selectedCandidatePairId); });
    if (!pair) stats.forEach((s) => { if (s.type === 'candidate-pair' && s.nominated && s.state === 'succeeded') pair = s; });
    if (!pair) return null;
    const local = stats.get(pair.localCandidateId);
    const remote = stats.get(pair.remoteCandidateId);
    const isRelay = (local && local.candidateType === 'relay') || (remote && remote.candidateType === 'relay');
    return isRelay ? 'relay' : 'direct';
  } catch (err) {
    return null;
  }
}

// 映像を送る側(子機)で、送る量の上限を付ける・外す
async function applyBitrate(pc, route) {
  try {
    for (const sender of pc.getSenders()) {
      if (!sender.track || sender.track.kind !== 'video') continue;
      const params = sender.getParameters();
      if (!params.encodings || !params.encodings.length) params.encodings = [{}];
      if (route === 'relay') params.encodings[0].maxBitrate = RELAY_MAX_BITRATE;
      else delete params.encodings[0].maxBitrate;
      await sender.setParameters(params);
    }
  } catch (err) { console.error(err); }
}

function noticeText() {
  const type = navigator.connection && navigator.connection.type;
  // Wi‑Fi でも中継になることがある(会場のWi‑Fiがスマホどうしの通信を止めているとき)。そのときは「携帯回線」と言わない
  return type === 'wifi'
    ? '中継で通信しています。このため画質を下げています。'
    : '携帯回線です。このため画質を下げています。';
}

// 回線(RTCPeerConnection)を見張り、経路が決まったら・変わったら、処理する。isSender: 映像を送る側(子機)か
export function watchRoute(pc, { isSender }) {
  if (!isRelayTrial() || !pc) return;
  let last = null;
  let timer = null;
  async function poll() {
    if (['closed', 'failed'].includes(pc.connectionState || pc.iceConnectionState)) { clearInterval(timer); return; }
    const route = await currentRoute(pc);
    if (!route || route === last) return;
    last = route;
    window.__relayRoute = route;
    if (isSender) applyBitrate(pc, route);
    if (route === 'relay') showToast(noticeText(), { duration: NOTICE_MS, fadeMs: NOTICE_FADE_MS });
  }
  timer = setInterval(poll, POLL_MS);
  pc.addEventListener('connectionstatechange', () => { if (pc.connectionState === 'connected') poll(); });
}
