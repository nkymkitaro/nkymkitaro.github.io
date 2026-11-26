// mode-wheel.js: 撮影画面の下の操作を「真ん中のボタン1つ+リボルバー切替」にする試験ページの部品(lab/mode-wheel.html だけが読む)。
// 仕様: claude/specs/var-symbol-spec.md / 見本: claude/design-samples/2026-11-05-mode-wheel-*.html
// 働きは新しく作らず、今の本番のボタンを押して使う(VAR=#btnRewind、録画=#labRec、ディレイ=⚙の秒数ボタン、止める=#btnDelayExit)。
// 新しい計測の出来事は足さない。映像は端末の中だけ。

const $ = (s, r = document) => r.querySelector(s);
const mod3 = (n) => ((n % 3) + 3) % 3;
const NAVY = '#0c1636';
const MODES = [
  { k: 'delay', lb: 'ディレイ' },
  { k: 'var', lb: 'VAR' },
  { k: 'rec', lb: '録画' },
];

// ---- 真ん中のボタンの形 ----
let uid = 0;
function diamond(fill) {
  // 角を丸めた菱形。中に下から白がたまる(fill = 0〜1)
  const id = `mwc${uid++}`; const c = 50; const r = 47; const k = 0.22;
  const P = [[c, c - r], [c + r, c], [c, c + r], [c - r, c]];
  const L = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  let d = '';
  for (let i = 0; i < 4; i++) {
    const p = P[i]; const a = L(p, P[(i + 3) % 4], k); const b = L(p, P[(i + 1) % 4], k);
    d += `${i ? 'L' : 'M'}${a}Q${p} ${b}`;
  }
  d += 'Z';
  const h = Math.max(0, Math.min(1, fill)) * 100;
  return `<svg viewBox="0 0 100 100" aria-hidden="true"><defs><clipPath id="${id}"><rect class="mw-fillclip" x="0" y="${100 - h}" width="100" height="${h}"/></clipPath></defs>`
    + `<path d="${d}" fill="rgba(255,255,255,.16)" stroke="rgba(255,255,255,.6)" stroke-width="2.5"/><path d="${d}" fill="#fff" clip-path="url(#${id})"/></svg>`;
}
const person = (x, op) => `<g transform="translate(${x} 52) scale(1.25)" opacity="${op}"><circle cx="0" cy="-13" r="6" fill="${NAVY}"/><rect x="-7.5" y="-4" width="15" height="27" rx="7.5" fill="${NAVY}"/></g>`;
// 録画中・ディレイ中は、その働きの「止める」が真ん中(主役)。VARは横の小さなボタンへ(中山さん 2026-11-14)
const SHAPE_ON = {
  rec: (t) => `<svg viewBox="0 0 88 88" width="88" height="88" aria-hidden="true"><circle cx="44" cy="44" r="40" fill="none" stroke="#fff" stroke-width="6"/><circle cx="44" cy="44" r="31" fill="#d6231b"/><rect x="33" y="24" width="22" height="22" rx="4" fill="#fff"/><text class="mw-t" x="44" y="69" text-anchor="middle" font-size="15" font-weight="800" fill="#fff" font-family="system-ui,sans-serif">${t}</text></svg>`,
  delay: (sec) => `<svg viewBox="0 0 100 100" width="86" height="86" aria-hidden="true"><rect x="4" y="4" width="92" height="92" rx="26" fill="#fff"/><rect x="38" y="20" width="24" height="24" rx="4" fill="${NAVY}"/><text x="50" y="74" text-anchor="middle" font-size="22" font-weight="800" fill="${NAVY}" font-family="system-ui,sans-serif">${sec}秒</text></svg>`,
};
const SHAPE = {
  rec: () => '<svg viewBox="0 0 88 88" width="88" height="88" aria-hidden="true"><circle cx="44" cy="44" r="40" fill="none" stroke="#fff" stroke-width="6"/><circle cx="44" cy="44" r="31" fill="#d6231b"/></svg>',
  delay: () => `<svg viewBox="0 0 100 100" width="86" height="86" aria-hidden="true"><rect x="4" y="4" width="92" height="92" rx="26" fill="#fff"/>${person(40, 0.3)}${person(60, 1)}</svg>`,
};
// 横向きの名前の列で、選んでいないモードは文字でなく絵(中山さん 2026-11-05「文字のくどさ」)
const ICON_MODE = {
  rec: '<svg width="26" height="26" viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="12" cy="12" r="9" stroke="rgba(201,210,238,.75)" stroke-width="2"/><circle cx="12" cy="12" r="4.5" fill="#d6231b"/></svg>',
  delay: '<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke-width="2" aria-hidden="true"><rect x="8" y="4" width="12" height="12" rx="3" stroke="rgba(201,210,238,.4)"/><rect x="4" y="8" width="12" height="12" rx="3" stroke="rgba(201,210,238,.85)"/></svg>',
  var: 'VAR',
};
// 横向きで選んでいるとき(白い札の上)の絵。紺で描く
const ICON_MODE_SEL = {
  rec: '<svg width="28" height="28" viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="12" cy="12" r="9" stroke="#0c1636" stroke-width="2.4"/><circle cx="12" cy="12" r="4.8" fill="#d6231b"/></svg>',
  delay: '<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke-width="2.4" aria-hidden="true"><rect x="8" y="4" width="12" height="12" rx="3" stroke="rgba(12,22,54,.45)"/><rect x="4" y="8" width="12" height="12" rx="3" stroke="#0c1636"/></svg>',
};
// 横向きで選んでいるときの絵(2026-11-26: 白い平行四辺形の札をやめ、白い線の絵+左の白い印に。札が狭い列で窮屈だった)
const ICON_MODE_ON = {
  rec: ICON_MODE.rec.replace('rgba(201,210,238,.75)', '#fff').replace('stroke-width="2"', 'stroke-width="2.4"'),
  delay: ICON_MODE.delay.replace('rgba(201,210,238,.4)', 'rgba(255,255,255,.55)').replace('rgba(201,210,238,.85)', '#fff').replace('stroke-width="2"', 'stroke-width="2.4"'),
};
const stopIcon = (c) => `<svg width="22" height="22" viewBox="0 0 22 22" aria-hidden="true"><rect x="2" y="2" width="18" height="18" rx="3" fill="${c}"/></svg>`;
const ICON_LIST = '<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="6" width="14" height="14" rx="3"/><path d="M7 3h11a3 3 0 0 1 3 3v11"/><path d="M8.5 10.5l4 2.5-4 2.5z" fill="#fff"/></svg>';
const ICON_FS = '<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg>';
const ICON_GEAR = '<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linejoin="round" aria-hidden="true"><path d="M18.93 9.39 L21.80 10.01 L21.80 13.99 L18.93 14.61 L18.74 15.05 L20.33 17.53 L17.53 20.33 L15.05 18.74 L14.61 18.93 L13.99 21.80 L10.01 21.80 L9.39 18.93 L8.95 18.74 L6.47 20.33 L3.67 17.53 L5.26 15.05 L5.07 14.61 L2.20 13.99 L2.20 10.01 L5.07 9.39 L5.26 8.95 L3.67 6.47 L6.47 3.67 L8.95 5.26 L9.39 5.07 L10.01 2.20 L13.99 2.20 L14.61 5.07 L15.05 5.26 L17.53 3.67 L20.33 6.47 L18.74 8.95 Z"/><circle cx="12" cy="12" r="3"/></svg>';

