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
    this.W = width; this.H = 0; this.lengthCm = lengthCm; this.color = color;
    this.cv = document.createElement('canvas'); this.cx = this.cv.getContext('2d', { willReadFrequently: true });
    this.bg = null; this.frames = 0;
    this.samples = []; // { t, ang, len, edge, hand, ok }
    this.lenHist = []; // 道具の見えた長さ(画素、幅320で)。端にかからないもの
    this.pose = []; // { t, hand:[x,y](幅320で), hipY, faceX }
    this.lastAng = null;
    this.speed = 0; this.omega = 0;
    this.swings = []; // { t, v, sign }
    this._peak = null;
    this.signStats = { 1: [], '-1': [] };
    this.faceVotes = [];
    this.debug = null; // { mask, comp, a, p0, p1 }
  }
  setLength(cm) { this.lengthCm = cm; }
  setColor(c) { this.color = c; }
  setWidth(w) { if (w !== this.W) { this.W = w; this.H = 0; this.reset(); } }
  get effM() { return Math.max(0.2, (this.lengthCm - GRIP_CM) / 100); }
  get lenPx() {
    if (this.lenHist.length < 5) return null;
    const a = this.lenHist.slice(-300).sort((x, y) => x - y); return a[Math.floor(a.length * 0.9)];
  }
  reset() { this.bg = null; this.frames = 0; this.samples = []; this.lenHist = []; this.pose = []; this.lastAng = null; this.swings = []; this._peak = null; this.signStats = { 1: [], '-1': [] }; this.faceVotes = []; this.speed = 0; }

  // 骨格の結果(元の映像の座標)を受け取る。kp: [[x,y,score]×17]
  addPose(t, kp, videoW) {
    if (!kp) return;
    const k = this.W / videoW, ok = (j) => kp[j][2] > 0.2;
    const ws = [9, 10].filter(ok); if (!ws.length) return;
    const hand = [ws.reduce((m, j) => m + kp[j][0], 0) / ws.length * k, ws.reduce((m, j) => m + kp[j][1], 0) / ws.length * k];
    const hips = [11, 12].filter(ok), hipY = hips.length ? hips.reduce((m, j) => m + kp[j][1], 0) / hips.length * k : null;
    const ears = [3, 4].filter(ok), faceX = ok(0) && ears.length ? kp[0][0] - ears.reduce((m, j) => m + kp[j][0], 0) / ears.length : null;
    this.pose.push({ t, hand, hipY }); if (this.pose.length > 40) this.pose.shift();
    if (faceX != null && Math.abs(faceX) > 3) { this.faceVotes.push(Math.sign(faceX)); if (this.faceVotes.length > 50) this.faceVotes.shift(); }
  }
  // 人(骨格)が最近見えているか。骨格を使う設定で、0.6秒以上見えていなければ測らない(誰もいない部屋で、家具を道具と取り違えて数えていた。2026-11-22 中山さんの実機)
  personSeen(t) { const P = this.pose; return P.length > 0 && t - P[P.length - 1].t < 0.6; }
  handAt(t) { // 骨格の両手の位置を、時刻 t に合わせて直線でつなぐ(少し先までなら伸ばす)
    const P = this.pose; if (!P.length) return null;
    if (P.length === 1 || t <= P[0].t) return Math.abs(t - P[0].t) < 0.3 ? P[0].hand : null;
    let i = P.length - 1; while (i > 0 && P[i - 1].t > t) i--;
    const a = P[Math.max(0, i - 1)], b = P[i]; if (b.t === a.t) return b.hand;
    let u = (t - a.t) / (b.t - a.t); if (u > 1.5) return null; u = Math.min(u, 1.2);
    return [a.hand[0] + (b.hand[0] - a.hand[0]) * u, a.hand[1] + (b.hand[1] - a.hand[1]) * u];
  }

  // 1コマを処理する。t は実際のコマの時刻(秒)
  process(video, t, { keepDebug = false } = {}) {
    const vw = video.videoWidth, vh = video.videoHeight; if (!vw) return null;
    const W = this.W, H = this.H || (this.H = Math.round(vh * W / vw));
    if (this.cv.width !== W) { this.cv.width = W; this.cv.height = H; }
    this.cx.drawImage(video, 0, 0, W, H);
    const px = this.cx.getImageData(0, 0, W, H).data, N = W * H;
    if (!this.bg) { this.bg = new Float32Array(N * 3); for (let i = 0, o = 0; i < N * 4; i += 4) { this.bg[o++] = px[i]; this.bg[o++] = px[i + 1]; this.bg[o++] = px[i + 2]; } }
    const alpha = this.frames < 20 ? 0.15 : 0.04, upd = this.frames < 20 || (this.frames & 1) === 0; this.frames++; // 背景は2コマに1回だけ直す(軽くする)
    const pz = this.pose.length ? this.pose[this.pose.length - 1] : null;
    const hand = this.handAt(t) || (pz && pz.hand);
    const ylim = pz ? Math.min(pz.hipY != null ? pz.hipY : 1e9, (hand ? hand[1] : 1e9) + H * 0.11) : H;
    const mask = new Uint8Array(N), bg = this.bg, mode = this.color; let changed = 0;
    for (let y = 0, i = 0, o = 0, p = 0; y < H; y++) {
      for (let x = 0; x < W; x++, i += 4, o += 3, p++) {
        const r = px[i], g = px[i + 1], b = px[i + 2];
        const d = Math.max(Math.abs(r - bg[o]), Math.abs(g - bg[o + 1]), Math.abs(b - bg[o + 2]));
        if (d > 25) { changed++; if (y < ylim && isToolColor(r, g, b, mode)) mask[p] = 1; }
        if (upd) { bg[o] += (r - bg[o]) * alpha; bg[o + 1] += (g - bg[o + 1]) * alpha; bg[o + 2] += (b - bg[o + 2]) * alpha; }
      }
    }
    // 画面の3割以上が背景と違う = スマホが動いた・明るさが変わった。このコマは使わず、背景を早めに作り直す
    if (changed > N * 0.3) { this.frames = Math.min(this.frames, 10); this.lastAng = null; this.samples.push({ t, ang: null }); if (this.samples.length > 240) this.samples.shift(); this.shaky = true; this._update(); return null; }
    this.shaky = false;
    // 骨格を使う設定で人が見えていないときは、測らない
    if (this.needPerson && !this.personSeen(t)) { this.lastAng = null; this.samples.push({ t, ang: null }); if (this.samples.length > 240) this.samples.shift(); this._update(); return null; }
    // かたまりに分け、いちばん「細長く大きい」もの(手元に近ければ加点)を道具とする
    const lab = new Int32Array(N), stack = new Int32Array(N); let best = null, bestScore = 0, nlab = 0;
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
      // 形で道具をはじくのはやめた(ぶれた道具と手の肌がつながると太く見え、本物まで落ちた)。誰もいない部屋の取り違えは、人が見えないとき測らないことで防ぐ
      let score = Math.sqrt(l1) * Math.sqrt(n) * Math.pow(l1 / l2, 0.25);
      if (hand) { // 手元からいちばん近い点までの距離
        let dmin = 1e9; for (let q = 0; q < pts.length; q += 3) { const dx = pts[q] % W - hand[0], dy = ((pts[q] / W) | 0) - hand[1]; dmin = Math.min(dmin, dx * dx + dy * dy); }
        dmin = Math.sqrt(dmin); score *= dmin < W * 0.06 ? 2 : dmin < W * 0.15 ? 1 : 0.3;
      }
      if (score > bestScore) { bestScore = score; best = { n, mx, my, cxx, cyy, cxy, l1, pts }; }
    }
    let ang = null, len = null, edge = false, p0 = null, p1 = null;
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
      // 手元の判定と前のコマの向きが食い違う(160度以上の飛び)ときは、前のコマの向きを信じる(1コマで半回転はしない)
      if (this.lastAng != null) {
        const dd = Math.atan2(Math.sin(a - this.lastAng), Math.cos(a - this.lastAng));
        if (Math.abs(dd) > 2.8) a = tipFirst ? cand[1] : cand[0];
        const d2 = Math.atan2(Math.sin(a - this.lastAng), Math.cos(a - this.lastAng)); a = this.lastAng + d2; // 続けてつなぐ
      }
      ang = a; this.lastAng = a;
      const tip = Math.cos(Math.atan2(p1[1] - p0[1], p1[0] - p0[0]) - a) > 0 ? p1 : p0; edge = tip[0] < 2 || tip[1] < 2 || tip[0] > W - 3 || tip[1] > H - 3;
      // 長さ(画素)は、両手の真ん中から剣先まで。骨格が無いときは、かたまり全体の長さ(手の肌も入るので、少し長めに出る)
      len = hand ? Math.hypot(tip[0] - hand[0], tip[1] - hand[1]) : hi - lo;
      if (!edge && len < H * 0.85) { this.lenHist.push(len); if (this.lenHist.length > 600) this.lenHist.shift(); } // 画面の高さに近い長さは、取り違え(近づいて来た人など)として使わない
    }
    let tipPt = null;
    if (ang != null) { const Lp = this.lenPx; tipPt = hand && Lp ? [hand[0] + Lp * Math.cos(ang), hand[1] + Lp * Math.sin(ang)] : (Math.cos(Math.atan2(p1[1] - p0[1], p1[0] - p0[0]) - ang) > 0 ? p1 : p0); }
    this.samples.push({ t, ang, len, edge, hand, tip: tipPt }); if (this.samples.length > 240) this.samples.shift();
    if (keepDebug) this.debug = { mask, W, H, p0, p1, ang, hand };
    this._update();
    return { ang, len, edge };
  }

  // ならした向きから、回る速さと剣先の速さ(少し前の時刻)を出す。2次の多項式(9点)の傾き
  _update() {
    const S = this.samples, m = 4, n = S.length; if (n < 2 * m + 3) return;
    const c = n - 2 - m, win = S.slice(c - m, c + m + 1); if (win.some((s) => s.ang == null)) { this.speed *= 0.8; this._peak = null; return; }
    const t0 = win[m].t; let sk2 = 0, skx = 0, sky = 0, nh = 0; const H = [];
    for (let k = -m; k <= m; k++) { const s = win[k + m], dt = s.t - t0; sk2 += dt * dt; }
    // 回る速さ: 向きを2次の多項式(9点)でならし、その前後1コマの差。9点の直線の傾きより、最速の瞬間がつぶれにくい
    let omega = 0;
    if (c - m - 1 >= 0 && c + m + 1 < n && S[c - m - 1].ang != null && S[c + m + 1].ang != null) {
      const CF = [-21, 14, 39, 54, 59, 54, 39, 14, -21].map((x) => x / 231), sm = (cc) => { let v = 0; for (let k = -m; k <= m; k++) v += CF[k + m] * S[cc + k].ang; return v; };
      omega = (sm(c + 1) - sm(c - 1)) / ((S[c + 1].t - S[c - 1].t) || 1e-3);
    } else { let skA = 0; for (let k = -m; k <= m; k++) skA += (win[k + m].t - t0) * win[k + m].ang; omega = skA / (sk2 || 1); }
    // 手元の速さ(骨格があるとき)。画素→mは道具の見えた長さから
    let vhx = 0, vhy = 0; const Lp = this.lenPx;
    if (Lp) {
      const mpp = this.effM / Lp;
      for (let k = -m; k <= m; k++) { const s = win[k + m]; const h = this.handAt(s.t); if (!h) { nh = -1; break; } H.push([s.t - t0, h]); }
      if (nh === 0 && H.length) { for (const [dt, h] of H) { skx += dt * h[0]; sky += dt * h[1]; } vhx = skx / sk2 * mpp; vhy = sky / sk2 * mpp; }
    }
    const a = win[m].ang, L = this.effM;
    const vx = vhx - omega * L * Math.sin(a), vy = vhy + omega * L * Math.cos(a);
    const v = Math.hypot(vx, vy), lenC = win[m].len; this.speed = v; this.omega = omega; this.speedT = t0; this.tipVx = vx;
    // 1本の区切り: 3m/秒を超えてから、最高の6割を切ったら、その最高を1本とする
    if (!this._peak) { if (v > 3) this._peak = { v, t: t0, sign: Math.sign(omega), vx, len: lenC }; }
    else {
      if (v > this._peak.v) Object.assign(this._peak, { v, t: t0, sign: Math.sign(omega) || this._peak.sign, vx, len: lenC });
      else if (v < this._peak.v * 0.6) {
        const pk = this._peak; this._peak = null;
        // 道具がはっきり見えていた(見えた長さが、ふだんの長さの4割〜1.5倍)ときだけ数える。歩いて近づく・道具を置くなどの動きを数えない
        const Lp = this.lenPx, seen = Lp && pk.len != null && pk.len > Lp * 0.4 && pk.len < Lp * 1.5;
        if (pk.v >= 4 && seen && this.frames > 30) { this.signStats[pk.sign].push(pk.v); this.swings.push(pk); if (this.swings.length > 200) this.swings.shift(); if (this.onSwing) this.onSwing(pk); }
      }
    }
  }
  // 振り下ろしの回る向き: 速いほうの向き(直近10本ずつの平均)
  downSign() {
    // 顔の向きで決める方法は、縮めた画像では鼻と耳の差が数画素しかなく、逆に出ることがあった。速いほうの向きだけで決める(素振りは振り下ろしのほうが速い)
    const avg = (a) => (a.length ? a.slice(-10).reduce((x, y) => x + y, 0) / Math.min(10, a.length) : 0);
    return avg(this.signStats[1]) >= avg(this.signStats[-1]) ? 1 : -1;
  }
  isDown(sw) { return sw.sign === this.downSign(); }
}
