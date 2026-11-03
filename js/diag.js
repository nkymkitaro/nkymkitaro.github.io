// diag.js: 固まる・落ちる原因を調べるための計測(?diag=1 のときだけ動く)。
// - 画面の左上に、数字を小さく出す。「コピー」で、文字として写せる(どこにも送らない)
// - 1秒ごとに、直近の数字を端末に残す。固まって読み込み直したあとも、前回の最後の数字が見られる
// - 映像・音は含まない。数字だけ
const ON = /[?&]diag=1(&|$)/.test(location.search);
const KEY = 'kendo-var-diag-last';
const S = {};                 // いまの値
const T0 = performance.now();
const hist = [];              // 1秒ごとの記録(直近120秒)

export const diagOn = ON;
export function diagSet(k, v) { if (ON) S[k] = v; }
export function diagAdd(k, n = 1) { if (ON) S[k] = (S[k] || 0) + n; }
// 時間の記録: 平均・最大・直近(ms)
export function diagTime(k, ms) {
  if (!ON) return;
  const t = S[k] || (S[k] = { n: 0, sum: 0, max: 0, last: 0 });
  t.n++; t.sum += ms; t.last = ms; if (ms > t.max) t.max = ms;
}

function fmt(v) {
  if (v && typeof v === 'object') return `平均${(v.sum / v.n).toFixed(0)} 最大${v.max.toFixed(0)} 直近${v.last.toFixed(0)} (${v.n}回)`;
  return String(v);
}
function snapshot() {
  const sec = Math.round((performance.now() - T0) / 1000);
  const o = { 経過秒: sec, 時刻: new Date().toLocaleTimeString() };
  if (performance.memory) o['JSメモリMB'] = Math.round(performance.memory.usedJSHeapSize / 1e6);
  Object.keys(S).sort().forEach((k) => { o[k] = fmt(S[k]); });
  return o;
}

if (ON) {
  // 前回の最後の数字(固まって読み込み直したとき)
  let prev = '';
  try { prev = localStorage.getItem(KEY) || ''; } catch (e) { /* 読めなくてもよい */ }

  // 画面が固まっていた長さ(描画の間隔の最大)と、長い処理(50ms超)
  let lastRaf = performance.now(); let gapMax = 0;
  const raf = (t) => { const g = t - lastRaf; lastRaf = t; if (g > gapMax) gapMax = g; requestAnimationFrame(raf); };
  requestAnimationFrame(raf);
  try {
    new PerformanceObserver((list) => { list.getEntries().forEach((e) => { diagAdd('長い処理(50ms超)の回数'); diagTime('長い処理ms', e.duration); }); }).observe({ entryTypes: ['longtask'] });
  } catch (e) { /* 対応していない端末 */ }

  const box = document.createElement('pre');
  box.style.cssText = 'position:fixed;left:0;top:0;z-index:99999;margin:0;padding:6px 8px;max-width:70vw;max-height:60vh;overflow:auto;background:rgba(0,0,0,.78);color:#9fffa0;font:11px/1.35 monospace;white-space:pre-wrap;pointer-events:none;';
  const btn = document.createElement('button');
  btn.textContent = 'コピー';
  btn.style.cssText = 'position:fixed;right:8px;top:8px;z-index:99999;min-height:48px;min-width:72px;font:16px sans-serif;';
  btn.addEventListener('click', async () => {
    const text = `前回の最後:\n${prev}\n\n履歴(1秒ごと):\n${hist.map((h) => JSON.stringify(h)).join('\n')}`;
    try { await navigator.clipboard.writeText(text); btn.textContent = 'コピーした'; } catch (e) { btn.textContent = '失敗'; }
    setTimeout(() => { btn.textContent = 'コピー'; }, 1500);
  });
  const attach = () => { document.body.appendChild(box); document.body.appendChild(btn); };
  if (document.body) attach(); else document.addEventListener('DOMContentLoaded', attach);

  setInterval(() => {
    S['描画の間隔の最大ms(直近1秒)'] = Math.round(gapMax); gapMax = 0;
    const snap = snapshot();
    hist.push(snap); if (hist.length > 120) hist.shift();
    const text = Object.entries(snap).map(([k, v]) => `${k}: ${v}`).join('\n');
    box.textContent = (prev ? `[前回の最後]\n${prev}\n\n[いま]\n` : '') + text;
    try { localStorage.setItem(KEY, Object.entries(snap).map(([k, v]) => `${k}: ${v}`).join('\n')); } catch (e) { /* 書けなくてもよい */ }
  }, 1000);
}
