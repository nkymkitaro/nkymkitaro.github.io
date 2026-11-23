// swing-engine.js: 素振りのリアルタイム計測の芯(試作。lab/speedometer.html で使う)
// - 道具(木刀・竹刀)は毎コマ追う: 小さい画像(幅320)で「道具の色」かつ「ゆっくり更新する背景と違う」画素を取り、
//   いちばん細長いかたまりの向き(主成分)を道具の向きとする。1コマ数ms。
// - 骨格は別の処理(pose-worker.js)で1秒10回ほど。両手の位置(手元の動き)と、腰より下を除くのに使う。無くても動く。
// - 剣先の速さ = 手元の速さ + 道具が回る速さ × 両手の真ん中から剣先までの長さ(全長 − 13cm)。画面上の長さ合わせは、道具の見えた長さから自動。
// - 映像は端末の中だけで扱い、どこにも送らない。計測の出来事(GA4)も送らない。

const GRIP_CM = 13;

export function isToolColor(r, g, b, mode) {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), v = mx / 255, s = mx ? (mx - mn) / mx : 0;
  if (mode === 'white') return s < 0.18 && v > 0.7;
  if (mode === 'black') return v < 0.25;
  if (s < 0.2 || v < 0.31 || mx === mn) return false;
  let h = mx === r ? ((g - b) / (mx - mn)) * 60 : mx === g ? (2 + (b - r) / (mx - mn)) * 60 : (4 + (r - g) / (mx - mn)) * 60;
  if (h < 0) h += 360;
  return h >= 6 && h <= 60; // 橙〜黄(木刀・竹刀)
}

export class SwingEngine {
  constructor({ lengthCm = 101.5, color = 'wood', width = 320 } = {}) {
    this.W = width; this.H = 0; this.targetPx = 30000; this.lengthCm = lengthCm; this.color = color; // targetPx: 処理する画素の数(約230×130)。5.8万では実機で1コマ28msかかり60コマに間に合わなかった。答え合わせで3万でも精度は同じ(2026-11-23)
    this.cv = document.createElement('canvas'); this.cx = this.cv.getContext('2d', { willReadFrequently: true });
    this.bg = null; this.frames = 0;
    this.samples = []; // { t, ang, len, edge, hand, ok }
    this.lenHist = []; // 道具の見えた長さ(画素、幅320で)。端にかからないもの
    this.pose = []; // { t, hand:[x,y](幅320で), hipY, faceX }
    this.lastAng = null;
    this.speed = 0; this.omega = 0; this.speeds = { tip: 0, mono: 0, hand: 0 };
    this.swings = []; // { t, v, sign }
    this._peak = null;
    this.signStats = { 1: [], '-1': [] };
    this.faceVotes = []; this.torsoHist = []; this.rejects = 0; this.pending = [];
    this.debug = null; // { mask, comp, a, p0, p1 }
    this.movT = 18; this.fanOn = true; this.fanR = [0.6, 1.05]; this.gapMin = 0.05; this.extU = [1.5, 1.2]; this.gapNoFan = false; this.gapScale = 0.82; this.winSec = 0.07; this.recalcOn = true; this.recalcWait = 0.12; this.recalcMax = 0.6; this.recalcGapScale = 1; this.recalcGapHand = false; this.recalcSpan = 0.15; this.roi = null; this.roiOn = true; this.menOnly = true; this.raiseDeg = 55; this.raisedAt = null; this.raiseWin = 2.0; this.speedAt = 'hit'; this.hitDeg = 60; this.cubicOn = false; // cubicOn: 3次の曲線(試験台では1.16〜1.20倍に出すぎた。2026-11-24。直すまで切る) // 打つ瞬間 = 振り下ろしで竹刀が前60度まで下りた時刻の速さ(中山さん 2026-11-23)。'peak' で最速 // 振りかぶりから振り下ろしまでの待ち(中山さん 2026-11-23「1.2秒は短い」)
    // gapScale: 穴の両端の向きは、骨格の手元の遅れで外側へずれ、2割ほど出すぎる(2026-11-22 120コマの答え合わせ。白テープ・緑ネットの2本とも約1.2倍)
  }
  setLength(cm) { this.lengthCm = cm; }
  setColor(c) { this.color = c; }
  // 1秒ごとの見え方の数(画面の「どうすれば測れるか」の案内に使う。ページが takeStats() で読んで0に戻す)
  takeStats() { const s = this.st || {}; this.st = { n: 0, shaky: 0, noPerson: 0, measured: 0, seen: 0, edge: 0, short: 0, colorNear: 0, luma: 0, lumaN: 0 }; return s; }
  setWidth(w) { if (w !== this.W) { this.W = w; this.H = 0; this.reset(); } }
  get effM() { return Math.max(0.2, (this.lengthCm - GRIP_CM) / 100); }
  get lenPx() {
    if (this.lenHist.length < 5) return null;
    const a = this.lenHist.slice(-300).sort((x, y) => x - y); return a[Math.floor(a.length * 0.75)]; // 上から25%の長さ(取り違えの長い値に引っぱられにくい)
  }
  reset() { this.bg = null; this.frames = 0; this.samples = []; this.lenHist = []; this.pose = []; this.lastAng = null; this.swings = []; this._peak = null; this.signStats = { 1: [], '-1': [] }; this.faceVotes = []; this.torsoHist = []; this.rejects = 0; this.pending = []; this.speed = 0; this.speeds = { tip: 0, mono: 0, hand: 0 }; }

