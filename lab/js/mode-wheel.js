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
const stopIcon = (c) => `<svg width="22" height="22" viewBox="0 0 22 22" aria-hidden="true"><rect x="2" y="2" width="18" height="18" rx="3" fill="${c}"/></svg>`;
const ICON_LIST = '<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="6" width="14" height="14" rx="3"/><path d="M7 3h11a3 3 0 0 1 3 3v11"/><path d="M8.5 10.5l4 2.5-4 2.5z" fill="#fff"/></svg>';
const ICON_GEAR = '<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linejoin="round" aria-hidden="true"><path d="M18.93 9.39 L21.80 10.01 L21.80 13.99 L18.93 14.61 L18.74 15.05 L20.33 17.53 L17.53 20.33 L15.05 18.74 L14.61 18.93 L13.99 21.80 L10.01 21.80 L9.39 18.93 L8.95 18.74 L6.47 20.33 L3.67 17.53 L5.26 15.05 L5.07 14.61 L2.20 13.99 L2.20 10.01 L5.07 9.39 L5.26 8.95 L3.67 6.47 L6.47 3.67 L8.95 5.26 L9.39 5.07 L10.01 2.20 L13.99 2.20 L14.61 5.07 L15.05 5.26 L17.53 3.67 L20.33 6.47 L18.74 8.95 Z"/><circle cx="12" cy="12" r="3"/></svg>';

