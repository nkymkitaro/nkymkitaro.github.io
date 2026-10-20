// prebuild.js: 録画の最中に、まとめ動画を区間ごとに先に作っておく。試作用。親機の中だけで動く。
// - 全カメラの映像が、ある時間帯までそろったら、その時間帯(既定10秒)のまとめを1つ作って、圧縮済みのまま持っておく
// - 録画を止めたあと、残りの区間だけ作って、順につないで1本のMP4にする(finish)。待ちが短くなる
// - 録画とVARが最優先: 録画のコマ落ちが増えたら、しばらく止める。VARのリプレイを開いている間・まとめを作っている間は動かさない。1回に1区間だけ作り、作った時間の半分は休む
// - 先に作った分が使えないとき(画質が違う・カメラが増えた・設定が合わない・作るのに失敗した)は、finish が null を返し、呼んだ側が今までの「全部を作る」方法に戻る
// 録画・VAR・子機・送受信の仕組みには触らない。保存してある区切り(store)を読むだけ
import { planFast, samePlan, buildPiece, assembleMp4, finishFast, QUALITY } from './compose.js';
import { B_MIME } from './recorder-b.js';

export const PIECE_SEC = 10; // 先に作る1区間の長さ(出力の秒)
const MARGIN_MS = 1000; // 区間の終わりより、これだけ先まで全カメラの映像が届いてから作る
const GAP_OK_MS = 1500; // 区切りの間の隙間がこれ以下なら、つながっているとみなす
const COOLDOWN_MS = 20000; // コマ落ちが増えたあと、止めておく時間
const REST_RATIO = 0.5; // 区間を作った時間の、この割合だけ休んでから次へ

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 録画1本の区切りを、カメラごとにまとめる(compose.js の groupTake と同じ並び)。B形式でないものがあれば null
function groupSegs(list) {
  const all = list.filter((s) => s.blob);
  if (!all.length || !all.every((s) => s.mime === B_MIME)) return null;
  const byCam = new Map();
  all.forEach((s) => { if (!byCam.has(s.cam)) byCam.set(s.cam, []); byCam.get(s.cam).push(s); });
  const cams = [...byCam.values()].map((l) => l.sort((a, b) => a.t0 - b.t0))
    .sort((a, b) => String(a[0].label).localeCompare(String(b[0].label), 'ja'));
  return { all, cams };
}

// そのカメラの映像が、途切れずに届いている終わりの時刻(ミリ秒)。隙間があれば、その手前まで
function coveredEnd(segs) {
  let end = segs[0].t0 + segs[0].durMs;
  for (let i = 1; i < segs.length; i++) {
    if (segs[i].t0 - end > GAP_OK_MS) break;
    end = Math.max(end, segs[i].t0 + segs[i].durMs);
  }
  return end;
}

export class Prebuilder {
  // store: LabStore / canRun: () => 動かしてよいか(VARを開いていない等) / getDropped: () => 全端末の落としたコマの合計
  constructor({ store, canRun = () => true, getDropped = () => 0, log = () => {} }) {
    this.store = store; this.canRun = canRun; this.getDropped = getDropped; this.log = log;
    this.reset(null, null);
  }

  reset(takeId, quality) {
    this.takeId = takeId; this.quality = quality;
    this.plan = null; this.camCount = 0;
    this.pieces = []; this.builtK = 0;
    this.running = null; this.finishing = false; this.cancel = false;
    this.cooldownUntil = 0; this.lastDropped = null; this.restUntil = 0;
    this.stats = { pieces: 0, busyMs: 0, drops: 0, errors: 0, lastError: '' };
  }

  // 録画を始めたときに呼ぶ。前の録画ぶんは捨てる
  start(takeId, quality) {
    this.cancel = true;
    this.reset(takeId, quality);
    this.lastDropped = this.getDropped();
  }

  stop() { this.cancel = true; this.reset(null, null); }

  active() { return !!this.takeId && !!QUALITY[this.quality]; }

  // 1秒か2秒ごとに呼ぶ。作れる区間があれば1つだけ作る
  async tick() {
    if (!this.active() || this.running || this.finishing) return;
    const now = performance.now();
    if (now < this.cooldownUntil || now < this.restUntil) return;
    // 録画のコマ落ちが増えたら、しばらく止める(録画を最優先)
    const dropped = this.getDropped();
    if (this.lastDropped != null && dropped > this.lastDropped) {
      this.stats.drops++; this.cooldownUntil = now + COOLDOWN_MS; this.lastDropped = dropped; return;
    }
    this.lastDropped = dropped;
    if (!this.canRun()) return;
    this.running = this._buildNext().catch((err) => {
      this.stats.errors++; this.stats.lastError = String(err && err.message ? err.message : err);
      this.cooldownUntil = performance.now() + COOLDOWN_MS;
    }).finally(() => { this.running = null; });
    await this.running;
  }