  // 測る範囲を決める。人の箱(骨格の画素)から: 人の高さが映像の45%未満なら、その人を中心に 横2.4倍・縦1.7倍(振りかぶった竹刀と打ち下ろしが入る)の範囲
  // 少し動いたくらいでは替えない(替えると背景・長さの学び直しで0.5秒ほど測れない)。人の箱が今の範囲の内側(余白1割)から出たときと、大きさが2割以上変わったときだけ替える
  _updateRoi(box, videoW, videoH) {
    const bx0 = box[0] / videoW, by0 = box[1] / videoH, bx1 = box[2] / videoW, by1 = box[3] / videoH, bh = by1 - by0;
    let want = null;
    if (bh < 0.45 && bh > 0.05) {
      const hh = Math.min(1, bh * 1.7), ww = Math.min(1, bh * 2.4 * videoH / videoW), cx = (bx0 + bx1) / 2;
      want = { x: Math.max(0, Math.min(1 - ww, cx - ww / 2)), y: Math.max(0, Math.min(1 - hh, by0 - bh * 0.6)), w: ww, h: hh };
    }
    const cur = this.roi;
    if (!want && !cur) return;
    if (want && cur) {
      const mx = cur.w * 0.1, my = cur.h * 0.1, inside = bx0 > cur.x + mx && bx1 < cur.x + cur.w - mx && by0 - bh * 0.4 > cur.y && by1 < cur.y + cur.h - my * 0.3;
      if (inside && want.h / cur.h > 0.8 && want.h / cur.h < 1.25) return;
    }
    this.setRoi(want);
  }
  setRoi(roi) {
    for (const pk of this.pending) { delete pk.pending; this._commit(pk); } // 決める前の1本は、そのまま決める
    this.pending = []; this._peak = null;
    this.roi = roi; this.bg = null;
    if (this.vw) { const R = roi || { x: 0, y: 0, w: 1, h: 1 }, sw = R.w * this.vw, sh = R.h * this.vh; this.W = Math.max(120, Math.round(Math.sqrt(this.targetPx * sw / sh))); this.H = Math.round(sh * this.W / sw); } else this.H = 0;
    this.prev = null; this.frames = 0; this.lenHist = []; this.lastAng = null; this.samples = []; this.pose = []; this.torsoHist = []; this.others = null; this.tgtBox = null;
    this.roiChanges = (this.roiChanges || 0) + 1;
  }
  // 骨格の結果(元の映像の座標)を受け取る。kp: [[x,y,score]×17]
  addPose(t, kp, videoW, box, others) {
    if (!kp || !this.vw) return;
    const videoH = videoW * this.vh / this.vw;
    if (box && this.roiOn) this._updateRoi(box, videoW, videoH);
    const R = this.roi || { x: 0, y: 0, w: 1, h: 1 }, W = this.W, H = this.H || Math.round(W * (R.h * this.vh) / (R.w * this.vw));
    const k = W / (R.w * videoW); // 骨格の画素 → 処理の画素(長さ)
    const tx = (x) => (x / videoW - R.x) / R.w * W, ty = (y) => (y / videoH - R.y) / R.h * H;
    kp = kp.map((q) => [tx(q[0]), ty(q[1]), q[2]]); videoW = W; // 以下は処理の座標で計算する(k = 1)
    if (box) box = [tx(box[0]), ty(box[1]), tx(box[2]), ty(box[3])];
    if (others) others = others.map((b) => [tx(b[0]), ty(b[1]), tx(b[2]), ty(b[3])]);
    void k;
    {
    const k = 1, ok = (j) => kp[j][2] > 0.2;
    // ほかの人(測る人より小さく写る人)の場所。その人の竹刀を拾わないよう、この範囲の画素は使わない(中山さん 2026-11-23「一人だけに集中」)
    if (box) { this.tgtBox = box.map((x) => x * k); this.others = (others || []).map((b) => b.map((x) => x * k)); this.othersT = t; }
    const ws = [9, 10].filter(ok); if (!ws.length) return;
    const hand = [ws.reduce((m, j) => m + kp[j][0], 0) / ws.length * k, ws.reduce((m, j) => m + kp[j][1], 0) / ws.length * k];
    const hips = [11, 12].filter(ok), hipY = hips.length ? hips.reduce((m, j) => m + kp[j][1], 0) / hips.length * k : null;
    // 前(向いている側): 鼻が両肩の真ん中より左右どちらにあるか(構えると頭は前に出る)。肩幅に対する割合で見る
    const sh = [5, 6].filter(ok), hp2 = [11, 12].filter(ok);
    const faceX = ok(0) && sh.length && hp2.length ? (kp[0][0] - sh.reduce((m, j) => m + kp[j][0], 0) / sh.length) / Math.max(1, Math.abs(sh.reduce((m, j) => m + kp[j][1], 0) / sh.length - hp2.reduce((m, j) => m + kp[j][1], 0) / hp2.length)) : null;
    // 胴の長さ(両肩の真ん中〜両腰の真ん中、画素)。道具の長さの見込みに使う(手元〜剣先は、だいたい胴の1〜3倍)
    const torso = sh.length && hp2.length ? Math.hypot(sh.reduce((m, j) => m + kp[j][0], 0) / sh.length - hp2.reduce((m, j) => m + kp[j][0], 0) / hp2.length, sh.reduce((m, j) => m + kp[j][1], 0) / sh.length - hp2.reduce((m, j) => m + kp[j][1], 0) / hp2.length) * k : null;
    if (torso) { this.torsoHist.push(torso); if (this.torsoHist.length > 30) this.torsoHist.shift(); }
    this.pose.push({ t, hand, hipY }); if (this.pose.length > 40) this.pose.shift();
    if (faceX != null && Math.abs(faceX) > 0.08) { this.faceVotes.push(Math.sign(faceX)); if (this.faceVotes.length > 60) this.faceVotes.shift(); } // 胴の長さの8%以上ずれているときだけ数える
    }
  }
  // 人(骨格)が最近見えているか。骨格を使う設定で、0.6秒以上見えていなければ測らない(誰もいない部屋で、家具を道具と取り違えて数えていた。2026-11-22 中山さんの実機)
  get torso() { const a = this.torsoHist.slice().sort((x, y) => x - y); return a.length >= 3 ? a[a.length >> 1] : null; }
  personSeen(t) { const P = this.pose; return P.length > 0 && t - P[P.length - 1].t < 0.6; }
  handAt(t) { // 骨格の両手の位置を、時刻 t に合わせて直線でつなぐ(少し先までなら伸ばす)
    const P = this.pose; if (!P.length) return null;
    if (P.length === 1 || t <= P[0].t) return Math.abs(t - P[0].t) < 0.3 ? P[0].hand : null;
    let i = P.length - 1; while (i > 0 && P[i - 1].t > t) i--;
    const a = P[Math.max(0, i - 1)], b = P[i]; if (b.t === a.t) return b.hand;
    let u = (t - a.t) / (b.t - a.t); if (u > this.extU[0]) return null; u = Math.min(u, this.extU[1]);
    return [a.hand[0] + (b.hand[0] - a.hand[0]) * u, a.hand[1] + (b.hand[1] - a.hand[1]) * u];
  }

