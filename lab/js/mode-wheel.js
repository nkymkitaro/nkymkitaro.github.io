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
const stopIcon = (c) => `<svg width="22" height="22" viewBox="0 0 22 22" aria-hidden="true"><rect x="2" y="2" width="18" height="18" rx="3" fill="${c}"/></svg>`;
const ICON_LIST = '<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="6" width="14" height="14" rx="3"/><path d="M7 3h11a3 3 0 0 1 3 3v11"/><path d="M8.5 10.5l4 2.5-4 2.5z" fill="#fff"/></svg>';
const ICON_GEAR = '<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="3.2"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M5.3 18.7l2.1-2.1M16.6 7.4l2.1-2.1"/></svg>';

function init() {
  const app = window.kendoVarApp;
  const area = $('#monitorArea');
  if (!app || !area) return;
  const landMq = window.matchMedia('(orientation: landscape) and (max-height: 540px)');
  const isLand = () => landMq.matches;
  const step = () => (isLand() ? 52 : 112); // 札1つ分の送り幅

  const root = document.createElement('div');
  root.className = 'mw';
  root.innerHTML = `<div class="mw-zone"></div>
    <div class="mw-top"><button type="button" class="mw-ic" id="mwList" aria-label="一覧">${ICON_LIST}</button><button type="button" class="mw-ic" id="mwGear" aria-label="設定">${ICON_GEAR}</button></div>
    <div class="mw-slot dl" hidden><button type="button" class="bx dly" aria-label="ディレイを止める">${stopIcon('#fff')}</button><span class="lb"></span></div>
    <div class="mw-slot rc" hidden><button type="button" class="bx rec" aria-label="録画を止める">${stopIcon('#d6231b')}</button><span class="lb"></span></div>
    <div class="mw-secs"></div>
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
    if (k === 'rec') { secs.innerHTML = ''; return; }
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
    if (st.delay) slotDl.querySelector('.lb').textContent = `ディレイ ${delaySec()}秒`;
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
      e.querySelector('b').innerHTML = MODES[mi].lb + dot;
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
  q('#mwList').addEventListener('click', () => { const b = $('#btnOpenRecList'); if (b) b.click(); });

  // ---- 本番の状態を見て、合わせる ----
  function sync() {
    const rec = area.classList.contains('lab-recording');
    let del = false; try { del = !!app.player.delayMode; } catch (err) { del = false; }
    let changed = false;
    if (rec !== st.rec) { st.rec = rec; if (rec) st.recT = Date.now(); changed = true; if (rec && pending && pending.key === 'rec') startFly('rec'); }
    if (del !== st.delay) { st.delay = del; changed = true; if (del && pending && pending.key === 'delay') startFly('delay'); }
    if (pending && Date.now() - pending.t > 4000) pending = null;
    if (changed) renderAll(); else { updateSlots(); updateFill(); fixAll(); }
  }
  function startFly(key) {
    pending = null;
    const slot = key === 'rec' ? slotRc : slotDl; const lb = key === 'rec' ? '録画' : 'ディレイ';
    renderAll();
    flyTo(lb, slot, () => { slot.classList.remove('pop'); void slot.offsetWidth; slot.classList.add('pop'); snapTo(nearestVar(), 480); });
  }
  setInterval(sync, 250);
  landMq.addEventListener('change', drawWheel);

  // アプリを開いたときは、必ずVARから
  st.pos = 1; drawWheel(); renderAll();
}

if (window.kendoVarApp) init();
else document.addEventListener('kendovar-app-ready', init, { once: true });