  async _buildNext() {
    const takeId = this.takeId;
    const q = QUALITY[this.quality];
    const g = groupSegs(await this.store.listByTake(takeId));
    if (!g || g.cams.length < 2) return;
    if (this.plan && g.cams.length !== this.camCount) { this.plan = null; this.pieces = []; this.builtK = 0; } // カメラが増えたら、作り直し
    if (!this.plan) { this.plan = await planFast(g.cams, g.all, q); this.camCount = g.cams.length; }
    const plan = this.plan;
    const P = Math.round(PIECE_SEC * plan.fps);
    const k0 = this.builtK; const k1 = k0 + P;
    const tb = plan.tMin + (k1 * 1000) / plan.fps;
    // 全カメラの映像が、この区間の終わりより少し先まで届いていること(まだ始まっていないカメラは待たない)
    for (const l of g.cams) if (l[0].t0 < tb && coveredEnd(l) < tb + MARGIN_MS) return;
    // 計画が変わっていないこと(始まりの時刻・大きさ)
    const now = await planFast(g.cams, g.all, q);
    if (!samePlan(now, plan)) { this.plan = null; this.pieces = []; this.builtK = 0; return; }
    const t0 = performance.now();
    const piece = await buildPiece(g.cams, plan, q, k0, k1, { shouldCancel: () => this.cancel || takeId !== this.takeId });
    if (takeId !== this.takeId || this.cancel) return;
    this.pieces.push(piece); this.builtK = k1;
    const ms = performance.now() - t0;
    this.stats.pieces++; this.stats.busyMs += ms;
    this.restUntil = performance.now() + ms * REST_RATIO;
  }

  // 録画のあと、まとめを作るときに呼ぶ。先に作った分があれば、残りだけ作ってつなぐ。使えないときは null
  // cams/all は composeTake が集めたもの。戻り値は composeTake と同じ形(diag に先に作った分の内訳)
  async finish(takeId, quality, cams, all, audioCam, { onProgress = () => {}, shouldCancel = () => false } = {}) {
    if (!this.active() || takeId !== this.takeId || quality !== this.quality || !this.pieces.length) return null;
    const started = performance.now();
    this.finishing = true; // 以後、先に作る動きは止める
    this.cancel = false;
    try {
      if (this.running) await this.running;
      const q = QUALITY[quality];
      if (!all.every((s) => s.mime === B_MIME)) return null;
      const plan = await planFast(cams, all, q);
      if (!this.plan || cams.length !== this.camCount || !samePlan(plan, this.plan)) return null;
      let k = this.builtK;
      if (k > plan.total) return null;
      const pieces = this.pieces.slice();
      // 残りを区間に分けて作る(進み具合の表示と中止のため)
      const P = Math.round(PIECE_SEC * plan.fps);
      let restFrames = 0;
      while (k < plan.total) {
        if (shouldCancel()) throw Object.assign(new Error('中止しました'), { cancelled: true });
        const k1 = Math.min(plan.total, k + P);
        const piece = await buildPiece(cams, plan, q, k, k1, { shouldCancel });
        pieces.push(piece); restFrames += piece.frames; k = k1;
        const done = k / plan.total;
        onProgress({ fraction: Math.min(0.97, done), remainMs: Math.max(0, ((performance.now() - started) / Math.max(1, restFrames)) * (plan.total - k)) });
        await sleep(0);
      }
      const out = await assembleMp4(cams, plan, pieces, audioCam, { shouldCancel });
      onProgress({ fraction: 1, remainMs: 0 });
      const diag = { t: { read: 0, readWait: 0, draw: 0, encWait: 0 }, q: {}, hiddenMs: 0 };
      const frames = pieces.reduce((a, p) => a + p.frames, 0);
      return finishFast(out, plan, q, frames, started, diag, {}, () => {}, {
        pre: { pieces: this.stats.pieces, builtFrames: this.builtK, restFrames, busyMs: Math.round(this.stats.busyMs), drops: this.stats.drops, errors: this.stats.errors, lastError: this.stats.lastError },
      });
    } finally {
      this.finishing = false;
    }
  }
}