  // 1コマを処理する。t は実際のコマの時刻(秒)
  process(video, t, { keepDebug = false } = {}) {
    const vw = video.videoWidth, vh = video.videoHeight; if (!vw) return null;
    // 処理する画像の大きさは、画素の数を一定(約5.8万)にそろえる。縦長の映像で幅320のままだと、横長の2.4倍の画素になり重かった(2026-11-22 実機で1コマ32ms)
    if (this.H && (vw !== this.vw || vh !== this.vh)) { this.H = 0; this.bg = null; this.frames = 0; this.lenHist = []; this.lastAng = null; this.roi = null; } // 映像の大きさが変わった(カメラの頼み直し・向きの変更)
    this.vw = vw; this.vh = vh;
    // 測る範囲(roi、映像に対する割合)。人が小さく写るときは、その人のまわりだけを同じ画素数で処理する(遠いと竹刀が1〜2画素の細い線になり、取れなかった。2026-11-23 道場の動画)
    const R = this.roi || { x: 0, y: 0, w: 1, h: 1 }, sw = R.w * vw, sh = R.h * vh;
    if (!this.H) { this.W = Math.max(120, Math.round(Math.sqrt(this.targetPx * sw / sh))); this.H = Math.round(sh * this.W / sw); }
    const W = this.W, H = this.H;
    if (this.cv.width !== W || this.cv.height !== H) { this.cv.width = W; this.cv.height = H; }
    this.cx.drawImage(video, R.x * vw, R.y * vh, sw, sh, 0, 0, W, H);
    const px = this.cx.getImageData(0, 0, W, H).data, N = W * H;
    if (!this.bg) { this.bg = new Float32Array(N * 3); for (let i = 0, o = 0; i < N * 4; i += 4) { this.bg[o++] = px[i]; this.bg[o++] = px[i + 1]; this.bg[o++] = px[i + 2]; } }
    const alpha = this.frames < 20 ? 0.15 : 0.04, upd = this.frames < 20 || (this.frames & 1) === 0; this.frames++; // 背景は2コマに1回だけ直す(軽くする)
    const pz = this.pose.length ? this.pose[this.pose.length - 1] : null;
    const hand = this.handAt(t) || (pz && pz.hand); this.lastHand = hand;
    const ylim = pz ? Math.min(pz.hipY != null ? pz.hipY : 1e9, (hand ? hand[1] : 1e9) + H * 0.11) : H;
    const mask = new Uint8Array(N), mov = new Uint8Array(N), bg = this.bg, mode = this.color; let changed = 0;
    const prev = this.prev && this.prev.length === N * 3 ? this.prev : null; if (!prev) { this.prev = new Uint8Array(N * 3); for (let i = 0, o = 0; i < N * 4; i += 4) { this.prev[o++] = px[i]; this.prev[o++] = px[i + 1]; this.prev[o++] = px[i + 2]; } }
    const ST = this.st || this.takeStats() && this.st; ST.n++;
    for (let i = 0; i < N * 4; i += 64) { ST.luma += 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2]; ST.lumaN++; } // 明るさ(ざっと)
    for (let y = 0, i = 0, o = 0, p = 0; y < H; y++) {
      for (let x = 0; x < W; x++, i += 4, o += 3, p++) {
        const r = px[i], g = px[i + 1], b = px[i + 2];
        const d = Math.max(Math.abs(r - bg[o]), Math.abs(g - bg[o + 1]), Math.abs(b - bg[o + 2]));
        if (d > 25) { changed++; if (y < ylim && isToolColor(r, g, b, mode)) mask[p] = 1; }
        // 動いている画素: 背景とも、前のコマとも違う(止めていた場所に残る背景の「影」は、前のコマと同じなので入らない)
        if (d > this.movT && y < ylim && prev && Math.max(Math.abs(r - prev[o]), Math.abs(g - prev[o + 1]), Math.abs(b - prev[o + 2])) > this.movT) mov[p] = 1;
        if (prev) { prev[o] = r; prev[o + 1] = g; prev[o + 2] = b; }
        if (upd) { bg[o] += (r - bg[o]) * alpha; bg[o + 1] += (g - bg[o + 1]) * alpha; bg[o + 2] += (b - bg[o + 2]) * alpha; }
      }
    }
    // 画面の3割以上が背景と違う = スマホが動いた・明るさが変わった。このコマは使わず、背景を早めに作り直す
    if (changed > N * 0.3) { ST.shaky++; this.frames = Math.min(this.frames, 10); this.lastAng = null; this.samples.push({ t, ang: null }); if (this.samples.length > 240) this.samples.shift(); this.shaky = true; this._update(); return null; }
    this.shaky = false;
    // 骨格を使う設定で人が見えていないときは、測らない
    if (this.needPerson && !this.personSeen(t)) { ST.noPerson++; this.lastAng = null; this.samples.push({ t, ang: null }); if (this.samples.length > 240) this.samples.shift(); this._update(); return null; }
    ST.measured++;
    if (hand) { // 手元のまわり(幅の25%)に、道具の色の動く画素がどれだけあるか(色が合っていないと、ほぼ0)
      const rr = W * 0.25, x0 = Math.max(0, Math.floor(hand[0] - rr)), x1 = Math.min(W, Math.ceil(hand[0] + rr)), y0 = Math.max(0, Math.floor(hand[1] - rr)), y1 = Math.min(H, Math.ceil(hand[1] + rr));
      let cnt = 0; for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) cnt += mask[y * W + x]; if (cnt > 20) ST.colorNear++;
    }
    // かたまりに分け、いちばん「細長く大きい」もの(手元に近ければ加点)を道具とする
    // ほかの人の場所を消す: 箱を上(振りかぶった竹刀)に半分、左右に1/4広げた範囲。ただし測る人の箱の中は消さない
    if (this.others && this.others.length && this.othersT != null && t - this.othersT < 0.6) {
      const tb = this.tgtBox;
      for (const b of this.others) {
        const bh = b[3] - b[1], x0 = Math.max(0, Math.floor(b[0] - bh * 0.25)), x1 = Math.min(W - 1, Math.ceil(b[2] + bh * 0.25)), y0 = Math.max(0, Math.floor(b[1] - bh * 0.5)), y1 = Math.min(H - 1, Math.ceil(b[3]));
        for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
          if (tb && x >= tb[0] && x <= tb[2] && y >= tb[1] && y <= tb[3]) continue;
          const q = y * W + x; mask[q] = 0; mov[q] = 0;
        }
      }
    }
    const lab = new Int32Array(N), stack = new Int32Array(N); let best = null, bestScore = 0, nlab = 0, shortNear = false;
    for (let p0 = 0; p0 < N; p0++) {
      if (!mask[p0] || lab[p0]) continue;
      nlab++; let sp = 0; stack[sp++] = p0; lab[p0] = nlab;
      let n = 0, sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0; const pts = [];
      while (sp) {
        const p = stack[--sp], x = p % W, y = (p / W) | 0; n++; sx += x; sy += y; sxx += x * x; syy += y * y; sxy += x * y; pts.push(p);
        if (x > 0 && mask[p - 1] && !lab[p - 1]) { lab[p - 1] = nlab; stack[sp++] = p - 1; }
        if (x < W - 1 && mask[p + 1] && !lab[p + 1]) { lab[p + 1] = nlab; stack[sp++] = p + 1; }
        if (y > 0 && mask[p - W] && !lab[p - W]) { lab[p - W] = nlab; stack[sp++] = p - W; }
        if (y < H - 1 && mask[p + W] && !lab[p + W]) { lab[p + W] = nlab; stack[sp++] = p + W; }
      }
      if (n < 25) continue;
      const mx = sx / n, my = sy / n, cxx = sxx / n - mx * mx, cyy = syy / n - my * my, cxy = sxy / n - mx * my;
      const tr = cxx + cyy, det = cxx * cyy - cxy * cxy, l1 = tr / 2 + Math.sqrt(Math.max(0, tr * tr / 4 - det)), l2 = Math.max(1e-3, tr - l1);
      let score = Math.sqrt(l1) * Math.sqrt(n) * Math.pow(l1 / l2, 0.25), near = null, length = 0;
      if (hand) {
        // 道具は「手元の近くから始まり、胴の約1〜3倍の長さで、細い」。腕・服・家具は、これで落とす(振っていないのにメーターが動いていた。2026-11-22 実機)
        // 骨格は1秒数回なので、速い振りの最中は手元の位置が数十画素ずれる。そこで手元そのものではなく「かたまりの手元側の端」を起点にする
        const a0 = 0.5 * Math.atan2(2 * cxy, cxx - cyy), ux = Math.cos(a0), uy = Math.sin(a0);
        let lo = 1e9, hi = -1e9; for (let q = 0; q < pts.length; q += 2) { const pr = (pts[q] % W - mx) * ux + (((pts[q] / W) | 0) - my) * uy; if (pr < lo) lo = pr; if (pr > hi) hi = pr; }
        const e0 = [mx + ux * lo, my + uy * lo], e1 = [mx + ux * hi, my + uy * hi], d0 = Math.hypot(e0[0] - hand[0], e0[1] - hand[1]), d1 = Math.hypot(e1[0] - hand[0], e1[1] - hand[1]);
        near = d0 <= d1 ? e0 : e1; const dmin = Math.min(d0, d1); length = hi - lo;
        const far = d0 <= d1 ? e1 : e0, cut = far[0] < 3 || far[1] < 3 || far[0] > W - 4 || far[1] > H - 4; // 剣先側が画面の端にかかる = 見切れている
        const T = this.torso, Lp = this.lenPx, ref = Lp && this.lenHist.length > 30 ? Lp / 1.8 : T;
        if (ref) {
          const R = this.why || (this.why = { far: 0, short: 0, long: 0, thick: 0, ok: 0 });
          if (dmin > ref * 0.9) { R.far++; continue; }                         // 手元から離れている
          if (!cut && length < ref * (ref === T ? 0.6 : 0.9)) { R.short++; if (dmin < ref * 0.3 && length > ref * 0.25) shortNear = true; continue; }  // 短い(腕・手だけ。正面から撮って道具がカメラを向くと、道具も短く見える)
          if (cut && length < ref * 0.35) { R.short++; continue; }             // 見切れていても、短すぎるものは道具にしない
          if (length > ref * 3.6) { R.long++; continue; }                      // 長すぎる
          if (n / Math.max(1, length) > ref * 0.3) { R.thick++; continue; }    // 太すぎる(ぶれた道具の扇は通す幅)
          R.ok++;
        }
        score = length * Math.sqrt(n) * (dmin < (ref || W) * 0.3 ? 2 : 1);
      }
      if (score > bestScore) { bestScore = score; best = { n, mx, my, cxx, cyy, cxy, l1, pts, near, length }; }
    }
    let ang = null, len = null, edge = false, p0 = null, p1 = null, fanUsed = false;
    if (best) {
      const a0 = 0.5 * Math.atan2(2 * best.cxy, best.cxx - best.cyy), ux = Math.cos(a0), uy = Math.sin(a0);
      let lo = 1e9, hi = -1e9; for (const p of best.pts) { const pr = (p % W - best.mx) * ux + (((p / W) | 0) - best.my) * uy; if (pr < lo) lo = pr; if (pr > hi) hi = pr; }
      p0 = [best.mx + ux * lo, best.my + uy * lo]; p1 = [best.mx + ux * hi, best.my + uy * hi];
      // どちらの端が剣先か: 手元から遠い端。手元が分からなければ、前のコマの向きに近いほう。初めは上を向いているほう
      let cand = [Math.atan2(p1[1] - p0[1], p1[0] - p0[0]), Math.atan2(p0[1] - p1[1], p0[0] - p1[0])], tipFirst = 1;
      if (hand) tipFirst = Math.hypot(p1[0] - hand[0], p1[1] - hand[1]) >= Math.hypot(p0[0] - hand[0], p0[1] - hand[1]) ? 1 : 0;
      else if (this.lastAng != null) { const d = (a) => Math.abs(Math.atan2(Math.sin(a - this.lastAng), Math.cos(a - this.lastAng))); tipFirst = d(cand[0]) <= d(cand[1]) ? 1 : 0; }
      else tipFirst = p1[1] < p0[1] ? 1 : 0;
      let a = tipFirst ? cand[0] : cand[1];
      if (hand && best.near) { // 手元側の端から、遠い側の画素の向きの平均(ぶれた扇なら真ん中=露出の真ん中の向き。手の肌がつながっても曲がらない)
        let vx = 0, vy = 0; for (const p of best.pts) { const dx = p % W - best.near[0], dy = ((p / W) | 0) - best.near[1], r = Math.hypot(dx, dy); if (r > best.length * 0.45) { vx += dx; vy += dy; } }
        if (vx || vy) a = Math.atan2(vy, vx);
      }
      // 手元の判定と前のコマの向きが食い違う(160度以上の飛び)ときは、前のコマの向きを信じる(1コマで半回転はしない)
      let jump = false;
      if (this.lastAng != null) {
        const dd = Math.atan2(Math.sin(a - this.lastAng), Math.cos(a - this.lastAng));
        if (!hand && Math.abs(dd) > 2.8) a = tipFirst ? cand[1] : cand[0];
        const d2 = Math.atan2(Math.sin(a - this.lastAng), Math.cos(a - this.lastAng));
        // 1コマで動ける角度を超える飛び(毎秒2000度+20度より大きい)は取り違えとして使わない。3コマ続いたら新しい向きを信じる
        const dt = Math.max(0.008, t - (this.lastAngT != null ? this.lastAngT : t - 0.017)); // 前に向きが取れたコマからの時間(見えないコマをはさむと長くなる)
        // 速い振りを取り違えとして捨てないよう、ゆるめにした(毎秒3000度+25度)
        if (Math.abs(d2) > (3000 * dt + 25) * Math.PI / 180 && this.rejects < 3) { jump = true; this.rejects++; }
        else { this.rejects = 0; a = this.lastAng + d2; }
      }
      if (!jump) { ang = a; this.lastAng = a; this.lastAngT = t; }
      const tip = Math.cos(Math.atan2(p1[1] - p0[1], p1[0] - p0[0]) - a) > 0 ? p1 : p0; edge = (tip[0] < 2 && R.x <= 0.001) || (tip[1] < 2 && R.y <= 0.001) || (tip[0] > W - 3 && R.x + R.w >= 0.999) || (tip[1] > H - 3 && R.y + R.h >= 0.999); // 測る範囲の端でなく、映像の端で見切れたときだけ
      if (edge) ST.edge++;
      // 長さ(画素)は、両手の真ん中から剣先まで。骨格が無いときは、かたまり全体の長さ(手の肌も入るので、少し長めに出る)
      len = hand ? Math.hypot(tip[0] - hand[0], tip[1] - hand[1]) : hi - lo;
      if (!edge && len < H * 0.85) { this.lenHist.push(len); if (this.lenHist.length > 600) this.lenHist.shift(); } // 画面の高さに近い長さは、取り違え(近づいて来た人など)として使わない
    }
    // 道具のかたまりが取れないコマ(速い振りで、ぶれた竹刀がちぎれ・色が薄くなる)は、手元から道具1本ぶん離れた輪の中の
    // 「背景と違う画素」の向きの山を道具の向きとする(ぶれの扇の真ん中 = 露出の真ん中の向き)。輪は腕・頭より外なので、人の動きは入りにくい
    // (2026-11-22 緑ネットの120コマ答え合わせ: 速い振りの半分以上を「短い」で捨て、メーターが半分の速さしか出ていなかった)
    let fp = null;
    if (ang == null && this.fanOn && hand && this.lenPx && this.lenHist.length > 30) {
      // 動く画素を、手元のずれを見込んで広めに取っておく(後で、遅れて届いた骨格の手元で向きを出し直すため)
      const Lp = this.lenPx, rr1 = Lp * (this.fanR[1] + 0.4), rr0 = Math.max(0, Lp * (this.fanR[0] - 0.4));
      const x0 = Math.max(0, Math.floor(hand[0] - rr1)), x1 = Math.min(W - 1, Math.ceil(hand[0] + rr1)), y0 = Math.max(0, Math.floor(hand[1] - rr1)), y1 = Math.min(H - 1, Math.ceil(hand[1] + rr1));
      const buf = [];
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
        if (!mov[y * W + x]) continue; const dx = x - hand[0], dy = y - hand[1], q = dx * dx + dy * dy;
        if (q < rr0 * rr0 || q > rr1 * rr1) continue; buf.push(x, y);
      }
      fp = Int16Array.from(buf);
      const R = this.why || (this.why = {});
      let a = this._fanAngle(fp, hand, Lp), jump = false;
      if (a != null) {
        if (this.lastAng != null) {
          const d2 = Math.atan2(Math.sin(a - this.lastAng), Math.cos(a - this.lastAng)), dt = Math.max(0.008, t - (this.lastAngT != null ? this.lastAngT : t - 0.017));
          if (Math.abs(d2) > (3000 * dt + 25) * Math.PI / 180 && this.rejects < 3) { jump = true; this.rejects++; } else { this.rejects = 0; a = this.lastAng + d2; }
        }
        if (!jump) { ang = a; this.lastAng = a; this.lastAngT = t; R.fan = (R.fan || 0) + 1; fanUsed = true; }
      } else R.fanNo = (R.fanNo || 0) + 1;
    }
    let tipPt = null;
    if (ang != null) { const Lp = this.lenPx; tipPt = hand && Lp ? [hand[0] + Lp * Math.cos(ang), hand[1] + Lp * Math.sin(ang)] : (Math.cos(Math.atan2(p1[1] - p0[1], p1[0] - p0[0]) - ang) > 0 ? p1 : p0); }
    if (ang != null) ST.seen++; else if (shortNear) ST.short++;
    // 見えないコマをはさんだ2つの向きの差からも、回る速さを出す(いちばん速い瞬間はぶれて見えないことが多く、ならした速さでは届かない。2026-11-22 実機「速く振っても反映されない」)
    // 差÷時間は、その間の平均の速さなので、実際の最高より低めになる(多めには出ない)。ならした速さより大きいときだけ、1本の最高に使う
    if (ang != null) {
      let k = this.samples.length - 1; while (k >= 0 && this.samples[k].ang == null && t - this.samples[k].t < 0.13) k--;
      const pv = k >= 0 ? this.samples[k] : null, gap = pv && pv.ang != null ? t - pv.t : 0;
      if (gap >= this.gapMin && gap < 0.13 && k < this.samples.length - 1 && !(this.gapNoFan && (fanUsed || pv.fan))) { // 短い穴は、向きの小さなずれで大きく出すぎる(2コマで8度ずれると4m/秒)。0.05秒以上の穴だけ
        const w = (ang - pv.ang) / gap * this.gapScale, vg = Math.min(30, Math.abs(w) * this.effM);
        if (this.gapLog) this.gapLog.push([t, gap, pv.ang, ang, vg]);
        if (vg > 3 && (!this._peak || vg > this._peak.v)) {
          const Lm = Math.max(0.1, (this.lengthCm * 0.75 - 13) / 100);
          this._peak = Object.assign(this._peak || {}, { v: vg, mono: Math.abs(w) * Lm, hand: this._peak ? this._peak.hand : 0, t: t - gap / 2, sign: Math.sign(w), vx: -w * Math.sin((ang + pv.ang) / 2), gapUsed: true });
        }
      }
    }
    this.seenN = (this.seenN || 0) + (ang != null ? 1 : 0); this.allN = (this.allN || 0) + 1; // 道具が見えたコマの数(画面の「道具 ○%」)
    // 振りかぶった(竹刀が前から上へ55度以上): 面の1本は「振りかぶり→振り下ろし」の組で数える(_finishPeak)
    if (ang != null) { const f = this.front(); if (f) { const e = Math.atan2(-Math.sin(ang), Math.cos(ang) * f) * 180 / Math.PI; if (e >= this.raiseDeg) this.raisedAt = t; } }
    this.samples.push({ t, ang, len, edge, hand, tip: tipPt, fan: fanUsed, fp }); if (this.samples.length > 240) this.samples.shift();
    if (keepDebug) this.debug = { mask, W, H, p0, p1, ang, hand };
    this._update();
    this._flush(t);
    return { ang, len, edge };
  }

  // ならした向きから、回る速さと剣先の速さ(少し前の時刻)を出す。前後4コマ(9点)に2次の式を当てはめた傾き。
  // 一番速い瞬間は、ぶれて道具が見えないコマが混じりやすい。9点のうち6点以上あれば、欠けたまま計算する(欠けると数えていなかった。2026-11-22 実機)
  _update() {
    // ならす幅は時間で決める(前後約0.07秒)。30コマのカメラでは前後2コマ、60コマでは前後4コマ。
    // コマ数で固定していると、30コマのカメラでは0.3秒もならして速い振りがつぶれ、欠けたコマで数えられなかった(2026-11-22 実機「取りこぼしが多い」)
    const S = this.samples, n = S.length; if (n < 8) return;
    const dts = []; for (let k = n - 6; k < n; k++) if (S[k] && S[k - 1]) dts.push(S[k].t - S[k - 1].t);
    const dtm = dts.sort((x, y) => x - y)[dts.length >> 1] || 1 / 60, m = Math.max(2, Math.min(4, Math.round(this.winSec / dtm)));
    if (n < 2 * m + 2) return;
    const c = n - 1 - m, t0 = S[c].t, pts = [];
    for (let k = -m; k <= m; k++) { const s = S[c + k]; if (s && s.ang != null) pts.push([s.t - t0, s.ang]); }
    const left = pts.filter((q) => q[0] < 0).length, right = pts.filter((q) => q[0] > 0).length, need = Math.ceil((2 * m + 1) * 0.6);
    if (pts.length < Math.max(4, need) || left < 1 || right < 1) {
      this.speed *= 0.85; for (const k in this.speeds) this.speeds[k] *= 0.85;
      if (this._peak && t0 - this._peak.t > 0.25) this._finishPeak(); // 長く見えなければ、その1本は区切る
      return;
    }
    // 2次の最小二乗(ang = a0 + a1*dt + a2*dt^2)。傾き a1 が回る速さ
    let s0 = 0, s1 = 0, s2 = 0, s3 = 0, s4 = 0, y0 = 0, y1 = 0, y2 = 0;
    for (const [x, y] of pts) { const x2 = x * x; s0++; s1 += x; s2 += x2; s3 += x2 * x; s4 += x2 * x2; y0 += y; y1 += x * y; y2 += x2 * y; }
    const det3 = (a, b, cc, d, e, f, g, h, i) => a * (e * i - f * h) - b * (d * i - f * g) + cc * (d * h - e * g);
    const D = det3(s0, s1, s2, s1, s2, s3, s2, s3, s4); if (Math.abs(D) < 1e-18) return;
    const omega = det3(s0, y0, s2, s1, y1, s3, s2, y2, s4) / D;
    const a0 = det3(y0, s1, s2, y1, s2, s3, y2, s3, s4) / D;
    const win = [], H = []; let sk2 = 0, skx = 0, sky = 0, nh = 0;
    for (let k = -m; k <= m; k++) { const s = S[c + k]; win.push(s); sk2 += (s.t - t0) * (s.t - t0); }
    // 手元の速さ(骨格があるとき)。骨格の結果そのもの(前後0.2秒)に直線を当てる。画素→mは道具の見えた長さから
    // (コマの時刻で手元を補うと、骨格は遅れて届くので最新のコマで手元が取れず、いつも0になっていた)
    const [vhx, vhy] = this._handVel(t0);
    // 3か所の速さ: 剣先(両手の真ん中から 全長−13cm)、物打ち(柄頭から全長の3/4。剣先から1/4)、手元(両手の真ん中)
    const a = a0, L = this.effM, Lm = Math.max(0.1, (this.lengthCm * 0.75 - 13) / 100);
    const at = (r) => Math.min(30, Math.hypot(vhx - omega * r * Math.sin(a), vhy + omega * r * Math.cos(a)));
    const vx = vhx - omega * L * Math.sin(a);
    const v = at(L), vm = at(Lm), vh = Math.min(30, Math.hypot(vhx, vhy));
    this.speed = v; this.speeds = { tip: v, mono: vm, hand: vh }; this.omega = omega; this.speedT = t0; this.tipVx = vx;
    // 1本の区切り: 剣先が3m/秒を超えてから、最高の6割を切ったら、その最高を1本とする(物打ち・手元は、その瞬間の値)
    if (!this._peak) { if (v > 3) this._peak = { v, mono: vm, hand: vh, t: t0, sign: Math.sign(omega), vx }; }
    else {
      if (v > this._peak.v) Object.assign(this._peak, { v, mono: vm, hand: vh, t: t0, sign: Math.sign(omega) || this._peak.sign, vx });
      else if (v < this._peak.v * 0.6) this._finishPeak();
    }
  }
  // 1本の区切りが来たら、すぐには決めずに待つ。後から届く骨格で手元を「はさんで」計算し直してから決める(_flush)
  // (骨格は1秒10回ほどで、遅れて届く。区切りの時点の手元は古く、速い振りでは向きがずれて約1.2〜1.3倍に出すぎていた。2026-11-22 試験台で、遅れ0なら1.1倍以下)
  _finishPeak() {
    const pk = this._peak; this._peak = null; if (!pk) return;
    if (this.blockCount) return; // 60コマが出ていない間は数えない(中山さん 2026-11-23「60fps強制。それ以外許さない」)
    // 面だけ(中山さん 2026-11-23「今は面だけ」): 振り下ろしの山は、直前2秒以内に振りかぶっていたときだけ1本と数える。数えたら振りかぶりを使い切る
    // (振りかぶりを見ずに速さの山だけで数えていて、向きの一瞬の飛びや、1本が割れた山を数えていた)
    if (this.menOnly) {
      const f = this.front(), ds = this.downSign();
      if (f && pk.sign === ds) {
        if (!(this.raisedAt != null && pk.t - this.raisedAt < this.raiseWin)) { const W2 = this.why || (this.why = {}); W2.noRaise = (W2.noRaise || 0) + 1; return; }
        this.raisedAt = null;
      }
    }
    if (this.recalcOn) this._recalc(pk); // その場の手元で一度計算(すぐ出す数字)。後から届いた骨格で、もう一度計算し直す
    pk.pending = true; this.pending.push(pk);
  }
  // 向いている側: +1 = 右、-1 = 左、0 = まだ分からない(鼻と両肩から)
  front() { const fv = this.faceVotes, fs = fv.reduce((a, b) => a + b, 0); return fv.length >= 8 && Math.abs(fs) >= fv.length * 0.6 ? Math.sign(fs) : 0; }
  // 今の1本(表示用): 決める前の1本(その場の計算)があれば、それを先に出す。決まったら、計算し直した値に替わる
  lastDown() {
    const ds = this.downSign(), P = this.pending.filter((q) => q.sign === ds), S = this.swings.filter((q) => q.sign === ds);
    const a = P[P.length - 1], b = S[S.length - 1]; return a && (!b || a.t > b.t) ? a : b;
  }
  _flush(t) {
    const P = this.pose, lastPose = P.length ? P[P.length - 1].t : -1e9;
    while (this.pending.length) {
      const pk = this.pending[0];
      if (!(lastPose >= pk.t + this.recalcWait || t - pk.t > this.recalcMax)) break;
      this.pending.shift(); if (this.recalcOn) this._recalc(pk); delete pk.pending; this._commit(pk);
    }
  }
  _commit(pk) {
    // 道具かどうかは見つける段階で確かめている(手元から始まる・胴の1〜3倍の長さ・細い)。ここでは遅すぎる動き(4m/秒未満)と、始めの背景づくりの間を除く
    // 同じ向きの山が0.15秒以内に続いたら、1本の振りが割れたもの。速いほうだけ残す(割れた後半の小さい山を1本と数えていた。2026-11-22 答え合わせ)
    const last = this.swings[this.swings.length - 1];
    if (last && last.sign === pk.sign && pk.t - last.t < 0.15) {
      if (pk.v > last.v) { const arr = this.signStats[last.sign]; const j = arr.lastIndexOf(last.v); if (j >= 0) arr[j] = pk.v; Object.assign(last, pk); }
      return;
    }
    if (pk.v >= 4 && this.frames > 30) { this.signStats[pk.sign].push(pk.v); this.swings.push(pk); if (this.swings.length > 200) this.swings.shift(); if (this.onSwing) this.onSwing(pk); }
  }
  // 動く画素(x,y の並び)から、手元を中心にした輪の中の向きの山を出す。山がはっきりしなければ null
  _fanAngle(fp, hand, Lp) {
    const r0 = Lp * this.fanR[0], r1 = Lp * this.fanR[1], NB = 72, hist = new Float32Array(NB); let tot = 0;
    for (let q = 0; q < fp.length; q += 2) {
      const dx = fp[q] - hand[0], dy = fp[q + 1] - hand[1], rr = dx * dx + dy * dy;
      if (rr < r0 * r0 || rr > r1 * r1) continue;
      hist[((Math.round(Math.atan2(dy, dx) / (2 * Math.PI) * NB) % NB) + NB) % NB]++; tot++;
    }
    let bi = 0, bs = -1; for (let k = 0; k < NB; k++) { const s3 = hist[(k + NB - 1) % NB] + hist[k] + hist[(k + 1) % NB]; if (s3 > bs) { bs = s3; bi = k; } }
    let sx = 0, sy = 0, inn = 0; for (let k = -6; k <= 6; k++) { const w = hist[(bi + k + NB) % NB], a2 = (bi + k) / NB * 2 * Math.PI; sx += w * Math.cos(a2); sy += w * Math.sin(a2); inn += w; }
    return inn >= Lp * 0.25 && inn >= tot * 0.6 ? Math.atan2(sy, sx) : null;
  }
  // 手元の速さ(m/秒の x,y)。骨格の結果そのもの(前後0.2秒)に直線を当てる
  _handVel(t0) {
    let vhx = 0, vhy = 0; const Lp = this.lenPx;
    if (Lp && this.lenHist.length > 30) {
      const mpp = this.effM / Lp, P = this.pose.filter((q) => Math.abs(q.t - t0) <= 0.2);
      if (P.length >= 2) {
        const tm = P.reduce((a2, q) => a2 + q.t, 0) / P.length, xm = P.reduce((a2, q) => a2 + q.hand[0], 0) / P.length, ym = P.reduce((a2, q) => a2 + q.hand[1], 0) / P.length;
        let stt = 0, stx = 0, sty = 0; for (const q of P) { const dt = q.t - tm; stt += dt * dt; stx += dt * (q.hand[0] - xm); sty += dt * (q.hand[1] - ym); }
        if (stt > 1e-6) { vhx = stx / stt * mpp; vhy = sty / stt * mpp; }
        const hv = Math.hypot(vhx, vhy); if (hv > 4) { vhx *= 4 / hv; vhy *= 4 / hv; }
      }
    }
    return [vhx, vhy];
  }
  // 1本の最高を、後から届いた骨格の手元(前後をはさんだ位置)で計算し直す
  _recalc(pk) {
    const S = this.samples.filter((s) => s.t >= pk.t - 0.3 && s.t <= pk.t + 0.25), Lp = this.lenPx; if (S.length < 8 || !Lp) return;
    const A = new Array(S.length).fill(null); let last = null, lastT = null;
    for (let i = 0; i < S.length; i++) {
      const s = S[i]; let a = null;
      if (s.fp) { const h = this.handAt(s.t) || s.hand; if (h) a = this._fanAngle(s.fp, h, Lp); }
      else if (s.ang != null) a = s.ang;
      if (a == null) continue;
      if (last != null) {
        const d = Math.atan2(Math.sin(a - last), Math.cos(a - last)), dt = Math.max(0.008, s.t - lastT);
        if (Math.abs(d) > (3000 * dt + 25) * Math.PI / 180) continue;
        a = last + d;
      }
      A[i] = a; last = a; lastT = s.t;
    }
    const dts = []; for (let i = 1; i < S.length; i++) dts.push(S[i].t - S[i - 1].t);
    const dtm = dts.sort((x, y) => x - y)[dts.length >> 1] || 1 / 60, m = Math.max(2, Math.min(4, Math.round(this.winSec / dtm)));
    const L = this.effM, Lm = Math.max(0.1, (this.lengthCm * 0.75 - 13) / 100); let best = null;
    const cands = [];
    const put = (t0, omega, a, vh) => {
      if (Math.sign(omega) !== pk.sign || Math.abs(t0 - pk.t) > 0.3) return; // 同じ向き・近い時刻だけ(前後の振りかぶりを拾わない)
      const at = (r) => Math.min(30, Math.hypot(vh[0] - omega * r * Math.sin(a), vh[1] + omega * r * Math.cos(a)));
      const c = { v: at(L), mono: at(Lm), hand: Math.min(30, Math.hypot(vh[0], vh[1])), t: t0, sign: Math.sign(omega), vx: vh[0] - omega * L * Math.sin(a) };
      cands.push(c); if (Math.abs(t0 - pk.t) <= this.recalcSpan && (!best || c.v > best.v)) best = c;
    };
    // ①なめらかに当てはめた速さ(_update と同じ2次の式)
    for (let c = m; c < S.length - m; c++) {
      const t0 = S[c].t, pts = []; for (let k = -m; k <= m; k++) if (A[c + k] != null) pts.push([S[c + k].t - t0, A[c + k]]);
      const left = pts.filter((q) => q[0] < 0).length, right = pts.filter((q) => q[0] > 0).length;
      if (pts.length < Math.max(4, Math.ceil((2 * m + 1) * 0.6)) || !left || !right) continue;
      let s0 = 0, s1 = 0, s2 = 0, s3 = 0, s4 = 0, y0 = 0, y1 = 0, y2 = 0;
      for (const [x, y] of pts) { const x2 = x * x; s0++; s1 += x; s2 += x2; s3 += x2 * x; s4 += x2 * x2; y0 += y; y1 += x * y; y2 += x2 * y; }
      const det3 = (a, b, cc, d, e, f, g, h, i) => a * (e * i - f * h) - b * (d * i - f * g) + cc * (d * h - e * g);
      const D = det3(s0, s1, s2, s1, s2, s3, s2, s3, s4); if (Math.abs(D) < 1e-18) continue;
      put(t0, det3(s0, y0, s2, s1, y1, s3, s2, y2, s4) / D, det3(y0, s1, s2, y1, s2, s3, y2, s3, s4) / D, this._handVel(t0));
    }
    // ②見えないコマをはさんだ2つの向きの差(その間の平均の速さ)
    let pj = -1;
    for (let i = 0; i < S.length; i++) {
      if (A[i] == null) continue;
      if (pj >= 0 && i - pj > 1) {
        const gap = S[i].t - S[pj].t;
        if (gap >= this.gapMin && gap < 0.13) { const w = (A[i] - A[pj]) / gap * this.recalcGapScale, tm = (S[i].t + S[pj].t) / 2; put(tm, w, (A[i] + A[pj]) / 2, this.recalcGapHand ? this._handVel(tm) : [0, 0]); }
      }
      pj = i;
    }
    // 打った瞬間の速さ(中山さん 2026-11-23「振り下ろしたところでスピードを取って」): 振り下ろしで、竹刀が前で水平から hitDeg 度の高さまで下りてきた時刻の速さ
    // (打突は竹刀が前でほぼ水平のとき。いちばん速い瞬間は、その少し前の振り下ろしの途中に来る)
    const f = this.front(), ds = this.downSign();
    if (this.speedAt === 'hit' && f && pk.sign === ds && cands.length) {
      const el = (a) => Math.atan2(-Math.sin(a), Math.cos(a) * f) * 180 / Math.PI;
      let tHit = null, pj2 = -1;
      for (let i = 0; i < S.length; i++) {
        if (A[i] == null) continue;
        if (pj2 >= 0 && S[i].t > pk.t - 0.2) { const e0 = el(A[pj2]), e1 = el(A[i]); if (e0 > this.hitDeg && e1 <= this.hitDeg && e0 < 150) { tHit = S[pj2].t + (S[i].t - S[pj2].t) * (e0 - this.hitDeg) / Math.max(1e-6, e0 - e1); break; } }
        pj2 = i;
      }
      if (tHit != null) {
        // 打つ瞬間の向きの変わり方を、前後のコマ(±3.5コマ)に3次の曲線を当てて、その時刻で直接求める(2026-11-24)
        // 30コマの試算(緑ネット240コマの正解から間引き): 前後の平均を使う形は0.90倍、この形は1.00倍・ばらつき4%。60コマでも1.03倍・2%
        let h = this.cubicOn ? this._cubicAt(S, A, tHit, dtm) : null;
        if (h) cands.push(h);
        else for (const c of cands) if (Math.abs(c.t - tHit) <= 0.04 && (!h || Math.abs(c.t - tHit) < Math.abs(h.t - tHit))) h = c;
        if (h) { best = Object.assign({}, h, { peak: best ? best.v : h.v, hitT: tHit }); }
      }
    }
    if (best && best.sign) { pk.pre = pk.v; Object.assign(pk, best, { recalc: true }); }
  }
  // 時刻 t0 の向きと回る速さを、前後 ±3.5コマの点に当てた3次の曲線(最小二乗)から出し、剣先・物打ち・手元の速さにする
  _cubicAt(S, A, t0, dtm) {
    const pts = []; for (let i = 0; i < S.length; i++) if (A[i] != null && Math.abs(S[i].t - t0) <= 3.5 * dtm) pts.push([S[i].t - t0, A[i]]);
    if (pts.length < 4 || !pts.some((q) => q[0] < 0) || !pts.some((q) => q[0] > 0)) return null;
    const M = [[0, 0, 0, 0, 0], [0, 0, 0, 0, 0], [0, 0, 0, 0, 0], [0, 0, 0, 0, 0]];
    for (const [x, y] of pts) { const xs = [1, x, x * x, x * x * x]; for (let r = 0; r < 4; r++) { for (let c = 0; c < 4; c++) M[r][c] += xs[r] * xs[c]; M[r][4] += xs[r] * y; } }
    for (let c = 0; c < 4; c++) { // ガウスの消去法
      let pv = c; for (let r = c + 1; r < 4; r++) if (Math.abs(M[r][c]) > Math.abs(M[pv][c])) pv = r;
      if (Math.abs(M[pv][c]) < 1e-18) return null; [M[c], M[pv]] = [M[pv], M[c]];
      for (let r = 0; r < 4; r++) if (r !== c) { const k = M[r][c] / M[c][c]; for (let q = c; q < 5; q++) M[r][q] -= k * M[c][q]; }
    }
    const a = M[0][4] / M[0][0], omega = M[1][4] / M[1][1], vh = this._handVel(t0), L = this.effM, Lm = Math.max(0.1, (this.lengthCm * 0.75 - 13) / 100);
    const at = (r) => Math.min(30, Math.hypot(vh[0] - omega * r * Math.sin(a), vh[1] + omega * r * Math.cos(a)));
    return { v: at(L), mono: at(Lm), hand: Math.min(30, Math.hypot(vh[0], vh[1])), t: t0, sign: Math.sign(omega), vx: vh[0] - omega * L * Math.sin(a), cubic: true };
  }
  // 振り下ろしの回る向き: 速いほうの向き(直近10本ずつの平均)
  downSign() {
    // ①前(向いている側)がはっきりしていれば、最速の瞬間に剣先が前へ動く向き(振り下ろしは、後ろ→上→前へ回る)
    //  (縦長の映像では振りかぶりも同じくらい速く出て、速さだけでは逆になることがあった。2026-11-22)
    const fv = this.faceVotes, fs = fv.reduce((a, b) => a + b, 0);
    if (fv.length >= 8 && Math.abs(fs) >= fv.length * 0.6) {
      const f = Math.sign(fs); let vote = 0;
      for (const s of this.swings.slice(-20)) vote += (s.vx * f > 0 ? 1 : -1) * s.sign;
      if (vote) return vote > 0 ? 1 : -1;
    }
    // ②分からなければ、速いほうの向き(直近10本ずつの中央値。外れ値に強い)
    const med = (a) => { const b = a.slice(-10).sort((x, y) => x - y); return b.length ? b[b.length >> 1] : 0; };
    return med(this.signStats[1]) >= med(this.signStats[-1]) ? 1 : -1;
  }
  isDown(sw) { return sw.sign === this.downSign(); }
}