function init() {
  const app = window.kendoVarApp;
  const area = $('#monitorArea');
  if (!app || !area) return;
  document.documentElement.setAttribute('data-fs-any-tap', '');
  document.body.classList.remove('lefty'); // 「左手で使う」はモードホイールに未対応。直すまで効かせない(⚙の切り替えも隠す。保存した設定は消さない) // 撮影画面のどこを押しても全画面に(js/app.js が見る)
  const landMq = window.matchMedia('(orientation: landscape) and (max-height: 540px)');
  const isLand = () => landMq.matches;
  const step = () => (isLand() ? 56 : 112); // 札1つ分の送り幅

  const root = document.createElement('div');
  root.className = 'mw';
  root.innerHTML = `<div class="mw-zone"></div>
    <div class="mw-top"><div class="mw-secs"></div><button type="button" class="mw-ic" id="mwList" aria-label="一覧">${ICON_LIST}</button><button type="button" class="mw-ic" id="mwGear" aria-label="設定">${ICON_GEAR}</button></div>
    <button type="button" class="mw-ic mw-flip" id="mwFlip" aria-label="カメラを切り替え" hidden></button>
    <button type="button" class="mw-ic mw-fs" id="mwFs" aria-label="全画面" hidden>${ICON_FS}</button>
    <div class="mw-slot dl" hidden><button type="button" class="bx vrb" aria-label="ディレイ"><div class="shape"></div></button><span class="lb"></span></div>
    <div class="mw-slot rc" hidden><button type="button" class="bx vrb" aria-label="録画"><div class="shape"></div></button><span class="lb"></span></div>
    <div class="mw-slot vr" hidden><button type="button" class="bx vrb" aria-label="VAR"><div class="shape"></div></button><span class="lb">VAR</span></div>
    <button type="button" class="mw-main" aria-label="VAR"><div class="shape"></div></button>
    <div class="mw-wheel" role="listbox" aria-label="モード"></div>
    <div class="mw-note" role="status"></div>
    <img class="mw-logo" src="icons/logo-mitori-onscreen.png" alt="MITORI" draggable="false">`;
  area.appendChild(root);
  const q = (s) => $(s, root);
  const wheel = q('.mw-wheel'); const main = q('.mw-main'); const shape = q('.mw-main .shape'); const secs = q('.mw-secs');
  const slotDl = q('.mw-slot.dl'); const slotRc = q('.mw-slot.rc'); const slotVr = q('.mw-slot.vr'); const note = q('.mw-note');

  const st = { pos: 1, rec: false, delay: false, recT: 0, delaySec: 10, open: false };
  let cur = -1; let userTurn = false; let pending = null; let wasFull = false;

  // ---- 今の本番の状態と設定を読む・押す ----
  const rewindBtns = () => [...document.querySelectorAll('#rewindSecSelector button')].filter((b) => /^(15|30)秒$/.test(b.textContent.trim()));
  const delayBtns = () => [...document.querySelectorAll('#delaySecSelector button')];
  const secOf = (b) => parseInt(b.textContent, 10);
  const rewindSec = () => { const a = rewindBtns().find((b) => b.classList.contains('btn-active')); return a ? secOf(a) : 15; };
  const delayOpts = () => delayBtns().map(secOf);
  function delaySec() { const o = delayOpts(); if (o.length && !o.includes(st.delaySec)) st.delaySec = o[0]; return st.delaySec; }
  const fmt = (ms) => { const s = Math.floor(ms / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
  function showNote(t) { note.textContent = t; note.classList.add('show'); clearTimeout(showNote.t); showNote.t = setTimeout(() => note.classList.remove('show'), 1800); }

  // ---- 帯の言葉: LIVE / VAR 15秒前(RECの帯は出さない) ----
  // ディレイの帯「10秒前の映像」は js/app.js(updateDelayBand)が出す(中山さん 2026-11-22「シンプルに」。11-21 の「ディレイ:10秒おくれ」から変更)
  const band = $('#stateBand');
  function fixBand() {
    if (!band) return;
    const t = band.querySelector('.state-band-text'); if (!t) return;
    const s = band.dataset.state;
    let want = null;
    if (s === 'live') want = 'LIVE';
    else if (s === 'replay') want = `VAR ${rewindSec()}秒前`;
    if (want && t.textContent !== want) t.textContent = want;
  }
  // 小さい帯の「REC 0:12」も出さない(文字は書き換えず、印を付けて見た目だけ隠す)
  const subBand = $('#stateSubBand');
  function fixSub() {
    if (!subBand) return;
    const rec = /^REC\b/.test(subBand.textContent.trim());
    if (rec !== subBand.hasAttribute('data-rec')) subBand.toggleAttribute('data-rec', rec);
  }
  function fixAll() { fixBand(); fixSub(); }
  if (band) new MutationObserver(fixAll).observe(band, { attributes: true, childList: true, subtree: true, characterData: true });
  if (subBand) new MutationObserver(fixSub).observe(subBand, { childList: true, subtree: true, characterData: true });

  // ---- 描き直し ----
  function renderShape() {
    const k = MODES[cur].k;
    if (k === 'rec' && st.rec) shape.innerHTML = SHAPE_ON.rec(fmt(Date.now() - st.recT));
    else if (k === 'delay' && st.delay) shape.innerHTML = SHAPE_ON.delay(delaySec());
    else shape.innerHTML = k === 'var' ? diamond(fillNow()) : SHAPE[k]();
    main.setAttribute('aria-label', k === 'rec' && st.rec ? '録画を止める' : k === 'delay' && st.delay ? 'ディレイを止める' : MODES[cur].lb);
    main.classList.remove('dim'); // ディレイ中もVARを使える(2026-11-06の仕組み。止めを外した 2026-11-14)
  }
  function fillNow() {
    if (st.delay) return 1; // ディレイ中は、ディレイ用にためている動画からVARで戻れる(2026-11-06の仕組み)
    try {
      const frames = app.recorder.getFrames(app.cameraLink.activeSource);
      if (frames.length < 2) return 0;
      return Math.min(1, ((frames[frames.length - 1].ts - frames[0].ts) / 1000) / rewindSec());
    } catch (err) { return 0; }
  }
  function updateFill() {
    if (!slotVr.hidden) { const r2 = slotVr.querySelector('.mw-fillclip'); const f2 = fillNow(); if (r2) { r2.setAttribute('y', 100 - f2 * 100); r2.setAttribute('height', f2 * 100); } }
    if (MODES[cur].k !== 'var') return;
    const f = fillNow(); const r = shape.querySelector('.mw-fillclip');
    if (r) { r.setAttribute('y', 100 - f * 100); r.setAttribute('height', f * 100); }
    const full = f >= 0.999;
    if (full && !wasFull) { main.classList.remove('full'); void main.offsetWidth; main.classList.add('full'); }
    wasFull = full;
  }
  function renderSecs() {
    const k = MODES[cur].k;
    if (k === 'rec' || (k === 'var' && st.delay)) { secs.innerHTML = ''; return; } // ディレイ中はVARの秒数は出さない(左上の帯とも重ならない)。ディレイの秒数は、ディレイ中も出して、押せば止めずに切り替える(2026-11-22)
    const opts = k === 'var' ? rewindBtns().map(secOf) : delayOpts();
    if (!opts.length) { secs.innerHTML = ''; return; }
    const curV = k === 'var' ? rewindSec() : delaySec();
    const list = st.open ? opts : [curV];
    secs.innerHTML = `<div class="mw-chip${st.open ? '' : ' closed'}">${list.map((o) => `<button type="button" class="${o === curV ? 'sel' : ''}" data-v="${o}">${o}</button>`).join('')}</div>`;
    secs.querySelectorAll('button').forEach((b) => { b.onclick = (ev) => {
      ev.stopPropagation();
      if (!st.open) { st.open = true; renderSecs(); return; }
      const v = Number(b.dataset.v);
      if (k === 'var') { const t = rewindBtns().find((x) => secOf(x) === v); if (t) t.click(); }
      else { st.delaySec = v; if (st.delay) { const t = delayBtns().find((x) => secOf(x) === v); if (t) t.click(); } } // ディレイ中は、元の秒数のボタンを押す(js/app.js が止めずに切り替える)
      st.open = false; renderShape(); renderSecs(); fixBand(); updateSlots();
    }; });
  }
  // カメラにそろえる(案A。中山さん 2026-11-15): モードは下の名前で切り替え、始める・止めるは真ん中だけ。
  // 真ん中の左=録画の一覧、右=自撮り(Pixelのカメラと同じ並び)。真ん中にいない働きが動いている間だけ、その席に小さな「止める」を出す(録画=左、ディレイ=右)
  const seatRec = () => st.rec && MODES[cur] && MODES[cur].k !== 'rec';
  const seatDel = () => st.delay && MODES[cur] && MODES[cur].k !== 'delay';
  const slotSig = {};
  function updateSlots() {
    const k = MODES[cur] ? MODES[cur].k : '';
    slotVr.hidden = true;
    // 左: 録画の止める か 一覧
    { const el = slotRc; el.hidden = false; const r = seatRec(); const sig = r ? 'stop' : 'list';
      const sh = el.querySelector('.shape'); const bx = el.querySelector('.bx'); const lb = el.querySelector('.lb');
      if (slotSig.l !== sig) { slotSig.l = sig; sh.innerHTML = r ? stopIcon('#d6231b') : `<span class="mw-list">${ICON_LIST}</span>`; bx.setAttribute('aria-label', r ? '録画を止める' : '録画の一覧'); el.classList.toggle('stop', r); }
      lb.innerHTML = r ? `<span class="mw-blink">●</span> ${fmt(Date.now() - st.recT)}` : '一覧'; }
    // 右: ディレイの止める(なければ隠して、自撮りをその席に)
    { const el = slotDl; const d = seatDel(); el.hidden = !d;
      if (d) { const sh = el.querySelector('.shape'); const lb = el.querySelector('.lb');
        // 文字なしの絵: 真ん中のディレイと同じ白い角丸に、紺の止める(中山さん 2026-11-15「文言いるかな。絵で直感的に」)
        if (slotSig.r !== 'stop') { slotSig.r = 'stop'; sh.innerHTML = '<svg viewBox="0 0 100 100" width="100%" height="100%" aria-hidden="true"><rect x="4" y="4" width="92" height="92" rx="26" fill="#fff"/><rect x="34" y="34" width="32" height="32" rx="5" fill="#0c1636"/></svg>'; el.querySelector('.bx').setAttribute('aria-label', 'ディレイを止める'); el.classList.remove('stop'); }
        lb.textContent = ''; } else slotSig.r = ''; }
    if (k === 'rec' && st.rec) { const t = shape.querySelector('.mw-t'); if (t) t.textContent = fmt(Date.now() - st.recT); }
  }
  function renderAll() { renderShape(); renderSecs(); updateSlots(); drawWheel(); fixBand(); }

  // ---- 名前のホイール ----
  const items = [];
  for (let o = -2; o <= 2; o++) {
    const e = document.createElement('div'); e.className = 'm'; e.setAttribute('role', 'option');
    e.innerHTML = '<div class="sh"></div><div class="pl"></div><b></b>';
    wheel.appendChild(e); items.push({ e, o });
  }
  function drawWheel() {
    const W = step(); const base = Math.round(st.pos); const frac = st.pos - base; const land = isLand();
    items.forEach(({ e, o }) => {
      const mi = mod3(base + o); const x = (o - frac) * W; const a = Math.min(1, Math.abs(x) / W);
      const dot = MODES[mi].k === 'rec' && st.rec ? '<i class="rec"></i>' : MODES[mi].k === 'delay' && st.delay ? '<i class="dl"></i>' : '';
      const selNow = Math.abs(x) < W * 0.3;
      const k = MODES[mi].k;
      e.querySelector('b').innerHTML = (land && k !== 'var' ? (selNow ? ICON_MODE_ON[k] : ICON_MODE[k]) : MODES[mi].lb) + dot;
      e.style.transform = land ? `translateY(${x}px) rotateX(${x / W * 28}deg) scale(${1 - 0.16 * a})` : `translateX(${x}px) rotateY(${-x / W * 28}deg) scale(${1 - 0.16 * a})`;
      e.style.opacity = Math.abs(x) > W * 1.5 ? 0 : Math.max(0, 1 - 0.25 * Math.abs(x) / W); // 選んでいない名前も読めるように(2026-11-26。前は0.55まで薄くしていた)。横は3つだけ見せる(同じ名前が2回出ていた)
      e.classList.toggle('sel', Math.abs(x) < W * 0.3);
      e.setAttribute('aria-selected', String(Math.abs(x) < W * 0.3));
    });
    const ci = mod3(base);
    if (ci !== cur) { const prev = cur; cur = ci; onMode(prev); }
  }
  function onMode(prev) {
    st.open = false; wasFull = false;
    if (prev >= 0) {
      const dir = mod3(cur - prev) === 1 ? 1 : -1;
      main.style.setProperty('--r', `${dir * 120}deg`);
      const o = document.createElement('div'); o.className = 'out'; o.innerHTML = shape.innerHTML; main.appendChild(o);
      setTimeout(() => o.remove(), 220);
      try { navigator.vibrate && navigator.vibrate(10); } catch (err) { /* 振動が使えない端末は、見た目だけ */ }
    }
    renderShape(); main.classList.remove('swap'); void main.offsetWidth; main.classList.add('swap');
    renderSecs(); updateSlots();
  }
  let anim = null;
  function snapTo(target, D = 380) {
    cancelAnimationFrame(anim);
    const from = st.pos; const t0 = performance.now();
    const ease = (t) => { const c1 = 1.7; const c3 = c1 + 1; return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2); };
    (function f(now) {
      const t = Math.max(0, Math.min(1, (now - t0) / D));
      st.pos = from + (target - from) * ease(t); drawWheel();
      if (t < 1) anim = requestAnimationFrame(f); else { st.pos = target; drawWheel(); }
    })(t0);
  }
  const nearestPos = (idx) => { const base = Math.round(st.pos); for (const c of [base - 1, base, base + 1]) if (mod3(c) === idx) return c; return base; };

  // 回す(縦向き=左右、横向き=上下)。タップは、その名前へ回す
  let drag = null;
  const coord = (e) => (isLand() ? e.clientY : e.clientX);
  wheel.addEventListener('pointerdown', (e) => { drag = { c: coord(e), p: st.pos, moved: false }; wheel.setPointerCapture(e.pointerId); cancelAnimationFrame(anim); });
  wheel.addEventListener('pointermove', (e) => {
    if (!drag) return; const d = coord(e) - drag.c;
    if (Math.abs(d) > 4) drag.moved = true;
    st.pos = drag.p - d / step(); drawWheel();
  });
  wheel.addEventListener('pointerup', (e) => {
    if (!drag) return; const moved = drag.moved; const d = coord(e) - drag.c; drag = null;
    if (moved) snapTo(Math.abs(d) > 30 ? (d < 0 ? Math.floor(st.pos) + 1 : Math.ceil(st.pos) - 1) : Math.round(st.pos));
    else {
      const r = wheel.getBoundingClientRect();
      const mid = isLand() ? r.top + r.height / 2 : r.left + r.width / 2;
      const o = Math.round((coord(e) - mid) / step());
      if (o !== 0) snapTo(Math.round(st.pos) + o);
    }
  });
  wheel.addEventListener('pointercancel', () => { if (drag) { drag = null; snapTo(Math.round(st.pos)); } });

  // ---- 札が横の枠へ飛ぶ(録画・ディレイを始めたとき) ----
  function flyTo(label, slot, done) {
    const pr = root.getBoundingClientRect(); const wr = wheel.getBoundingClientRect(); const sr = slot.querySelector('.bx').getBoundingClientRect();
    const f = document.createElement('div'); f.className = 'mw-fly'; f.innerHTML = `<div class="pl"></div><b>${label}</b>`;
    const x0 = wr.left - pr.left + wr.width / 2 - 55; const y0 = wr.top - pr.top + wr.height / 2 - 22;
    f.style.left = `${x0}px`; f.style.top = `${y0}px`; root.appendChild(f);
    const dx = sr.left - pr.left + sr.width / 2 - (x0 + 55); const dy = sr.top - pr.top + sr.height / 2 - (y0 + 22);
    requestAnimationFrame(() => requestAnimationFrame(() => { f.style.transform = `translate(${dx}px,${dy}px) scale(.45)`; f.style.opacity = '.2'; }));
    setTimeout(() => { f.remove(); done(); }, 460);
  }

  // ---- 押したときの働き(今の本番のボタンを押す) ----
  const labRec = () => $('#labRec');
  main.addEventListener('click', () => {
    const k = MODES[cur].k;
    if (k === 'var') {
      const b = $('#btnRewind'); if (b) b.click();
      return;
    }
    if (k === 'rec') {
      if (!st.rec) pending = { key: 'rec', t: Date.now() };
      const b = labRec(); if (b) b.click();
      return;
    }
    if (k === 'delay') {
      if (st.delay) { const x = $('#btnDelayExit'); if (x) x.click(); return; }
      const t = delayBtns().find((b) => secOf(b) === delaySec());
      if (t) { pending = { key: 'delay', t: Date.now() }; t.click(); }
    }
  });
  slotRc.querySelector('.bx').addEventListener('click', () => { if (seatRec()) { const b = labRec(); if (b) b.click(); } else q('#mwList').click(); });
  const startDelay = () => { const t = delayBtns().find((b) => secOf(b) === delaySec()); if (t) t.click(); };
  slotVr.querySelector('.bx').addEventListener('click', () => { const b = $('#btnRewind'); if (b) b.click(); });
  slotDl.querySelector('.bx').addEventListener('click', () => { if (st.delay) { const x = $('#btnDelayExit'); if (x) x.click(); } });
  q('#mwGear').addEventListener('click', () => { const b = $('#btnSettings'); if (b) b.click(); });
  // 一覧ボタンは、録画の一覧だけを出す(最長・録画開始は出さない。録画はホイールから始める)。⚙の「録画の一覧と設定」から開いたときは今までどおり
  q('#mwList').addEventListener('click', () => { const b = $('#btnOpenRecList'); if (b) { document.body.classList.add('mw-listonly'); const sh = $('#labSheet'); const hd = sh && sh.querySelector('.help-sheet-handle'); if (hd && !sh.querySelector('.mw-sheet-title')) hd.insertAdjacentHTML('afterend', '<p class="mw-sheet-title">録画の一覧</p>'); b.click(); } });
  { const b = $('#btnOpenRecList'); if (b) b.addEventListener('click', (e) => { if (e.isTrusted) document.body.classList.remove('mw-listonly'); }); }
  // 「カメラを追加」は、文字をなくしてアイコンだけ(カメラ+)。読み上げの名前は残す
  { const a = $('#btnAddCamera'); const sv = a && a.querySelector('svg');
    if (sv) { sv.setAttribute('stroke-width', '2'); sv.setAttribute('stroke-linejoin', 'round'); sv.innerHTML = '<path d="M5 7h2.2l1.6-2.4h6.4L16.8 7H19a2.5 2.5 0 0 1 2.5 2.5v8A2.5 2.5 0 0 1 19 20H5a2.5 2.5 0 0 1-2.5-2.5v-8A2.5 2.5 0 0 1 5 7z"/><path d="M12 10.3v6.4M8.8 13.5h6.4"/>'; } }

  // 自撮り(カメラの切り替え): 元のボタン(#btnFlipCam。ディレイ中は #btnDelayFlip)を押して使う。映像の右下、ズームの上(中山さん 2026-11-06 案2)
  const flip = q('#mwFlip'); const flipSrc = () => $('#btnFlipCam'); const flipDelaySrc = () => $('#btnDelayFlip');
  // 自撮りの絵: カメラの形に、回る矢印2つ。元の絵は横に潰れて見えたので、カメラを高めにした(中山さん 2026-11-07)
  flip.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4.5 6.4H6.8Q7.5 6.4 7.9 5.7L8.6 4.6Q9 4.2 9.6 4.2H14.4Q15 4.2 15.4 4.6L16.1 5.7Q16.5 6.4 17.2 6.4H19.5A2.4 2.4 0 0 1 21.9 8.8V18.5A2.4 2.4 0 0 1 19.5 20.9H4.5A2.4 2.4 0 0 1 2.1 18.5V8.8A2.4 2.4 0 0 1 4.5 6.4Z"/><path d="M13.6 17.4A4.2 4.2 0 1 1 16.2 14.4"/><path d="M14.7 14.2L15.8 16.3L17.7 15.2"/></svg>'; // 自撮りの絵: 中山さんが描き直した形(線のカメラに、ひと回りの矢印。2026-11-07)
  flip.addEventListener('click', () => { const b = st.delay ? flipDelaySrc() : flipSrc(); if (b) b.click(); });
  // 一時停止・使い方は、⚙の中へ(ふだんは使わない)。元のボタンを押して使う
  { const sh = $('#settingsSheet'); const bar = $('#btnLefty');
    if (sh && bar) {
      const mk = (id, text, src) => { const b = document.createElement('button'); b.type = 'button'; b.id = id; b.className = 'link-btn prep-link'; b.textContent = text; b.addEventListener('click', () => { const o = $(src); if (o) { if (src === '#btnPauseAll') { const c = $('#btnCloseSettings'); if (c) c.click(); } o.click(); } }); return b; };
      // ズーム・自撮りのボタンを出すか(邪魔なら消せる。中山さん 2026-11-06)。この端末の中だけに覚える
      const KEY = 'kendoVar.mwCamTools';
      let on = true; try { on = localStorage.getItem(KEY) !== 'off'; } catch (err) { on = true; }
      const tg = document.createElement('button'); tg.type = 'button'; tg.id = 'mwCamTools'; tg.className = 'lefty-toggle'; tg.setAttribute('role', 'switch');
      tg.innerHTML = '<span>ズーム・自撮りのボタン</span><span class="lefty-knob" aria-hidden="true"></span>';
      const apply = () => { tg.setAttribute('aria-checked', String(on)); document.body.classList.toggle('mw-no-camtools', !on); };
      tg.addEventListener('click', () => { on = !on; try { localStorage.setItem(KEY, on ? 'on' : 'off'); } catch (err) { /* 覚えられない端末は、今だけ */ } apply(); });
      bar.after(tg); tg.after(mk('mwPause', '撮影を一時停止', '#btnPauseAll'), mk('mwHelp', '使い方', '#btnHelpInline')); apply(); // 並び: 左手で使う・ズームと自撮り(切り替え2つ)→ 一時停止・使い方
    } }

  // ---- 本番の状態を見て、合わせる ----
  function sync() {
    { const o = flipSrc(); flip.hidden = !o || o.hidden; }
    const rec = area.classList.contains('lab-recording');
    let del = false; try { del = !!app.player.delayMode; } catch (err) { del = false; }
    let changed = false;
    if (rec !== st.rec) { st.rec = rec; if (rec) st.recT = Date.now(); changed = true; if (rec && pending && pending.key === 'rec') startFly('rec'); }
    if (del !== st.delay) { st.delay = del; changed = true; if (del && pending && pending.key === 'delay') startFly('delay'); }
    // 真ん中の両横はいつもモードのボタン(案B')なので、カメラを追加などは、いつも録画+ディレイのときと同じ置き方(映像の左下)
    area.classList.toggle('mw-idle', false); area.classList.remove('mw-r', 'mw-d');
    if (pending && Date.now() - pending.t > 4000) pending = null;
    if (changed) {
      renderAll();
      // 真ん中にしていた働きが終わっても、そのモードのまま(録画を止めたら録画ボタン。中山さん 2026-11-14)
    } else { updateSlots(); updateFill(); fixAll(); }
  }
  function startFly(key) {
    pending = null;
    // 始めた働きが、そのまま真ん中の「止める」になる(横へ飛ばさない。VARは小さな横のボタンへ。中山さん 2026-11-14)
    snapTo(nearestPos(key === 'rec' ? 2 : 0), 200);
    renderAll();
    main.classList.remove('swap'); void main.offsetWidth; main.classList.add('swap');
  }
  // ---- 配置: 画面の大きさとカメラの縦横比から、映像とボタンの場所・大きさを決める(モック「撮影画面の配置モック」2026-11-05) ----
  // 縦向き: 映像は上にいっぱい(縦横比のまま)。残りの高さで真ん中のボタンを 88〜120px。下の帯は最低210px(足りなければ映像を小さく)
  // 横向き: 16:9 の映像を置いても右に120px以上残るなら16:9、残らなければ4:3。映像は左に高さいっぱい、残りの幅がボタンの列
  const stage = $('.stage-video');
  const px = (el, x, y, w, h, extra) => { if (!el) return; Object.assign(el.style, { position: el.dataset.mwFixed ? 'fixed' : 'absolute', left: `${Math.round(x)}px`, top: `${Math.round(y)}px`, right: 'auto', bottom: 'auto', margin: '0', ...(w != null ? { width: `${Math.round(w)}px`, height: `${Math.round(h)}px` } : {}), ...(extra || {}) }); };
  const clear = (el) => { if (el) ['position', 'left', 'top', 'right', 'bottom', 'margin', 'width', 'height', 'padding', 'zIndex', 'minWidth', 'transform'].forEach((k) => { el.style[k] = ''; }); };
  const videoAr = () => { const v = parseFloat(area.style.getPropertyValue('--video-ar')); return v > 0 ? v : (isLand() ? 4 / 3 : 3 / 4); };
  let wantAr = 0;
  async function askAspect(ar) {
    // 親機のカメラの取り込みの形を、画面の向きに合わせる(2026-11-14 直し)。
    // 縦向きは 4:3(縦持ちで3:4。センサーそのままの形で、映像が横幅いっぱいに入る)、横向きは画面に合わせて 16:9 か 4:3。
    // 短い辺の画素数(画質の設定で決まる: 標準480・高720・最大1440)はそのままにして、形だけ替える
    askAspect.last = ar;
    if (askAspect.busy) { askAspect.again = true; return; } // 頼んでいる途中なら、終わってからもう一度(後から来た頼みを捨てない)
    try {
      const v = app.cameraLink.localMonitorVideo; const tr = v && v.srcObject && v.srcObject.getVideoTracks()[0];
      if (!tr) return; // カメラの準備ができていない。次の fit() でもう一度
      // 短い辺は、画質の設定で決まる値(js/app.js の applyCaptureSize が覚える)。無ければ今の大きさ
      const g = tr.getSettings();
      const short = app.cameraLink.wantShort || Math.min(g.width || 0, g.height || 0) || 480;
      // 自撮りに切り替えるとカメラが新しくなり、形が元(16:9など)に戻って映像が小さくなっていた(2026-11-15)。カメラ・形・画質が替わったら、もう一度頼む
      if (ar === wantAr && tr.id === askAspect.trackId && short === askAspect.short) return;
      askAspect.trackId = tr.id; askAspect.short = short; wantAr = ar;
      askAspect.busy = true;
      await tr.applyConstraints({ width: { ideal: Math.round(short * ar) }, height: { ideal: short }, aspectRatio: { ideal: ar } }); // 形も添える(幅・高さだけだと、iPhoneが4:3のまま返すことがある)
    } catch (err) { /* 端末が出せない大きさなら、今のまま */ } finally {
      askAspect.busy = false;
      if (askAspect.again) { askAspect.again = false; askAspect(askAspect.last); }
    }
  }
  // 画質を替えたとき(起動時を含む)は、今の形のまま、短い辺だけ替えて頼み直す
  app.cameraLink.onCaptureSize = () => askAspect(askAspect.last || (innerWidth > innerHeight ? 16 / 9 : 4 / 3));
  const camBtn = $('#btnAddCamera'); const backBtn = $('#btnBackStart');
  [camBtn, backBtn, stage, secs, flip].forEach((b) => { if (b) b.dataset.mwFixed = '1'; });
  const logo = q('.mw-logo'); const LOGO_H = 18; // マーク(18px)+文字(13px)を1枚にしたロゴ(icons/logo-mitori-onscreen.png。元のロゴのままだと文字が潰れるため、文字を大きめに組み直した。2026-11-07)
  const bandEl = $('#stateBand'); const bandsEl = $('.stage-video .state-bands');
  const topRow = q('.mw-top');
  const safeProbe = document.createElement('div');
  safeProbe.style.cssText = 'position:fixed;left:0;bottom:0;width:0;height:0;visibility:hidden;padding-top:env(safe-area-inset-top);padding-left:env(safe-area-inset-left);padding-bottom:env(safe-area-inset-bottom);padding-right:env(safe-area-inset-right)';
  document.body.appendChild(safeProbe);
  // window.__mwSafe: 試験用(切り欠きのある端末を手元で再現する)
  const safe = () => { if (window.__mwSafe) return window.__mwSafe; const c = getComputedStyle(safeProbe); return { l: parseFloat(c.paddingLeft) || 0, t: parseFloat(c.paddingTop) || 0, b: parseFloat(c.paddingBottom) || 0, r: parseFloat(c.paddingRight) || 0 }; };
  const zoomBtn = () => $('#monitorArea .zoom-toggle'); const zoomBar = () => $('#monitorArea .zoom-host');
  function placeZoom(vx, vw, vh, both, flipHere) {
    // ボタンは映像の右下(48px)。スライダーは映像の下側で、ボタンの左。録画+ディレイ中は、左下のカメラを追加の上に上げる
    const zb = zoomBtn(); const zs = zoomBar();
    if (zb) { zb.dataset.mwFixed = '1'; px(zb, vx + vw - 12 - 48, vh - 12 - 48, 48, 48); }
    // 自撮りは、ズームの上(ズームのボタンが出ていなければ、その場所)
    const zShown = zb && getComputedStyle(zb).display !== 'none';
    if (flipHere) px(flip, vx + vw - 12 - 48, vh - 12 - 48 - (zShown ? 58 : 0), 48, 48, { borderRadius: '14px', background: '' });
    if (zs) { zs.dataset.mwFixed = '1'; const w = Math.min(380, vw - 12 - 48 - 12 - 12); px(zs, vx + vw - 12 - 48 - 12 - w, vh - 12 - 52 - (both && w > vw - 160 ? 64 : 0), w, 52); }
  }
  const fsBtn = q('#mwFs');
  const canFs = () => !!(document.fullscreenEnabled && document.documentElement.requestFullscreen) && !document.fullscreenElement && !window.matchMedia('(display-mode: standalone)').matches && !navigator.standalone;
  function fit() {
    const all = [fsBtn, stage, main, wheel, slotRc, slotDl, slotVr, secs, camBtn, backBtn, zoomBtn(), zoomBar(), topRow, flip, logo];
    if (area.classList.contains('replaying') || !document.body.classList.contains('mode-monitor')) { all.forEach(clear); fsBtn.hidden = true; return; }
    const W = window.innerWidth; const H = window.innerHeight; const land = isLand();
    const both = st.rec && st.delay;
    const flipOn = !flip.hidden && !document.body.classList.contains('mw-no-camtools');
    let camCorner = both; let landFlipSide = false;
    if (!land && bandsEl) bandsEl.style.left = '';
    let ar = videoAr(); let vx; let vw; let vh; let m; let mx; let my;
    root.classList.remove('mw-over'); // 列を映像に重ねる形はやめた(2026-11-26)。前の向きで付いたままだと、縦に戻したとき右に謎のグラデーションが残っていた
    // 向きを変えたのに、カメラの形が前の向きのまま(横の16:9のまま縦に戻した、など)なら、少し待って頼み直す(2026-11-26。Pixelの全画面で、縦に戻しても9:16のままだった)。
    // 出せない端末で頼み続けないよう、向きが変わるごとに3回まで
    if (fit.land !== land) { fit.land = land; fit.retry = 0; fit.since = Date.now(); }
    { const want = land ? (askAspect.last || 16 / 9) : 3 / 4; const now = Date.now();
      if (Math.abs(ar - want) > 0.05 && fit.retry < 3 && now - fit.since > 1500) { fit.retry++; fit.since = now; askAspect.trackId = null; askAspect(land ? (askAspect.last || 16 / 9) : 4 / 3); } }
    // 縦向き(2026-11-26 作り直し。中山さん「画面の大きさに合わせてボタンや帯も小さく。映像を最大限大きく」):
    // 映像は幅いっぱい(3:4。センサーを全部使う 11/14 の決定はそのまま)。ボタン・名前の帯は画面の大きさに合わせて伸び縮みする(押せる大きさは44px以上を守る)。
    // 上の段(←・ロゴ・秒数・⚙)は、映像の上に空きがあれば紺の上、なければ映像の上に重ねる。下の操作も、入らなければ映像の上に半透明で重ねる
    const compact = !land;
    root.classList.toggle('mw-compact', compact);
    if (compact) {
      fsBtn.hidden = true; clear(fsBtn); // 全画面ボタンは横だけ(縦は、触れば全画面)
      logo.style.visibility = '';
      askAspect(4 / 3);
      vw = W; vh = W / ar; if (vh > H) { vh = H; vw = H * ar; }
      vx = (W - vw) / 2;
      const sb = safe().b;
      const wh = Math.round(Math.max(40, Math.min(48, H * 0.054))); // 名前の帯の高さ
      const wheelY = H - wh - Math.max(8, sb + 4);
      m = Math.round(Math.max(56, Math.min(72, W * 0.17))); // 真ん中のボタン(標準のカメラのシャッターくらい)
      mx = (W - m) / 2; my = wheelY - 6 - m;
      const bx = Math.round(Math.max(44, Math.min(50, m * 0.7))); root.style.setProperty('--mw-bx', `${bx}px`);
      const upY = my - 8 - 44; // カメラを追加・ズームの段
      const need = safe().t + 8 + 44 + 6; // 上の段の高さ
      // 映像の置き場所: 上の段と下の操作(カメラを追加の段まで)の間に収まれば、映像に何も重ねない。収まらなければ上に詰めて重ねる
      const room = upY - 6 - vh;
      const vy = room >= need ? need : 0;
      px(stage, vx, vy, vw, vh, { padding: '0', zIndex: '0' });
      px(wheel, 0, wheelY, W, wh);
      const boxY = my + (m - bx) / 2 - 9; // 左右の席の丸の中心を、真ん中のボタンの中心にそろえる(下の名前の分 9px 上げる)
      const sw = bx + 26;
      px(slotRc, 8, boxY, sw, bx + 22); px(slotDl, W - 8 - sw, boxY, sw, bx + 22);
      clear(secs); clear(topRow);
      // 上の段は、1本の基準の高さ(rowY)にそろえる(2026-11-26 直し)。前は ←・⚙ が画面の切り欠きの下(JS と CSS の env)、
      // LIVEの帯が映像の上端(CSS の 8px)と、別々の基準で置いていたため、全画面などで切り欠きが大きいとき・映像が上端にあるときに段がずれた
      const rowY = safe().t + 6;
      const backOn = backBtn && getComputedStyle(backBtn).display !== 'none';
      if (backBtn) px(backBtn, 2, rowY, 44, 44, { background: 'transparent', boxShadow: 'none', zIndex: '6' });
      if (topRow) { const tw = topRow.getBoundingClientRect().width || 0; px(topRow, W - 8 - safe().r - tw, rowY - 2, null, null, { zIndex: '6' }); }
      if (vy > 0) { // 上の段は紺の上: ←・ロゴを並べ、LIVEの帯は映像の左上
        if (bandsEl) { bandsEl.style.left = ''; bandsEl.style.top = ''; }
        px(logo, backOn ? 50 : 12, rowY + (44 - LOGO_H) / 2, null, null);
      } else { // 映像の上に重ねる: ←とLIVEの帯を同じ段に並べ、ロゴは段の下に小さく
        if (bandsEl) { bandsEl.style.left = backOn ? '48px' : ''; bandsEl.style.top = `${rowY - vy + 6}px`; }
        px(logo, 12, rowY + 44 + 6, null, null);
      }
      flip.classList.toggle('mw-big', false);
      camCorner = true;
      if (camBtn) px(camBtn, 10, upY, 44, 44, { background: 'rgba(0,0,0,.45)', minWidth: '44px', borderRadius: '50%' });
      // 自撮り: 右の席(ディレイの止めるが出ているときは、ズームの上)
      if (flipOn && !seatDel()) px(flip, W - 8 - sw + (sw - bx) / 2, boxY, bx, bx, { borderRadius: '50%', background: '' });
      placeZoom(vx, vw, upY + 44 + 8, true, flipOn && seatDel());
      document.body.style.setProperty('--mw-toast-top', `${Math.max(70, upY - 56)}px`);
    } else {
      // 横向き(2026-11-26 作り直し。縦と同じ考え方): ボタンは画面の高さに合わせて伸び縮みし、右の列は要る幅だけにする。
      // 映像は高さいっぱい。列の分の幅が残れば16:9(横に広く大きく)、残らなければ4:3にして、列は映像の上に半透明で重ねる
      m = Math.round(Math.max(52, Math.min(76, H * 0.19)));
      const wheelW = 44; const gap = 8; const pad = 4; // 名前の列の幅(CSS の横向きの --mw-wheel-w と同じ。2026-11-26 に札をやめて58→44px)
      // 列の最小の幅(真ん中のボタン52px)。16:9が入る横長の画面は、いつも16:9(4:3にすると、映像が細く列が広くなる。iPhone SE+Safariのバーで、列が画面の4割になっていた。2026-11-26)
      const colMin = Math.round(12 + wheelW + gap + 52 + pad + safe().r);
      askAspect(W / H >= 1.6 ? 16 / 9 : 4 / 3);
      vh = H; vw = H * ar;
      let col = W - vw;
      // 列が入らないときは、ボタンを映像に重ねず、映像を少し小さくして列を空ける(重ねると、真ん中のボタンが映像の端にかかって崩れて見えた。iPhone SE+Safari、2026-11-26)
      const over = false; let vy = 0;
      if (col < colMin) { col = colMin; vw = W - col; vh = vw / ar; vy = Math.round((H - vh) / 2); }
      vx = 0;
      px(stage, vx, vy, vw, vh, { padding: '0', zIndex: '0' });
      document.body.style.setProperty('--mw-toast-top-land', `${vy + 104}px`); document.body.style.setProperty('--mw-toast-cx', `${vx + vw / 2}px`);
      const avail = col - 12 - safe().r - wheelW - gap - pad; // 右に切り欠き(カメラの穴)がある向きでは、その分も引く(2026-11-26。引いていなかったため、真ん中のボタンが名前の札に重なった)
      m = Math.max(52, Math.min(m, avail)); // 列に入りきらないときは、真ん中のボタンを列の幅まで小さく(名前の札に重ならない)
      mx = W - col + pad + Math.max(0, (avail - m) / 2); my = (H - m) / 2;
      const bx = Math.round(Math.max(44, Math.min(52, m * 0.68))); root.style.setProperty('--mw-bx', `${bx}px`);
      const scx = mx + m / 2;
      px(wheel, W - 12 - safe().r - wheelW, H / 2 - 84, wheelW, 168);
      px(slotRc, scx - 38, my - 14 - 20 - bx, 76, bx + 20); px(slotDl, scx - 38, my + m + 10, 76, bx + 20);
      if (flipOn && !seatDel()) px(flip, scx - 24, my + m + 12, 48, 48, { borderRadius: '50%', background: '' });
      // 秒数の札・一覧・⚙は、左上のLIVEの帯の右に1列で並べる(右の列はモードの操作だけにする。中山さん 2026-11-06「一覧が変なところ」)
      clear(secs);
      // ←は、いちばん左上(画面を移る操作なので、ほかのボタンと見た目を変え、枠なしの矢印だけ。中山さん 2026-11-07)。LIVEの帯はその右
      const backShown = backBtn && getComputedStyle(backBtn).display !== 'none';
      if (backBtn) px(backBtn, 4 + safe().l, vy + 4, 48, 48, { background: 'transparent', boxShadow: 'none', zIndex: '6' });
      if (bandsEl) { bandsEl.style.left = backShown ? `${52 + safe().l}px` : (safe().l ? `${8 + safe().l}px` : ''); bandsEl.style.top = ''; } // 左に切り欠きがある向きでは、LIVEの帯をその分右へ
      if (topRow) { clear(topRow); const r = bandEl ? bandEl.getBoundingClientRect() : { right: 0 }; px(topRow, r.right + 8, vy + 8, null, null, { zIndex: '6' }); }
      // 自撮り: 何もしていないときは、真ん中のボタンの上(縦の「横」に当たる場所)。録画・ディレイ中は、そこが止める枠やカメラを追加になるので、映像の右下
      landFlipSide = false; // 真ん中の上下は、いつもモードのボタン(案B')。自撮りは映像の右下
      // アプリ名(ロゴ)は、右の列のいちばん上の紺の空きに
      { const fits = my - 34 - bx >= 44; px(logo, W - col + Math.max(4, (col - 76) / 2), 12 + safe().t, null, null); logo.style.visibility = fits ? '' : 'hidden'; } // 右の列のいちばん上。低い画面では出さない(ボタンと重なる)
      // 全画面ボタン(Androidで、ブラウザのバーが出ているとき。全画面に入れば帯が細くなり、ボタンも消える)。右の列の下、「ディレイ」の札の下に空きがあるときだけ(2026-11-26)
      { const fsY = H - 12 - safe().b - 44; const room = fsY >= my + m + 10 + bx + 20 + 6; if (canFs() && room) { px(fsBtn, scx - 22, fsY, 44, 44, {}); fsBtn.hidden = false; } else { clear(fsBtn); fsBtn.hidden = true; } }
      if (landFlipSide) px(flip, scx - 32, my - 14 - 64, 64, 64, { borderRadius: '18px', background: 'rgba(44,74,160,.55)' });
      flip.classList.toggle('mw-big', landFlipSide);
      camCorner = true;
      if (camBtn) px(camBtn, vx + 10 + safe().l, vy + vh - 56, 46, 46, { background: 'rgba(0,0,0,.45)', minWidth: '46px', borderRadius: '50%' });
      placeZoom(vx, vw, vy + vh, true, flipOn && seatDel());
    }
    if (camBtn && !camCorner) camBtn.style.background = '';
    root.style.setProperty('--mw-main', `${m}px`);
    px(main, mx, my, m, m);
  }
  window.addEventListener('resize', fit);
  setInterval(() => { sync(); fit(); }, 250);
  landMq.addEventListener('change', () => { drawWheel(); fit(); });

  // アプリを開いたときは、必ずディレイから(VARは使われ始めるまで時間がかかる前提。中山さん 2026-11-14)
  st.pos = 0; drawWheel(); renderAll(); fit();
}

if (window.kendoVarApp) init();
else document.addEventListener('kendovar-app-ready', init, { once: true });