function init() {
  const app = window.kendoVarApp;
  const area = $('#monitorArea');
  if (!app || !area) return;
  const landMq = window.matchMedia('(orientation: landscape) and (max-height: 540px)');
  const isLand = () => landMq.matches;
  const step = () => (isLand() ? 56 : 112); // 札1つ分の送り幅

  const root = document.createElement('div');
  root.className = 'mw';
  root.innerHTML = `<div class="mw-zone"></div>
    <div class="mw-top"><div class="mw-secs"></div><button type="button" class="mw-ic mw-flip" id="mwFlip" aria-label="カメラを切り替え" hidden></button><button type="button" class="mw-ic" id="mwList" aria-label="一覧">${ICON_LIST}</button><button type="button" class="mw-ic" id="mwGear" aria-label="設定">${ICON_GEAR}</button></div>
    <div class="mw-slot dl" hidden><button type="button" class="bx dly" aria-label="ディレイを止める">${stopIcon('#fff')}</button><span class="lb"></span></div>
    <div class="mw-slot rc" hidden><button type="button" class="bx rec" aria-label="録画を止める">${stopIcon('#d6231b')}</button><span class="lb"></span></div>
    <button type="button" class="mw-main" aria-label="VAR"><div class="shape"></div></button>
    <div class="mw-wheel" role="listbox" aria-label="モード"></div>
    <div class="mw-note" role="status"></div>`;
  area.appendChild(root);
  const q = (s) => $(s, root);
  const wheel = q('.mw-wheel'); const main = q('.mw-main'); const shape = q('.shape'); const secs = q('.mw-secs');
  const slotDl = q('.mw-slot.dl'); const slotRc = q('.mw-slot.rc'); const note = q('.mw-note');

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

  // ---- 帯の言葉: LIVE / ディレイ 10秒 / VAR 15秒前(RECの帯は出さない) ----
  const band = $('#stateBand');
  function fixBand() {
    if (!band) return;
    const t = band.querySelector('.state-band-text'); if (!t) return;
    const s = band.dataset.state;
    let want = null;
    if (s === 'live') want = 'LIVE';
    else if (s === 'replay') want = `VAR ${rewindSec()}秒前`;
    else if (s === 'delay' || s === 'delayWait') want = `ディレイ ${delaySec()}秒`;
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
    shape.innerHTML = k === 'var' ? diamond(fillNow()) : SHAPE[k]();
    main.setAttribute('aria-label', MODES[cur].lb);
    main.classList.toggle('dim', k === 'var' && st.delay);
  }
  function fillNow() {
    try {
      const frames = app.recorder.getFrames(app.cameraLink.activeSource);
      if (frames.length < 2) return 0;
      return Math.min(1, ((frames[frames.length - 1].ts - frames[0].ts) / 1000) / rewindSec());
    } catch (err) { return 0; }
  }
  function updateFill() {
    if (MODES[cur].k !== 'var') return;
    const f = fillNow(); const r = shape.querySelector('.mw-fillclip');
    if (r) { r.setAttribute('y', 100 - f * 100); r.setAttribute('height', f * 100); }
    const full = f >= 0.999;
    if (full && !wasFull) { main.classList.remove('full'); void main.offsetWidth; main.classList.add('full'); }
    wasFull = full;
  }
  function renderSecs() {
    const k = MODES[cur].k;
    if (k === 'rec' || (k === 'var' && st.delay)) { secs.innerHTML = ''; return; } // ディレイ中はVARが使えないので、VARの秒数は出さない(左上の帯とも重ならない)
    const opts = k === 'var' ? rewindBtns().map(secOf) : delayOpts();
    if (!opts.length) { secs.innerHTML = ''; return; }
    const curV = k === 'var' ? rewindSec() : delaySec();
    const list = st.open ? opts : [curV];
    secs.innerHTML = `<div class="mw-chip${st.open ? '' : ' closed'}">${list.map((o) => `<button type="button" class="${o === curV ? 'sel' : ''}" data-v="${o}">${o}</button>`).join('')}</div>`;
    secs.querySelectorAll('button').forEach((b) => { b.onclick = (ev) => {
      ev.stopPropagation();
      if (!st.open) { st.open = true; renderSecs(); return; }
      const v = Number(b.dataset.v);
      if (k === 'var') { const t = rewindBtns().find((x) => secOf(x) === v); if (t) t.click(); } else st.delaySec = v;
      st.open = false; renderSecs(); fixBand(); updateSlots();
    }; });
  }
  function updateSlots() {
    slotRc.hidden = !st.rec; slotDl.hidden = !st.delay;
    if (st.rec) slotRc.querySelector('.lb').innerHTML = `<span class="mw-blink">●</span> ${fmt(Date.now() - st.recT)}`;
    if (st.delay) slotDl.querySelector('.lb').textContent = `${delaySec()}秒`;
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
      e.querySelector('b').innerHTML = (land && k !== 'var' ? (selNow ? ICON_MODE_SEL[k] : ICON_MODE[k]) : MODES[mi].lb) + dot;
      e.style.transform = land ? `translateY(${x}px) rotateX(${x / W * 28}deg) scale(${1 - 0.16 * a})` : `translateX(${x}px) rotateY(${-x / W * 28}deg) scale(${1 - 0.16 * a})`;
      e.style.opacity = Math.max(0, 1 - 0.45 * Math.abs(x) / W);
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
  const nearestVar = () => { const base = Math.round(st.pos); for (const c of [base - 1, base, base + 1]) if (mod3(c) === 1) return c; return base; };

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
      if (st.delay) { showNote('ディレイ中はVARを使えません(試験)'); return; }
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
  slotRc.querySelector('.bx').addEventListener('click', () => { const b = labRec(); if (b) b.click(); });
  slotDl.querySelector('.bx').addEventListener('click', () => { const x = $('#btnDelayExit'); if (x) x.click(); });
  q('#mwGear').addEventListener('click', () => { const b = $('#btnSettings'); if (b) b.click(); });
  // 一覧ボタンは、録画の一覧だけを出す(最長・録画開始は出さない。録画はホイールから始める)。⚙の「録画の一覧と設定」から開いたときは今までどおり
  q('#mwList').addEventListener('click', () => { const b = $('#btnOpenRecList'); if (b) { document.body.classList.add('mw-listonly'); const sh = $('#labSheet'); const hd = sh && sh.querySelector('.help-sheet-handle'); if (hd && !sh.querySelector('.mw-sheet-title')) hd.insertAdjacentHTML('afterend', '<p class="mw-sheet-title">録画の一覧</p>'); b.click(); } });
  { const b = $('#btnOpenRecList'); if (b) b.addEventListener('click', (e) => { if (e.isTrusted) document.body.classList.remove('mw-listonly'); }); }
  // 「カメラを追加」は、文字をなくしてアイコンだけ(カメラ+)。読み上げの名前は残す
  { const a = $('#btnAddCamera'); const sv = a && a.querySelector('svg');
    if (sv) { sv.setAttribute('stroke-width', '2'); sv.setAttribute('stroke-linejoin', 'round'); sv.innerHTML = '<path d="M5 7h2.2l1.6-2.4h6.4L16.8 7H19a2.5 2.5 0 0 1 2.5 2.5v8A2.5 2.5 0 0 1 19 20H5a2.5 2.5 0 0 1-2.5-2.5v-8A2.5 2.5 0 0 1 5 7z"/><path d="M12 10.3v6.4M8.8 13.5h6.4"/>'; } }

  // 自撮り(カメラの切り替え): 元のボタン(#btnFlipCam。ディレイ中は #btnDelayFlip)を押して使う。右上、一覧の左(中山さん 2026-11-06)
  const flip = q('#mwFlip'); const flipSrc = () => $('#btnFlipCam'); const flipDelaySrc = () => $('#btnDelayFlip');
  { const o = flipSrc(); if (o) flip.innerHTML = o.innerHTML; }
  flip.addEventListener('click', () => { const b = st.delay ? flipDelaySrc() : flipSrc(); if (b) b.click(); });
  // 一時停止・使い方は、⚙の中へ(ふだんは使わない)。元のボタンを押して使う
  { const sh = $('#settingsSheet'); const bar = $('#btnLefty');
    if (sh && bar) {
      const mk = (id, text, src) => { const b = document.createElement('button'); b.type = 'button'; b.id = id; b.className = 'link-btn prep-link'; b.textContent = text; b.addEventListener('click', () => { const o = $(src); if (o) { if (src === '#btnPauseAll') { const c = $('#btnCloseSettings'); if (c) c.click(); } o.click(); } }); return b; };
      bar.insertAdjacentElement('afterend', mk('mwHelp', '使い方', '#btnHelpInline'));
      bar.insertAdjacentElement('afterend', mk('mwPause', '撮影を一時停止', '#btnPauseAll'));
    } }

  // ---- 本番の状態を見て、合わせる ----
  function sync() {
    { const o = flipSrc(); flip.hidden = !o || o.hidden; }
    const rec = area.classList.contains('lab-recording');
    let del = false; try { del = !!app.player.delayMode; } catch (err) { del = false; }
    let changed = false;
    if (rec !== st.rec) { st.rec = rec; if (rec) st.recT = Date.now(); changed = true; if (rec && pending && pending.key === 'rec') startFly('rec'); }
    if (del !== st.delay) { st.delay = del; changed = true; if (del && pending && pending.key === 'delay') startFly('delay'); }
    area.classList.toggle('mw-idle', !(rec && del)); // 録画+ディレイの両方をしている間だけ、←・カメラを映像の左下へ。それ以外は真ん中のボタンの横(CSS)
    area.classList.toggle('mw-r', rec && !del); area.classList.toggle('mw-d', del && !rec);
    if (pending && Date.now() - pending.t > 4000) pending = null;
    if (changed) renderAll(); else { updateSlots(); updateFill(); fixAll(); }
  }
  function startFly(key) {
    pending = null;
    const slot = key === 'rec' ? slotRc : slotDl; const lb = key === 'rec' ? '録画' : 'ディレイ';
    renderAll();
    flyTo(lb, slot, () => { slot.classList.remove('pop'); void slot.offsetWidth; slot.classList.add('pop'); snapTo(nearestVar(), 480); });
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
    // 親機のカメラの取り込みを 16:9(854×480)か 4:3(640×480)に。標準・低の画質のときだけ(高・最大はそのまま)
    if (ar === wantAr || askAspect.busy) return;
    try {
      const v = app.cameraLink.localMonitorVideo; const tr = v && v.srcObject && v.srcObject.getVideoTracks()[0];
      if (!tr) return; // カメラの準備ができていない。次の fit() でもう一度
      const g = tr.getSettings(); wantAr = ar;
      if (Math.min(g.width || 0, g.height || 0) > 480) return;
      askAspect.busy = true;
      await tr.applyConstraints(ar > 1.5 ? { width: { ideal: 854 }, height: { ideal: 480 } } : { width: { ideal: 640 }, height: { ideal: 480 } });
    } catch (err) { /* 端末が出せない大きさなら、今のまま */ } finally { askAspect.busy = false; }
  }
  const camBtn = $('#btnAddCamera'); const backBtn = $('#btnBackStart');
  [camBtn, backBtn, stage, secs].forEach((b) => { if (b) b.dataset.mwFixed = '1'; });
  const bandEl = $('#stateBand');
  const topRow = q('.mw-top');
  const safeProbe = document.createElement('div');
  safeProbe.style.cssText = 'position:fixed;left:0;bottom:0;width:0;height:0;visibility:hidden;padding-bottom:env(safe-area-inset-bottom);padding-right:env(safe-area-inset-right)';
  document.body.appendChild(safeProbe);
  const safe = () => { const c = getComputedStyle(safeProbe); return { b: parseFloat(c.paddingBottom) || 0, r: parseFloat(c.paddingRight) || 0 }; };
  const zoomBtn = () => $('#monitorArea .zoom-toggle'); const zoomBar = () => $('#monitorArea .zoom-host');
  function placeZoom(vx, vw, vh, both) {
    // ボタンは映像の右下(48px)。スライダーは映像の下側で、ボタンの左。録画+ディレイ中は、左下のカメラを追加の上に上げる
    const zb = zoomBtn(); const zs = zoomBar();
    if (zb) { zb.dataset.mwFixed = '1'; px(zb, vx + vw - 12 - 48, vh - 12 - 48, 48, 48); }
    if (zs) { zs.dataset.mwFixed = '1'; const w = Math.min(380, vw - 12 - 48 - 12 - 12); px(zs, vx + vw - 12 - 48 - 12 - w, vh - 12 - 52 - (both && w > vw - 160 ? 64 : 0), w, 52); }
  }
  function fit() {
    const all = [stage, main, wheel, slotRc, slotDl, secs, camBtn, backBtn, zoomBtn(), zoomBar(), topRow];
    if (area.classList.contains('replaying') || !document.body.classList.contains('mode-monitor')) { all.forEach(clear); return; }
    const W = window.innerWidth; const H = window.innerHeight; const land = isLand();
    const both = st.rec && st.delay;
    let ar = videoAr(); let vx; let vw; let vh; let m; let mx; let my;
    if (!land) {
      vw = W; vh = W / ar;
      if (H - vh < 210) { vh = H - 210; vw = vh * ar; }
      vx = (W - vw) / 2;
      // 余った高さ(ブラウザのバーが消えて画面が伸びたときなど)は、下の帯だけに回さない。
      // 下の帯は 260px まで。それより余る分は上に回し(最大72px。LIVEの帯・一覧・⚙が映像にかからない)、まだ余れば上下に半分ずつ
      const ZONE = 260; let vy = 0;
      const spare = H - vh - ZONE;
      if (spare > 0) vy = Math.min(72, spare) + Math.max(0, Math.round((spare - 72) / 2));
      const vb = vy + vh; // 映像の下端
      const wheelY = H - 48 - 18 - safe().b; // 下のジェスチャーバーにかからないように
      m = Math.max(88, Math.min(120, Math.round((H - vb) * 0.36)));
      mx = (W - m) / 2; my = vb + Math.max(12, Math.round((wheelY - vb - m) / 2));
      px(stage, vx, vy, vw, vh, { padding: '0', zIndex: '0' });
      px(wheel, 0, wheelY, W, 48);
      const side = 64; const sideY = my + (m - side) / 2; const boxY = my + (m - 56) / 2 - 9;
      px(slotDl, 14, boxY, 76, 78); px(slotRc, W - 90, boxY, 76, 78);
      clear(secs); clear(topRow);
      if (backBtn) px(backBtn, 20, sideY, side, side);
      if (camBtn) { if (both) px(camBtn, vx + 12, vb - 68, 56, 56, { background: 'rgba(44,74,160,.85)' }); else px(camBtn, st.rec ? 20 : W - 20 - side, sideY, side, side); }
      root.style.setProperty('--mw-bx', '56px');
      placeZoom(vx, vw, vb, both);
    } else {
      askAspect(W - H * 16 / 9 >= 120 ? 16 / 9 : 4 / 3);
      vh = H; vw = H * ar; vx = 0;
      let col = W - vw;
      const over = col < 120; if (over) col = 150; // 余白が足りない端末は、列を半透明で映像に重ねる
      if (!over) px(stage, 0, 0, vw, vh, { padding: '0', zIndex: '0' }); else px(stage, 0, 0, Math.min(W, vw), vh, { padding: '0', zIndex: '0' });
      const wheelW = 48; const gap = 14; const pad = 6; const avail = col - 8 - wheelW - gap - pad;
      m = Math.max(64, Math.min(104, Math.round(Math.min(avail, H * 0.24))));
      mx = W - col + pad + (avail - m) / 2; my = (H - m) / 2;
      const bx = H < 380 ? 52 : 56; root.style.setProperty('--mw-bx', `${bx}px`);
      const scx = mx + m / 2;
      px(wheel, W - 8 - wheelW, H / 2 - 84, wheelW, 168);
      px(slotRc, scx - 38, my - 14 - 20 - bx, 76, bx + 24);
      px(slotDl, scx - 38, my + m + 14, 76, bx);
      if (bandEl) { const r = bandEl.getBoundingClientRect(); px(secs, r.right + 8, 8, null, null, { zIndex: '6' }); }
      // 一覧・⚙は、右の列の上(映像と列の境目にまたがらないように)
      if (topRow) px(topRow, W - 8 - safe().r - (flip.hidden ? 104 : 160), 8, flip.hidden ? 104 : 160, 48);
      if (backBtn) px(backBtn, W - col + 8, H - 56, 48, 48);
      if (camBtn) { if (both) px(camBtn, 12, H - 68, 56, 56, { background: 'rgba(44,74,160,.85)' }); else px(camBtn, scx - 32, st.delay ? my - 14 - 64 : my + m + 14, 64, 64); }
      root.classList.toggle('mw-over', over);
      placeZoom(0, Math.min(W - (over ? 150 : 0), vw), vh, both);
    }
    if (camBtn && !both) camBtn.style.background = '';
    root.style.setProperty('--mw-main', `${m}px`);
    px(main, mx, my, m, m);
  }
  window.addEventListener('resize', fit);
  setInterval(() => { sync(); fit(); }, 250);
  landMq.addEventListener('change', () => { drawWheel(); fit(); });

  // アプリを開いたときは、必ずVARから
  st.pos = 1; drawWheel(); renderAll(); fit();
}

if (window.kendoVarApp) init();
else document.addEventListener('kendovar-app-ready', init, { once: true });
