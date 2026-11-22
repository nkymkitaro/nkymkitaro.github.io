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
    this.W = width; this.H = 0; this.targetPx = width * Math.round(width * 9 / 16); this.lengthCm = lengthCm; this.color = color;
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
    this.faceVotes = []; this.torsoHist = []; this.rejects = 0;
    this.debug = null; // { mask, comp, a, p0, p1 }
  }
  setLength(cm) { this.lengthCm = cm; }
  setColor(c) { this.color = c; }
  setWidth(w) { if (w !== this.W) { this.W = w; this.H = 0; this.reset(); } }
  get effM() { return Math.max(0.2, (this.lengthCm - GRIP_CM) / 100); }
  get lenPx() {
    if (this.lenHist.length < 5) return null;
    const a = this.lenHist.slice(-300).sort((x, y) => x - y); return a[Math.floor(a.length * 0.75)]; // 上から25%の長さ(取り違えの長い値に引っぱられにくい)
  }
  reset() { this.bg = null; this.frames = 0; this.samples = []; this.lenHist = []; this.pose = []; this.lastAng = null; this.swings = []; this._peak = null; this.signStats = { 1: [], '-1': [] }; this.faceVotes = []; this.torsoHist = []; this.rejects = 0; this.speed = 0; this.speeds = { tip: 0, mono: 0, hand: 0 }; }

  // 骨格の結果(元の映像の座標)を受け取る。kp: [[x,y,score]×17]
  addPose(t, kp, videoW) {
    if (!kp) return;
    const k = this.W / videoW, ok = (j) => kp[j][2] > 0.2;
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
  // 人(骨格)が最近見えているか。骨格を使う設定で、0.6秒以上見えていなければ測らない(誰もいない部屋で、家具を道具と取り違えて数えていた。2026-11-22 中山さんの実機)
  get torso() { const a = this.torsoHist.slice().sort((x, y) => x - y); return a.length >= 3 ? a[a.length >> 1] : null; }
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
    // 処理する画像の大きさは、画素の数を一定(約5.8万)にそろえる。縦長の映像で幅320のままだと、横長の2.4倍の画素になり重かった(2026-11-22 実機で1コマ32ms)
    if (this.H && (vw !== this.vw || vh !== this.vh)) { this.H = 0; this.bg = null; this.frames = 0; this.lenHist = []; this.lastAng = null; } // 映像の大きさが変わった(カメラの頼み直し・向きの変更)
    this.vw = vw; this.vh = vh;
    if (!this.H) { this.W = Math.max(120, Math.round(Math.sqrt(this.targetPx * vw / vh))); this.H = Math.round(vh * this.W / vw); }
    const W = this.W, H = this.H;
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
      let score = Math.sqrt(l1) * Math.sqrt(n) * Math.pow(l1 / l2, 0.25), near = null, length = 0;
      if (hand) {
        // 道具は「手元の近くから始まり、胴の約1〜3倍の長さで、細い」。腕・服・家具は、これで落とす(振っていないのにメーターが動いていた。2026-11-22 実機)
        // 骨格は1秒数回なので、速い振りの最中は手元の位置が数十画素ずれる。そこで手元そのものではなく「かたまりの手元側の端」を起点にする
        const a0 = 0.5 * Math.atan2(2 * cxy, cxx - cyy), ux = Math.cos(a0), uy = Math.sin(a0);
        let lo = 1e9, hi = -1e9; for (let q = 0; q < pts.length; q += 2) { const pr = (pts[q] % W - mx) * ux + (((pts[q] / W) | 0) - my) * uy; if (pr < lo) lo = pr; if (pr > hi) hi = pr; }
        const e0 = [mx + ux * lo, my + uy * lo], e1 = [mx + ux * hi, my + uy * hi], d0 = Math.hypot(e0[0] - hand[0], e0[1] - hand[1]), d1 = Math.hypot(e1[0] - hand[0], e1[1] - hand[1]);
        near = d0 <= d1 ? e0 : e1; const dmin = Math.min(d0, d1); length = hi - lo;
        const T = this.torso, Lp = this.lenPx, ref = Lp && this.lenHist.length > 30 ? Lp / 1.8 : T;
        if (ref) {
          const R = this.why || (this.why = { far: 0, short: 0, long: 0, thick: 0, ok: 0 });
          if (dmin > ref * 0.9) { R.far++; continue; }                         // 手元から離れている
          if (length < ref * (ref === T ? 0.6 : 0.9)) { R.short++; continue; }  // 短い(腕・手だけ)
          if (length > ref * 3.6) { R.long++; continue; }                      // 長すぎる
          if (n / Math.max(1, length) > ref * 0.3) { R.thick++; continue; }    // 太すぎる(ぶれた道具の扇は通す幅)
          R.ok++;
        }
        score = length * Math.sqrt(n) * (dmin < (ref || W) * 0.3 ? 2 : 1);
      }
      if (score > bestScore) { bestScore = score; best = { n, mx, my, cxx, cyy, cxy, l1, pts, near, length }; }
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
        const S0 = this.samples[this.samples.length - 1], dt = S0 ? Math.max(0.008, t - S0.t) : 0.017;
        if (Math.abs(d2) > (2000 * dt + 20) * Math.PI / 180 && this.rejects < 3) { jump = true; this.rejects++; }
        else { this.rejects = 0; a = this.lastAng + d2; }
      }
      if (!jump) { ang = a; this.lastAng = a; }
      const tip = Math.cos(Math.atan2(p1[1] - p0[1], p1[0] - p0[0]) - a) > 0 ? p1 : p0; edge = tip[0] < 2 || tip[1] < 2 || tip[0] > W - 3 || tip[1] > H - 3;
      // 長さ(画素)は、両手の真ん中から剣先まで。骨格が無いときは、かたまり全体の長さ(手の肌も入るので、少し長めに出る)
      len = hand ? Math.hypot(tip[0] - hand[0], tip[1] - hand[1]) : hi - lo;
      if (!edge && len < H * 0.85) { this.lenHist.push(len); if (this.lenHist.length > 600) this.lenHist.shift(); } // 画面の高さに近い長さは、取り違え(近づいて来た人など)として使わない
    }
    let tipPt = null;
    if (ang != null) { const Lp = this.lenPx; tipPt = hand && Lp ? [hand[0] + Lp * Math.cos(ang), hand[1] + Lp * Math.sin(ang)] : (Math.cos(Math.atan2(p1[1] - p0[1], p1[0] - p0[0]) - ang) > 0 ? p1 : p0); }
    this.seenN = (this.seenN || 0) + (ang != null ? 1 : 0); this.allN = (this.allN || 0) + 1; // 道具が見えたコマの数(画面の「道具 ○%」)
    this.samples.push({ t, ang, len, edge, hand, tip: tipPt }); if (this.samples.length > 240) this.samples.shift();
    if (keepDebug) this.debug = { mask, W, H, p0, p1, ang, hand };
    this._update();
    return { ang, len, edge };
  }

  // ならした向きから、回る速さと剣先の速さ(少し前の時刻)を出す。前後4コマ(9点)に2次の式を当てはめた傾き。
  // 一番速い瞬間は、ぶれて道具が見えないコマが混じりやすい。9点のうち6点以上あれば、欠けたまま計算する(欠けると数えていなかった。2026-11-22 実機)
  _update() {
    // ならす幅は時間で決める(前後約0.07秒)。30コマのカメラでは前後2コマ、60コマでは前後4コマ。
    // コマ数で固定していると、30コマのカメラでは0.3秒もならして速い振りがつぶれ、欠けたコマで数えられなかった(2026-11-22 実機「取りこぼしが多い」)
    const S = this.samples, n = S.length; if (n < 8) return;
    const dts = []; for (let k = n - 6; k < n; k++) if (S[k] && S[k - 1]) dts.push(S[k].t - S[k - 1].t);
    const dtm = dts.sort((x, y) => x - y)[dts.length >> 1] || 1 / 60, m = Math.max(2, Math.min(4, Math.round(0.07 / dtm)));
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
    let vhx = 0, vhy = 0; const Lp = this.lenPx;
    if (Lp && this.lenHist.length > 30) {
      const mpp = this.effM / Lp, P = this.pose.filter((q) => Math.abs(q.t - t0) <= 0.2);
      if (P.length >= 2) {
        const tm = P.reduce((a2, q) => a2 + q.t, 0) / P.length, xm = P.reduce((a2, q) => a2 + q.hand[0], 0) / P.length, ym = P.reduce((a2, q) => a2 + q.hand[1], 0) / P.length;
        let stt = 0, stx = 0, sty = 0; for (const q of P) { const dt = q.t - tm; stt += dt * dt; stx += dt * (q.hand[0] - xm); sty += dt * (q.hand[1] - ym); }
        if (stt > 1e-6) { vhx = stx / stt * mpp; vhy = sty / stt * mpp; }
        const hv = Math.hypot(vhx, vhy); if (hv > 4) { vhx *= 4 / hv; vhy *= 4 / hv; } // 手元は速くても毎秒3m前後。骨格のゆれで大きく出たときは抑える(メーターが振り切れたままになっていた)
      }
    }
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
  _finishPeak() {
    const pk = this._peak; this._peak = null; if (!pk) return;
    // 道具かどうかは見つける段階で確かめている(手元から始まる・胴の1〜3倍の長さ・細い)。ここでは遅すぎる動き(4m/秒未満)と、始めの背景づくりの間を除く
    if (pk.v >= 4 && this.frames > 30) { this.signStats[pk.sign].push(pk.v); this.swings.push(pk); if (this.swings.length > 200) this.swings.shift(); if (this.onSwing) this.onSwing(pk); }
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
