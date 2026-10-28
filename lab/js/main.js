// main.js: 録画(試作。開発側の呼び名は「長めの録画」)の画面と、既存のアプリ(js/app.js)との結び付け。試作用。
// 画面の考え方(claude/specs/long-recording-spec.md、画面の絵 claude/design-samples/Rec-*.dc.html):
// - 録画前: 状態の帯は LIVE のまま。下の操作は「VAR」「録画」(同じ大きさ)。「録画」でシートが開き、最長を選んで「録画開始」
// - 録画中: 帯が「REC 0:10」(赤地・白文字)。下は「録画停止」「VAR」
// - 映像受信中: 帯が「映像受信中 あと2分」(グレー)と進み具合のバー。下は「中止」
// - 終わったら: 録画の一覧(1本ごとに 見る・保存・消す のアイコン)。保存のあと「まとめ中 40%」と「中止」
// - 試験用の設定と数値は、シート「試験用」の中だけに置く
// - 既存のVAR(直近30秒の写真方式)には手を入れない。接続とカメラの映像だけ window.kendoVarApp から借りる
import { LabStore } from './store.js';
import { LocalCapture, ChildAgent, ParentAgent, DEFAULTS, probeMethods, batteryPercent } from './agents.js';
import { LabViewer } from './viewer.js';
import { buildTakeFiles, deliverFiles, fileStamp, resolveSaveMode } from './save.js';
import { composeTake, QUALITY } from './compose.js';
import { Prebuilder } from './prebuild.js';
import { ensureMicPermission } from './audio-input.js';
import { showToast } from '../../js/toast.js';
import { attachPress } from '../../js/press-feedback.js';
import { enableWakeLock } from '../../js/wake-lock.js';
import { track } from '../../js/analytics.js';

const PEER_PREFIX = 'kendo-var-room-';
// 試験用の入口(「試験用」のボタン)は、試作ページ(<html data-lab>)だけに出す。通常のページには出さない
const isLab = document.documentElement.hasAttribute('data-lab');

// ---- アイコン(仕様2-2、画面の絵のSVGをそのまま使う)。録画・録画停止・VARは塗りつぶし、ほかは線 ----
const svgFill = (inner) => `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">${inner}</svg>`;
const svgLine = (inner) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;
const ICON = {
  rec: svgFill('<circle cx="12" cy="12" r="9"/>'),
  stop: svgFill('<rect x="5" y="5" width="14" height="14" rx="3"/>'),
  var: '<svg viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" aria-hidden="true"><path d="M12 6v12l-9-6z"/><path d="M21 6v12l-9-6z"/></svg>',
  play: svgFill('<path d="M8 5l11 7-11 7z"/>'),
  save: svgLine('<path d="M12 4v11"/><path d="M7 11l5 5 5-5"/><path d="M5 20h14"/>'),
  trash: svgLine('<path d="M5 7h14"/><path d="M10 7V4h4v3"/><path d="M7 7l1 13h8l1-13"/>'),
  undo: svgLine('<path d="M9 6L4 11l5 5"/><path d="M4 11h10a5 5 0 0 1 0 10h-3"/>'),
  cancel: svgLine('<path d="M6 6l12 12"/><path d="M18 6L6 18"/>'),
};
const iconText = (icon, text) => `${icon}<span>${text}</span>`;

// ---- 録画の最長(仕様7-2)。0 は「制限なし」。選んだ値は端末に覚える ----
const MAX_OPTIONS = [[300, '5分'], [600, '10分'], [1800, '30分'], [3600, '60分'], [0, '制限なし']];
const MAX_KEY = 'kendo-var-lab-max';
const MB_PER_MIN = 7.5; // 1台1Mbpsで約7.5MB/分(実機の値で調整する)
function loadMax() {
  try { const v = Number(localStorage.getItem(MAX_KEY)); if (MAX_OPTIONS.some(([s]) => s === v) && localStorage.getItem(MAX_KEY) !== null) return v; } catch (err) { /* 覚えられない環境 */ }
  return 600;
}
function saveMax(v) { try { localStorage.setItem(MAX_KEY, String(v)); } catch (err) { /* 覚えられない環境 */ } }
const UNDO_MS = 10000;
const $ = (root, sel) => root.querySelector(sel);

const fmtDur = (ms) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}分${String(s % 60).padStart(2, '0')}秒`;
};
const fmtMS = (ms) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};
const fmtClock = (ms) => {
  const d = new Date(ms);
  const hm = `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
  return d.toDateString() === new Date().toDateString() ? hm : `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
};
const fmtEta = (ms) => (ms < 60000 ? `あと${Math.max(10, Math.round(ms / 10000) * 10)}秒` : `あと${Math.ceil(ms / 60000)}分`);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ---- 警報(録画が止まったとき): 赤い帯・音・振動 ----
let alarmEl = null;
let audioCtx = null;
function beep() {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    for (let i = 0; i < 3; i++) {
      const o = audioCtx.createOscillator();
      const g = audioCtx.createGain();
      o.frequency.value = 880;
      g.gain.value = 0.2;
      o.connect(g); g.connect(audioCtx.destination);
      o.start(audioCtx.currentTime + i * 0.4);
      o.stop(audioCtx.currentTime + i * 0.4 + 0.25);
    }
  } catch (err) { /* 音が出せなくても帯は出る */ }
}
function raiseAlarm(msg) {
  if (!alarmEl) {
    alarmEl = document.createElement('div');
    alarmEl.className = 'lab-alarm';
    alarmEl.setAttribute('role', 'alert');
    document.body.appendChild(alarmEl);
    alarmEl.addEventListener('click', () => { alarmEl.hidden = true; });
  }
  alarmEl.hidden = false;
  alarmEl.textContent = `${msg}(タップで消します)`;
  beep();
  try { navigator.vibrate && navigator.vibrate([300, 150, 300, 150, 300]); } catch (err) { /* 無視 */ }
  window.__labAlarms = (window.__labAlarms || []).concat(msg);
}

// ---- 画面が隠れていた時間(隠れている間は録画が止まる端末があるため、記録に残す) ----
const hidden = { since: 0, totalMs: 0, count: 0 };
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { hidden.since = Date.now(); } else if (hidden.since) { hidden.totalMs += Date.now() - hidden.since; hidden.count++; hidden.since = 0; }
});

const methodsPromise = probeMethods();

// ---- 状態の帯に「REC」などを重ねる(js/state-band.js の部品はそのまま使う) ----
// 帯が LIVE のときだけ文字と色を替える。リプレイ中・一時停止中は帯に触らず、小さい帯(サブ帯)に出す
function createBandOverlay({ bandId, compute, subEl }) {
  const band = document.getElementById(bandId);
  if (!band) return { refresh() {} };
  const text = band.querySelector('.state-band-text');
  const normal = { live: 'LIVE', sending: '送信中' };
  let mine = null; // いま自分が出している状態
  let busy = false;
  function refresh() {
    if (busy) return;
    busy = true;
    try {
      const want = compute(); // { state, text, sub } | null
      const base = band.dataset.state;
      const ownBase = base === 'live' || base === 'sending' || base === 'rec' || base === 'collect';
      if (want && ownBase) {
        if (band.dataset.state !== want.state) { band.dataset.state = want.state; band.classList.remove('band-enter'); void band.offsetWidth; band.classList.add('band-enter'); }
        if (text.textContent !== want.text) text.textContent = want.text;
        mine = { base: mine ? mine.base : base };
        if (subEl) subEl.hidden = true;
      } else {
        if (mine && ownBase) {
          band.dataset.state = mine.base;
          text.textContent = normal[mine.base] || text.textContent;
          mine = null;
        } else if (mine && !ownBase) {
          mine = null; // 帯は別の状態(リプレイなど)になった。元に戻す必要はない
        }
        if (subEl) {
          if (want && !ownBase) { subEl.textContent = want.text; subEl.hidden = false; } else if (want && want.sub) { subEl.textContent = want.sub; subEl.hidden = false; } else subEl.hidden = true;
        }
      }
    } finally { busy = false; }
  }
  new MutationObserver(() => refresh()).observe(band, { attributes: true, attributeFilter: ['data-state'], childList: true, subtree: true, characterData: true });
  return { refresh };
}

// ===========================================================================
async function initParent(app) {
  const store = await new LabStore('kendoVarLab').open();
  await store.purgeHidden(); // 「元に戻す」の前にアプリが閉じた録画は、ここで本当に消す
  await store.markPartials(null); // 終わりまでたどり着かなかった録画に「途中まで」の印を付ける
  const { cameraLink } = app;
  const capture = new LocalCapture({
    camKey: 'local', label: 'カメラ1', store, sentInit: 1,
    getStream: () => cameraLink.localMonitorVideo.srcObject,
    onAlarm: raiseAlarm, onChange: () => render(),
  });
  const parent = new ParentAgent({
    store, capture, onAlarm: raiseAlarm, onChange: () => render(),
    // 最長に達したときは警報にしない。トーストと振動1回(仕様7章)
    onMaxReached: (sec) => { showToast(`最長の${Math.round(sec / 60)}分に達したので、終わりました。`); try { navigator.vibrate && navigator.vibrate(200); } catch (err) { /* 無視 */ } },
  });
  // 録画の最中に、まとめを区間ごとに先に作っておく(録画・VARが最優先。VARを開いている間とまとめを作っている間は動かさない)
  const prebuilder = new Prebuilder({
    store,
    canRun: () => !!vEl.hidden && !making,
    getDropped: () => { try { return parent.summary().rows.reduce((a, r) => a + (Number(r.dropped) || 0), 0); } catch (err) { return 0; } },
  });
  window.__lab = { role: 'parent', parent, store, capture, prebuilder };

  // 子機が張ってくる専用の通信路を受け入れる(PeerJS の接続が用意できてから)
  const hook = setInterval(() => {
    if (!cameraLink.peer) return;
    clearInterval(hook);
    cameraLink.peer.on('connection', (conn) => parent.attachConn(conn));
  }, 300);

  const monitorArea = document.getElementById('monitorArea');
  const actions = monitorArea.querySelector('.primary-actions');
  const statusRow = monitorArea.querySelector('.status-row');
  const bands = monitorArea.querySelector('.state-bands');

  const root = document.createElement('div');
  root.className = 'lab-root';
  root.innerHTML = `
    <div id="labOverlay" class="help-overlay"></div>
    <div id="labSheet" class="help-sheet lab-sheet" role="dialog" aria-label="録画" aria-hidden="true">
      <div class="help-sheet-handle"></div>
      <div class="lab-startbox" id="labStartBox">
        <div class="lab-startleft">
          <p class="lab-cap" id="labMaxCap">最長</p>
          <div class="lab-sel" id="labMax" role="radiogroup" aria-labelledby="labMaxCap">${MAX_OPTIONS.map(([s, l]) => `<button type="button" class="lab-opt" role="radio" data-max="${s}">${l}</button>`).join('')}</div>
          <p class="lab-note" id="labMaxNote" hidden></p>
        </div>
        <div class="lab-startright">
          <p class="lab-remain" id="labRemain" hidden></p>
          <button type="button" class="lab-big" id="labStart">${iconText(ICON.rec, '録画開始')}</button>
        </div>
      </div>
      <p class="lab-note lab-unsaved-note" id="labUnsavedNote" hidden>保存を押すと、端末に残ります。</p>
      <p class="lab-note" id="labListNote" hidden>映像はこの端末の中にあります。</p>
      <ul class="lab-takes" id="labTakes"></ul>
      <div class="lab-foot">
        ${isLab ? '<button type="button" class="lab-link" id="labOpenTest">試験用</button>' : ''}
        <button type="button" class="btn-hero lab-close" id="labCloseSheet">閉じる</button>
      </div>
    </div>
    <div id="labTestSheet" class="help-sheet lab-sheet" role="dialog" aria-label="試験用" aria-hidden="true">
      <div class="help-sheet-handle"></div>
      <h3>試験用</h3>
      <p class="lab-note">普通に使うときは開かなくて大丈夫です。</p>
      <div class="lab-opts">
        <label>録画のしかた<select id="optMethod"><option value="B">ふつう(MP4にまとめる)</option><option value="A">比べる用(ブラウザ標準の録画)</option></select></label>
        <label>内部の区切り<select id="optSeg"><option value="10">10秒ごと</option><option value="30">30秒ごと</option><option value="60" selected>60秒ごと</option></select></label>
        <label>音<select id="optAudio"><option value="1" selected>録る</option><option value="0">録らない</option></select></label>
        <label>見るときの音<select id="optAudioCam"><option value="auto" selected>自動</option></select></label>
        <label>保存のしかた<select id="optSave"><option value="auto" selected>自動</option><option value="share">共有の画面</option><option value="download">ダウンロード</option></select></label>
        <label>まとめ動画の画質<select id="optQuality"><option value="low" selected>低(幅960・15コマ)</option><option value="std">標準(幅1280・30コマ)</option></select></label>
      </div>
      <p class="lab-note">見るときの音とまとめ動画の音は、自動だと「カメラ1」(1つずつ見る形ではそのカメラ)になります。</p>
      <p class="lab-note" id="labSupport"></p>
      <table class="lab-table"><thead><tr><th>カメラ</th><th>状態</th><th>動画の数</th><th>容量</th><th>通信(ms)</th><th>途切れ(ms)</th><th>音</th></tr></thead><tbody id="labNums"></tbody></table>
      <div class="lab-actions">
        <button type="button" id="labMeasurePhoto">写真のコマ送りを測る</button>
        <button type="button" id="labCopy">数値をコピー</button>
        <button type="button" id="labClearAll">記録をすべて消す</button>
      </div>
      <p class="lab-note" id="labPhoto"></p>
      <textarea class="lab-text" id="labText" readonly rows="8" hidden></textarea>
      <button type="button" class="btn-hero lab-close" id="labBackSheet">戻る</button>
    </div>
    <section class="lab-viewer" id="labViewer" hidden aria-label="録画を見る">
      <div class="lab-vhead">
        <div class="state-band" data-state="paused"><span class="state-band-text" id="labVBand">録画</span></div>
        <div class="lab-vtop">
          <button type="button" class="lab-vbtn" id="labVGrid" hidden>並べる</button>
          <button type="button" class="lab-vbtn" id="labVClose">閉じる</button>
        </div>
      </div>
      <canvas id="labCanvas" class="lab-canvas"></canvas>
      <div class="lab-vbar">
        <div class="lab-vseek">
          <input type="range" id="labSeek" min="0" max="1000" value="0" aria-label="見る場面">
          <span class="time-readout" id="labTime">0:00 / 0:00</span>
        </div>
        <div class="lab-vrow">
          <button type="button" class="speed-btn" data-v="back30" aria-label="30秒戻る">−30秒</button>
          <button type="button" class="speed-btn step-btn" data-v="prev" aria-label="1コマ戻る"><svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M6 5h2.4v14H6zM20 5v14L9.5 12z"/></svg></button>
          <button type="button" class="icon-btn icon-btn-primary" data-v="play" id="labPlay" aria-label="再生"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg></button>
          <button type="button" class="speed-btn step-btn" data-v="next" aria-label="1コマ進む"><svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M15.6 5H18v14h-2.4zM4 5v14l10.5-7z"/></svg></button>
          <button type="button" class="speed-btn" data-v="fwd30" aria-label="30秒進む">+30秒</button>
        </div>
        <p class="lab-vinfo" id="labVInfo" hidden></p>
      </div>
    </section>
    <div class="toast lab-undo" id="labUndo" role="status"><span id="labUndoText">消しました</span><button type="button" id="labUndoBtn">${iconText(ICON.undo, '元に戻す')}</button></div>
    <div class="toast lab-undo lab-make" id="labMake" role="status"><span id="labMakeText">まとめができました</span><button type="button" id="labMakeBtn">${iconText(ICON.save, '保存')}</button></div>`;
  document.body.appendChild(root);
  const el = (s) => $(root, s);

  // 下の操作の列: 「VAR」と「録画」を同じ大きさで並べる。録画中は「録画停止」と「VAR」。映像受信中・まとめ中は「中止」だけ(見た目は lab.css)
  const recBtn = document.createElement('button');
  recBtn.type = 'button';
  recBtn.id = 'labRec';
  recBtn.className = 'action-btn lab-rec-btn';
  recBtn.innerHTML = iconText(ICON.rec, '録画');
  actions.appendChild(recBtn);
  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.id = 'labCancel';
  cancelBtn.className = 'action-btn lab-cancel-btn';
  cancelBtn.innerHTML = iconText(ICON.cancel, '中止');
  cancelBtn.hidden = true;
  actions.appendChild(cancelBtn);
  // VARのボタン(本番の部品)は、この試作のページでだけ、言葉を「VAR」、アイコンを早戻しにする。本番のコードが秒数入りの文字に書き戻すので、そのたびに直す
  const rewindBtn = document.getElementById('btnRewind');
  const rewindLabel = document.getElementById('btnRewindLabel');
  if (rewindBtn) { const old = rewindBtn.querySelector('svg'); if (old) old.outerHTML = ICON.var; }
  if (rewindLabel) {
    const fix = () => { if (rewindLabel.textContent !== 'VAR') rewindLabel.textContent = 'VAR'; };
    fix();
    new MutationObserver(fix).observe(rewindLabel, { childList: true, characterData: true, subtree: true });
  }
  // 映像受信中・まとめ中の進み具合のバー(映像の下の端)
  const progress = document.createElement('div');
  progress.className = 'lab-progress';
  progress.hidden = true;
  progress.innerHTML = '<i></i>';
  bands.parentElement.appendChild(progress);
  // 「REC 0:10」などを、リプレイ中にも見せるための小さい帯
  const subBand = document.createElement('div');
  subBand.className = 'state-band state-band-sub';
  subBand.id = 'labSubBand';
  subBand.hidden = true;
  bands.appendChild(subBand);

  [recBtn, cancelBtn, el('#labStart'), el('#labCloseSheet'), el('#labBackSheet'), el('#labVClose'), el('#labVGrid'), el('#labPlay'), el('#labUndoBtn'), el('#labMakeBtn')].forEach((b) => attachPress(b, { vibrate: 30 }));

  const sheet = el('#labSheet');
  const testSheet = el('#labTestSheet');
  const overlay = el('#labOverlay');
  let listOnly = false; // 受信が終わって自動で開いたときは、一覧だけを見せる(画面の絵の6)。「録画」から開いたときは、最長と「録画開始」も
  function setSheet(which, { list = false } = {}) { // 'main' | 'test' | null
    if (which === 'main') listOnly = list;
    sheet.classList.toggle('open', which === 'main');
    testSheet.classList.toggle('open', which === 'test');
    sheet.setAttribute('aria-hidden', which === 'main' ? 'false' : 'true');
    testSheet.setAttribute('aria-hidden', which === 'test' ? 'false' : 'true');
    overlay.classList.toggle('open', !!which);
    if (which === 'main') { takesSig = ''; render(); }
    if (which === 'test') render();
  }
  overlay.addEventListener('click', () => setSheet(null));
  el('#labCloseSheet').addEventListener('click', () => setSheet(null));
  if (isLab) el('#labOpenTest').addEventListener('click', () => setSheet('test'));
  else testSheet.hidden = true; // 通常のページには、試験用の入口を出さない(中の設定の部品は、値を読むために残す)
  el('#labBackSheet').addEventListener('click', () => setSheet('main', { list: listOnly }));

  methodsPromise.then((m) => {
    const a = m.A.ok ? `○(${m.A.mime})` : '×';
    const b = m.B.ok ? `○(${m.B.codec}${m.B.audio ? ` + ${m.B.audio}` : '、音は使えません'})` : `×(${m.B.reason})`;
    el('#labSupport').textContent = `この端末で使える録画: ふつう(MP4にまとめる) ${b} / 比べる用 ${a}`;
  });

  // ---- 状態の帯 ----
  const take = () => parent.take;
  const isRecording = () => !!(take() && !take().stoppedAt);
  const isCollecting = () => !!(take() && take().stoppedAt && !take().collectedAt && !take().gaveUp);
  let saving = null; // { text } 保存中の表示(小さい帯)
  let making = null; // { pct, remainMs, replay, cancel } まとめ中
  // 映像受信中の残り時間: 受け取った量の増え方から計算する
  const recvSamples = [];
  function recvEtaMs() {
    const sum = parent.summary();
    let remBytes = 0; let total = 0;
    for (const r of sum.rows) {
      if (r.role === '親機') continue;
      const c = parent.children.get(r.cam);
      if (!c) continue;
      total += c.recvBytes;
      const s = c.status;
      const avg = c.recv ? c.recvBytes / c.recv : (s && s.rec.segs ? s.rec.bytes / s.rec.segs : 0);
      const remSegs = c.expected != null ? Math.max(0, c.expected - c.recv) : (s && s.unsent) || 0;
      remBytes += remSegs * avg;
    }
    const now = Date.now();
    recvSamples.push([now, total]);
    while (recvSamples.length && now - recvSamples[0][0] > 15000) recvSamples.shift();
    if (recvSamples.length < 3 || remBytes <= 0) return null;
    const [t0, b0] = recvSamples[0];
    const rate = (total - b0) / Math.max(1, now - t0); // バイト/ミリ秒
    if (rate <= 0) return null;
    return remBytes / rate;
  }
  function collectPercent() {
    const sum = parent.summary();
    let got = 0; let want = 0;
    for (const r of sum.rows) {
      if (r.expected == null) return null;
      got += Math.min(r.segs, r.expected); want += r.expected;
    }
    return want ? Math.round((got / want) * 100) : null;
  }
  let lastEta = null;
  function bandWant() {
    if (isRecording()) return { state: 'rec', text: `REC ${fmtMS(Date.now() - take().startedAt)}` };
    if (isCollecting()) return { state: 'collect', text: lastEta != null && lastEta >= 10000 ? `映像受信中　${fmtEta(lastEta)}` : '映像受信中' };
    if (making) return { state: 'collect', text: `まとめ中 ${making.pct}%${making.replay && making.remainMs ? `　${fmtEta(making.remainMs)}` : ''}` };
    return null;
  }
  function refreshProgress() {
    let f = null;
    if (isCollecting()) { const p = collectPercent(); f = p == null ? 0 : p / 100; } else if (making) f = making.pct / 100;
    progress.hidden = f == null;
    if (f != null) progress.firstChild.style.width = `${Math.round(f * 100)}%`;
  }
  const overlayBand = createBandOverlay({ bandId: 'stateBand', compute: () => bandWant() });
  // サブ帯: 保存中の知らせが先。なければ、リプレイ中などに「REC 0:10」を出す
  function refreshSub() {
    const main = document.getElementById('stateBand');
    const st = main ? main.dataset.state : 'live';
    const want = bandWant();
    let text = '';
    if (saving) text = saving.text;
    else if (want && st !== 'live' && st !== 'rec' && st !== 'collect') text = want.text;
    if (text) { if (subBand.textContent !== text) subBand.textContent = text; subBand.hidden = false; } else subBand.hidden = true;
  }
  new MutationObserver(refreshSub).observe(document.getElementById('stateBand'), { attributes: true, attributeFilter: ['data-state'] });

  // ---- 保存し忘れ対策(2026-10-24 依頼 rec-autosave の a・b) ----
  // a. 端末の保存領域を、ブラウザに勝手に消されにくくする(録画を始めるときに頼む。結果は試験用の数値に載せる)
  async function requestPersist() {
    try {
      if (!navigator.storage || !navigator.storage.persist) { window.__persist = '未対応'; return; }
      if (navigator.storage.persisted && await navigator.storage.persisted()) { window.__persist = '許可済み'; return; }
      window.__persist = (await navigator.storage.persist()) ? '許可' : '不許可';
    } catch (err) { window.__persist = '失敗'; }
  }
  // 未保存の録画(止めたあとで、まだ保存していないもの)があるか。ページを閉じようとしたときの確認に使う
  let hasUnsaved = false;
  async function refreshUnsaved() {
    try { hasUnsaved = (await store.listTakes()).some((x) => !x.hiddenAt && x.stoppedAt && !x.savedAt); } catch (err) { /* 読めないときは前のまま */ }
  }
  refreshUnsaved();
  setInterval(refreshUnsaved, 3000);
  window.addEventListener('beforeunload', (e) => {
    if (isRecording() || isCollecting() || hasUnsaved) { e.preventDefault(); e.returnValue = ''; }
  });

  // ---- 録画を始める・終える ----
  let starting = false;
  async function startRec() {
    if (starting || isRecording() || isCollecting()) return;
    starting = true;
    try {
      const u = await store.usage();
      if (u && u.freeMB < DEFAULTS.minFreeMB * 2) { raiseAlarm(`空き容量が少ないため(あと約${Math.round(u.freeMB)}MB)、録画を始められません`); return; }
      setSheet(null);
      requestPersist(); // 待たない(録画の開始を遅らせない)
      const ok = await parent.startTake({
        method: el('#optMethod').value, segSec: Number(el('#optSeg').value), maxSec: maxSel, audio: el('#optAudio').value === '1',
      });
      if (ok && parent.take) { parent.take.remainMin = remainMin; parent._saveTake(); }
      // 録画の最中にまとめを先に作る(既定で入れる。2026-10-23 中山さんの決定。止めて比べたいときは URL に ?pre=0)
      if (ok && parent.take && new URLSearchParams(location.search).get('pre') !== '0') prebuilder.start(parent.take.id, el('#optQuality').value);
      if (ok) track('rec_start', { cameras: 1 + [...parent.children.values()].filter((c) => c.connected).length }); // 親機のカメラ+つながっている子機(録画が実際に始まったときだけ)
      if (!ok) showToast('録画を開始できませんでした');
      else if (capture.status.audio && capture.status.audio.ok === false && el('#optAudio').value === '1') showToast('音なしで録画します');
      enableWakeLock({ quiet: true });
    } finally { starting = false; render(); }
  }
  // ---- 最長の選択と「あと約◯分録れます」(仕様7-2) ----
  let maxSel = loadMax();
  let remainMin = null; // 全端末のうち、いちばん少ない空きで計算した残り(分)
  let remainAt = 0;
  async function updateRemain() {
    if (Date.now() - remainAt < 4000) return;
    remainAt = Date.now();
    const u = await store.usage();
    if (!u) { remainMin = null; return; }
    const kids = [...parent.children.values()].filter((c) => c.connected);
    let min = (u.freeMB - DEFAULTS.minFreeMB) / (MB_PER_MIN * (1 + kids.length)); // 親機は全台ぶんを持つ
    for (const c of kids) if (c.status && c.status.free != null) min = Math.min(min, (c.status.free - DEFAULTS.minFreeMB) / MB_PER_MIN);
    remainMin = Math.max(0, Math.floor(min));
  }
  function renderStartBox() {
    el('#labMax').querySelectorAll('.lab-opt').forEach((b) => { const on = Number(b.dataset.max) === maxSel; b.classList.toggle('on', on); b.setAttribute('aria-checked', String(on)); });
    const note = el('#labMaxNote');
    note.hidden = !(maxSel === 0 || maxSel >= 1800);
    note.textContent = maxSel === 0 ? '停止を押すまで録ります。空きが足りなくなると止まります。' : '長い録画は、空きが足りなくなったり、熱くなったりすることがあります。';
    const r = el('#labRemain');
    r.hidden = remainMin == null;
    if (remainMin != null) {
      const short = maxSel === 0 || remainMin < maxSel / 60;
      r.textContent = short ? `あと約${remainMin}分で止まります` : `あと約${remainMin}分録れます`;
      r.classList.toggle('is-warn', short);
    }
  }
  el('#labMax').addEventListener('click', (e) => {
    const b = e.target.closest('.lab-opt');
    if (!b || isRecording()) return;
    maxSel = Number(b.dataset.max); saveMax(maxSel); renderStartBox();
  });
  el('#labMax').querySelectorAll('.lab-opt').forEach((b) => attachPress(b, { vibrate: 12 }));
  // 録画中の知らせ: 空きの残りが5分と1分になったとき、1回ずつ
  const spaceWarned = new Set();
  function checkSpaceWarn() {
    if (!isRecording() || remainMin == null) return;
    const left = remainMin; // 録画中も空きを測り直しているので、今の残り
    for (const n of [5, 1]) if (left <= n && !spaceWarned.has(`${take().id}:${n}`)) { spaceWarned.add(`${take().id}:${n}`); showToast(`空きが少なくなっています。あと約${Math.max(1, left)}分で止まります。`); break; }
  }

  // ---- 映像受信の中止と、続きを受信(仕様7-3) ----
  async function cancelReceive() {
    if (!isCollecting()) return;
    await parent.cancelReceive();
    openedFor = take().id;
    render();
    if (vEl.hidden) setSheet('main', { list: true });
  }
  async function resumeReceive(t) {
    const current = await parent.resumeReceive(t.id);
    if (current) { openedFor = null; setSheet(null); } else showToast('続きを受信します。届いた分から見られます。');
    takesSig = ''; render();
  }
  cancelBtn.addEventListener('click', () => {
    if (making) { making.cancel = true; return; }
    cancelReceive();
  });

  async function stopRec() {
    if (!isRecording()) return;
    await parent.stopTake('user');
    render();
  }
  recBtn.addEventListener('click', () => {
    if (isRecording()) { stopRec(); return; }
    setSheet('main');
  });
  el('#labStart').addEventListener('click', startRec);

  // ---- 録画の一覧: 消す(10秒は元に戻せる) ----
  let pending = null; // { ids:[], timer }
  async function commitPending() {
    if (!pending) return;
    const p = pending; pending = null;
    clearTimeout(p.timer);
    for (const id of p.ids) { try { await store.deleteTake(id); } catch (err) { /* 無視 */ } }
  }
  const undoEl = el('#labUndo');
  function hideUndo() { undoEl.classList.remove('show'); }
  async function removeTakes(ids, text = '消しました') {
    await commitPending(); // 前の「消す」は、ここで確定する
    for (const id of ids) await store.hideTake(id);
    pending = { ids, timer: setTimeout(async () => { hideUndo(); await commitPending(); takesSig = ''; render(); }, UNDO_MS) };
    el('#labUndoText').textContent = text;
    undoEl.classList.add('show');
    takesSig = ''; render();
  }
  el('#labUndoBtn').addEventListener('click', async () => {
    if (!pending) return;
    const p = pending; pending = null;
    clearTimeout(p.timer);
    for (const id of p.ids) await store.unhideTake(id);
    hideUndo();
    takesSig = ''; render();
  });

  // ---- まとめ動画(全カメラを並べた1本) ----
  const makeEl = el('#labMake');
  let makeTimer = 0;
  let makeAct = null;
  function showMake(text, act, hideAfterMs = 0) {
    clearTimeout(makeTimer);
    el('#labMakeText').textContent = text;
    makeAct = act;
    makeEl.classList.add('show');
    if (hideAfterMs) makeTimer = setTimeout(hideMake, hideAfterMs);
  }
  function hideMake() { clearTimeout(makeTimer); makeEl.classList.remove('show'); makeAct = null; }
  el('#labMakeBtn').addEventListener('click', () => { if (makeAct) makeAct(); });

  async function makeCombined(t) {
    const started = performance.now();
    const stamp = fileStamp(t.startedAt);
    // まとめ中: 帯「まとめ中 40%」、映像の下の端にバー、下の操作は「中止」だけ(画面の絵の7)
    making = { pct: 0, remainMs: 0, replay: false, cancel: false };
    saving = null;
    render();
    let out;
    try {
      out = await composeTake(store, t, {
        quality: el('#optQuality').value,
        audioCam: el('#optAudioCam').value,
        prebuilder,
        shouldCancel: () => !!(making && making.cancel),
        onProgress: ({ fraction, remainMs, replay }) => {
          making.pct = Math.round(fraction * 100); making.remainMs = remainMs; making.replay = !!replay;
          overlayBand.refresh(); refreshProgress(); refreshSub();
        },
      });
    } catch (err) {
      making = null; render();
      window.__lastMakeError = String(err && err.message ? err.message : err);
      if (err && err.cancelled) showToast('まとめを中止しました。カメラごとの動画は保存済みです');
      else if (err && err.unsupported) showToast('この端末では、まとめ動画は作れません');
      else showToast('まとめを作れませんでした。カメラごとの動画は保存済みです');
      return;
    }
    making = null;
    render();
    const file = new File([out.blob], `kendovar_${stamp}_まとめ.${out.ext}`, { type: out.mime });
    lastSave.make = { mode: out.mode, ms: out.ms, bytes: file.size, width: out.width, height: out.height, fps: out.fps, frames: out.frames, videoCodec: out.videoCodec, audioCodec: out.audioCodec, hasAudio: out.hasAudio, audioCam: out.audioCam, name: file.name, quality: el('#optQuality').value, diag: out.diag || null };
    window.__lastMake = { file, ...lastSave.make };
    const deliver = async () => {
      hideMake();
      const how = await deliverFiles([file], { title: 'MITORI 録画(まとめ)', mode: el('#optSave').value });
      if (how === 'cancelled') showToast('保存をやめました');
      else { saving = { text: '保存しました' }; refreshSub(); setTimeout(() => { saving = null; refreshSub(); }, 2200); }
    };
    window.__lab.deliverMake = deliver;
    // ダウンロードなら、押した操作が要らないので、できたらそのまま保存する。共有の画面は押した直後でないと出せない端末があるため、「保存」を押してもらう
    if (resolveSaveMode(el('#optSave').value) === 'download') deliver();
    else showMake('まとめができました', deliver, 120000);
    window.__lastMake.performanceNote = `${Math.round(performance.now() - started)}ms`;
  }

  // ---- 保存 ----
  const savingIds = new Set();
  let lastSave = null;
  async function saveTake(t) {
    if (savingIds.has(t.id)) return; // 二度押ししても、保存は1回だけ
    savingIds.add(t.id);
    track('rec_save');
    setSheet(null); // 帯と下の「中止」が見えるように、シートを閉じる(画面の絵の7)
    takesSig = ''; render();
    const started = performance.now();
    try {
      enableWakeLock({ quiet: true });
      saving = { text: '保存中' };
      refreshSub();
      let res;
      try {
        res = await buildTakeFiles(store, t, { onProgress: ({ index, total }) => { saving = { text: total > 1 ? `保存中 ${Math.min(index + 1, total)}/${total}` : '保存中' }; refreshSub(); } });
      } catch (err) {
        // 原因を試験用の数値に残す(動画処理コーダー、2026-10-21)
        window.__lastSaveError = `${err && err.name ? err.name + ': ' : ''}${err && err.message ? err.message : String(err)}`;
        showToast(err && err.message && /映像がありません/.test(err.message) ? err.message : '途中で止まりました。もう一度保存してください。');
        return;
      }
      const how = await deliverFiles(res.files, { title: 'MITORI 録画', mode: el('#optSave').value });
      lastSave = { at: Date.now(), ms: Math.round(performance.now() - started), how, info: res.info, files: res.files.map((f) => ({ name: f.name, type: f.type, size: f.size })) };
      window.__lastSave = lastSave;
      if (how === 'cancelled') showToast('保存をやめました');
      else {
        // 「保存済み」の印(端末に覚える)。共有の画面を出した・ダウンロードを始めた時点。iPhoneは、共有の画面を閉じただけかは分からない
        try { const cur = await store.getTake(t.id); if (cur) { cur.savedAt = Date.now(); await store.putTake(cur); } } catch (err) { /* 印が付けられなくても、保存は済んでいる */ }
        if (res.note) showToast(res.note);
        if (res.info.length >= 2) await makeCombined(t);
        else {
          saving = { text: '保存しました' };
          refreshSub();
          await new Promise((r) => setTimeout(r, 2200));
        }
      }
    } finally {
      saving = null; savingIds.delete(t.id); refreshSub(); takesSig = ''; refreshUnsaved(); render();
    }
  }

  // ---- 見る ----
  const viewer = new LabViewer({ store, canvas: el('#labCanvas'), onChange: () => renderViewer() });
  const vEl = el('#labViewer');
  const seek = el('#labSeek');
  let seeking = false;
  function renderViewer() {
    if (vEl.hidden) return;
    const dur = viewer.durationMs || 1;
    if (!seeking) seek.value = String(Math.round(((viewer.t - viewer.tMin) / dur) * 1000));
    el('#labTime').textContent = `${fmtMS(viewer.t - viewer.tMin)} / ${fmtMS(dur)}`;
    const play = el('#labPlay');
    const icon = viewer.playing
      ? '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="5" width="4.2" height="14" rx="1"/><rect x="13.8" y="5" width="4.2" height="14" rx="1"/></svg>'
      : '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>';
    if (play.dataset.icon !== (viewer.playing ? 'pause' : 'play')) { play.innerHTML = icon; play.dataset.icon = viewer.playing ? 'pause' : 'play'; play.setAttribute('aria-label', viewer.playing ? '止める' : '再生'); }
    const f = viewer.focus ? viewer.tracks.find((tr) => tr.cam === viewer.focus) : null;
    el('#labVBand').textContent = f ? f.label : '録画';
    el('#labVGrid').hidden = !viewer.focus;
    if (testSheet.classList.contains('open') || window.__labDebug) {
      const m = viewer.metrics;
      el('#labVInfo').hidden = false;
      el('#labVInfo').textContent = `離れた場面へ ${m.jumpMs ?? '-'}ms　コマ送り ${m.stepMs ?? '-'}ms　カメラ間のずれ ${m.spreadMs ?? '-'}ms　音: ${viewer.audioCam ?? 'なし'}`;
    } else el('#labVInfo').hidden = true;
  }
  seek.addEventListener('input', () => { seeking = true; viewer.pause(); viewer.seek(viewer.tMin + (Number(seek.value) / 1000) * viewer.durationMs).finally(() => { seeking = false; }); });
  vEl.addEventListener('click', async (e) => {
    const b = e.target.closest && e.target.closest('[data-v]');
    const act = b && b.dataset.v;
    if (!act) return;
    if (act === 'play') { viewer.playing ? viewer.pause() : viewer.play(); renderViewer(); return; }
    if (act === 'prev') await viewer.step(-1);
    if (act === 'next') await viewer.step(1);
    if (act === 'back30') { viewer.pause(); await viewer.seek(viewer.t - 30000); }
    if (act === 'fwd30') { viewer.pause(); await viewer.seek(viewer.t + 30000); }
    renderViewer();
  });
  function closeViewer() { viewer.close(); vEl.hidden = true; setSheet('main', { list: listOnly }); }
  el('#labVClose').addEventListener('click', closeViewer);
  el('#labVGrid').addEventListener('click', () => { viewer.setFocus(null); renderViewer(); });
  // 並べて見ているとき、映像をタップするとそのカメラを大きく見る(音もそのカメラになる)
  el('#labCanvas').addEventListener('click', (e) => {
    if (viewer.camCount < 2 || viewer.focus) return;
    const r = e.currentTarget.getBoundingClientRect();
    const cam = viewer.camAt(e.clientX - r.left, e.clientY - r.top);
    if (cam) { viewer.setFocus(cam); renderViewer(); }
  });
  async function openViewer(takeId) {
    vEl.hidden = false;
    setSheet(null);
    viewer.audioCamSetting = el('#optAudioCam').value;
    try { await viewer.open(takeId); } catch (err) { showToast('再生できませんでした'); window.__labViewerError = String(err && err.message ? err.message : err); vEl.hidden = true; setSheet('main', { list: listOnly }); return; }
    renderViewer();
    viewer.draw();
  }
  window.__lab.viewer = viewer;
  window.__lab.openViewer = openViewer;
  window.__lab.saveTake = (t) => saveTake(t);
  window.__lab.removeTakes = removeTakes;
  window.__lab.setSheet = setSheet;

  // ---- 写真方式(VARの直近30秒)で1コマを出す時間。動画との比べ用 ----
  let photoStepMs = null;
  async function measurePhoto() {
    const frames = app.recorder.getFrames(cameraLink.activeSource) || [];
    if (frames.length < 10) { el('#labPhoto').textContent = '写真がまだたまっていません。少し待ってからもう一度押してください'; return; }
    const cv = document.createElement('canvas');
    const g = cv.getContext('2d');
    const times = [];
    const n = Math.min(30, frames.length);
    for (let i = 0; i < n; i++) {
      const f = frames[Math.floor((i * (frames.length - 1)) / Math.max(1, n - 1))];
      const t0 = performance.now();
      const bmp = await createImageBitmap(f.blob);
      cv.width = bmp.width; cv.height = bmp.height;
      g.drawImage(bmp, 0, 0);
      bmp.close();
      times.push(performance.now() - t0);
    }
    photoStepMs = { n, avg: Math.round(times.reduce((a, b) => a + b, 0) / n), max: Math.round(Math.max(...times)) };
    el('#labPhoto').textContent = `写真1コマを出す時間: 平均${photoStepMs.avg}ms(最大${photoStepMs.max}ms)`;
  }
  el('#labMeasurePhoto').addEventListener('click', measurePhoto);

  // ---- 数値のまとめ ----
  async function summaryText(takeId) {
    const tk = takeId ? await store.getTake(takeId) : parent.take;
    if (!tk) return '録画がまだありません';
    const segs = await store.listByTake(tk.id);
    const byCam = new Map();
    segs.forEach((s) => { const a = byCam.get(s.cam) || { label: s.label, n: 0, bytes: 0, role: s.origin === 'own' ? '親機' : '子機' }; a.n++; a.bytes += s.size; byCam.set(s.cam, a); });
    const live = parent.take && parent.take.id === tk.id ? parent.summary() : null;
    const lines = [];
    lines.push(`【録画の数値】${new Date(tk.startedAt).toLocaleString('ja-JP')} 録画のしかた:${tk.method === 'B' ? 'ふつう(MP4にまとめる)' : '比べる用'} 内部の区切り${tk.segSec}秒 長さ${tk.stoppedAt ? fmtDur(tk.stoppedAt - tk.startedAt) : '録画中'}${tk.partial ? ' 途中まで' : ''}`);
    if (segs[0]) lines.push(`録画の形式: ${segs[0].mime}`);
    lines.push(`保存領域の保護(persist): ${window.__persist || 'まだ頼んでいない'}`);
    const recvSec = live && live.take.collectMs != null ? live.take.collectMs / 1000 : (tk.collectedAt && tk.stoppedAt ? (tk.collectedAt - tk.stoppedAt) / 1000 : null);
    if (tk.gaveUp) lines.push(`録画停止→映像受信: ${recvSec != null ? recvSec.toFixed(1) : '-'}秒で中止(届いていないカメラ: ${(tk.missing || []).join('・') || 'なし'})`);
    else if (recvSec != null) lines.push(`録画停止→映像受信の完了まで: ${recvSec.toFixed(1)}秒${tk.resumedAt ? '(中止のあと続きを受信)' : ''}`);
    else if (tk.stoppedAt) lines.push('録画停止→映像受信の完了まで: まだ受信中');
    lines.push(`最長: ${tk.maxSec ? `${Math.round(tk.maxSec / 60)}分` : '制限なし'}${tk.stopReason === 'max' ? '(最長で終了)' : ''} 録画前の「あと約◯分」: ${tk.remainMin ?? '-'}分`);
    lines.push(`電池: ${tk.bat0 ?? '-'}% → ${tk.bat1 ?? '-'}%(熱さは手で触って記録してください)`);
    lines.push(`画面が隠れた回数・時間: ${hidden.count}回 ${Math.round(hidden.totalMs / 1000)}秒`);
    byCam.forEach((a, cam) => {
      const row = live && live.rows.find((r) => r.cam === cam);
      const exp = row && row.expected != null ? `/${row.expected}` : '';
      let extra = '';
      if (row) {
        const au = row.audio;
        const audioText = au ? (au.ok ? `音:${au.codec} ${au.sampleRate || ''}Hz 遅れ${au.latencyMs != null ? Math.round(au.latencyMs) : '-'}ms 設定${au.settings ? `エコー除去${au.settings.echoCancellation} 雑音抑制${au.settings.noiseSuppression} 自動音量${au.settings.autoGainControl}` : '-'}` : `音なし(${au.reason})`) : '音:-';
        extra = ` 欠け最大${row.maxGapMs ?? '-'}ms 往復${row.rtt ?? '-'}ms 時計差${row.offset ?? '-'}ms 未送信${row.unsent ?? '-'} 落としたコマ${row.dropped ?? '-'} ${audioText}${row.errors && row.errors.length ? ` 記録:${row.errors.join(' / ')}` : ''}`;
      }
      lines.push(`${a.label}(${a.role}): 動画${a.n}${exp} ${(a.bytes / 1048576).toFixed(1)}MB${extra}`);
    });
    if (lastSave && lastSave.make) {
      const m = lastSave.make;
      lines.push(`まとめ: ${m.mode === 'fast' ? '読み出して作り直し' : '再生しながら録り直し'} ${m.quality === 'std' ? '標準' : '低'} ${m.width}x${m.height} ${m.fps}コマ ${(m.bytes / 1048576).toFixed(1)}MB 作成${(m.ms / 1000).toFixed(1)}秒 映像${m.videoCodec} 音${m.hasAudio ? `${m.audioCodec}(${m.audioCam})` : 'なし'}`);
      // まとめの内訳(動画処理コーダーの計測、2026-10-20)。専用処理部=prefer-hardware で通るか
      if (m.diag) { const d = m.diag; const yn = (v) => (v === true ? '可' : v === false ? '不可' : '不明'); lines.push(`まとめの内訳: 設定 ${d.encCfg} / 専用処理部 ${yn(d.hw['prefer-hardware'])}・CPU ${yn(d.hw['prefer-software'])} / 読み出し${(d.readMs / 1000).toFixed(1)}秒(うち待ち${(d.readWaitMs / 1000).toFixed(1)}秒) 並べる${(d.drawMs / 1000).toFixed(1)}秒 圧縮待ち${(d.encWaitMs / 1000).toFixed(1)}秒 その他${(d.otherMs / 1000).toFixed(1)}秒 / 待ち行列 読み出し平均${d.decodeQ.avg}・最大${d.decodeQ.max} 圧縮平均${d.encodeQ.avg}・最大${d.encodeQ.max} / 1秒あたり${d.outFps}コマ / 先読み${d.ahead}コマ・まとめ中に画面が隠れた${(d.hiddenMs / 1000).toFixed(1)}秒`); if (d.pre) lines.push(`先に作った分: ${d.pre.pieces}区間(${d.pre.builtFrames}コマ)・止めたあとに作った${d.pre.restFrames}コマ・先に作るのに使った${(d.pre.busyMs / 1000).toFixed(1)}秒・録画のコマ落ちで止めた${d.pre.drops}回・失敗${d.pre.errors}回${d.pre.lastError ? ' ' + d.pre.lastError : ''}`); }
    }
    if (lastSave) {
      lines.push(`保存: ${lastSave.how === 'shared' ? '共有の画面' : lastSave.how === 'downloaded' ? 'ダウンロード' : 'やめた'} ${lastSave.ms}ms ${lastSave.info.map((i) => (i.kind === 'one' ? `${i.cam}:${i.ext}(映像${i.videoCodec} 音${i.hasAudio ? i.audioCodec : 'なし'}) ${(i.bytes / 1048576).toFixed(1)}MB` : `${i.cam}:${i.parts}個に分かれた`)).join(' / ')}`);
    }
    lines.push('版: 保存の読み直しあり(2026-10-21 b)');
    if (window.__lastSaveError) lines.push(`保存の失敗: ${window.__lastSaveError}`);
    if (window.__lastPrebuildError) lines.push(`先に作る分の失敗: ${window.__lastPrebuildError}`);
    const m = viewer.metrics;
    if (m.seekMs != null) lines.push(`動画から見る: 離れた場面へ移る${m.jumpMs ?? '-'}ms 1コマ送り${m.stepMs ?? '-'}ms 画面上のカメラ間のずれ${m.spreadMs ?? '-'}ms`);
    if (photoStepMs != null) lines.push(`写真方式(VARの直近30秒): 1コマを出す${photoStepMs.avg}ms(最大${photoStepMs.max}ms、${photoStepMs.n}コマの平均)`);
    lines.push(`端末: ${navigator.userAgent}`);
    return lines.join('\n');
  }
  window.__lab.summaryText = summaryText;
  el('#labCopy').addEventListener('click', async () => {
    const list = await store.listTakes();
    const latest = list.find((x) => !x.hiddenAt);
    const text = await summaryText(latest && !(parent.take && parent.take.id === latest.id) ? latest.id : undefined);
    const ta = el('#labText');
    ta.hidden = false; ta.value = text; ta.select();
    try { await navigator.clipboard.writeText(text); showToast('コピーしました'); } catch (err) { try { document.execCommand('copy'); } catch (e2) { /* 手でコピーしてもらう */ } }
  });
  el('#labClearAll').addEventListener('click', async () => {
    if (isRecording() || isCollecting()) { showToast('録画が終わってから消してください'); return; }
    const ids = (await store.listTakes()).filter((x) => !x.hiddenAt).map((x) => x.id);
    if (!ids.length) { showToast('消す録画はありません'); return; }
    setSheet(null);
    await removeTakes(ids, 'すべて消しました');
  });
  el('#optAudioCam').addEventListener('change', () => { viewer.audioCamSetting = el('#optAudioCam').value; });

  // ---- 画面の更新 ----
  let takesSig = '';
  let renderBusy = false;
  async function renderTakes() {
    const list = (await store.listTakes()).filter((x) => !x.hiddenAt);
    const cur = take();
    const sig = JSON.stringify([list.map((t) => [t.id, t.stoppedAt, t.collectedAt, !!t.savedAt, !!t.partial, !!t.gaveUp, Object.keys(t.cams || {}).length]), [...savingIds], cur && cur.id, isCollecting(), !!making]);
    if (sig === takesSig) return;
    takesSig = sig;
    const sizes = new Map();
    for (const t of list) sizes.set(t.id, (await store.listByTake(t.id)).reduce((a, s) => a + (s.size || 0), 0));
    const ul = el('#labTakes');
    ul.innerHTML = '';
    el('#labListNote').hidden = !list.length;
    const isUnsaved = (t) => !!t.stoppedAt && !t.savedAt && !(cur && cur.id === t.id && isCollecting());
    el('#labUnsavedNote').hidden = !list.some(isUnsaved);
    list.forEach((t) => {
      const li = document.createElement('li');
      li.dataset.take = t.id;
      const busy = !!(cur && cur.id === t.id && (!t.stoppedAt || isCollecting()));
      const durMs = t.stoppedAt ? t.stoppedAt - t.startedAt : 0;
      const mb = Math.max(1, Math.round((sizes.get(t.id) || 0) / 1048576));
      const info = document.createElement('p');
      info.className = 'lab-take-info';
      const part = t.partial ? `<em>${t.missing && t.missing.length ? `${esc(t.missing.join('・'))}は途中まで` : '途中まで'}</em>` : '';
      const mark = isUnsaved(t) ? '<em class="lab-unsaved">未保存</em>' : (t.savedAt ? '<em class="lab-saved">保存済み</em>' : '');
      info.innerHTML = `<b>${esc(fmtClock(t.startedAt))}</b> <span>${durMs ? `${fmtDur(durMs)} ・ ` : ''}${mb}MB</span>${mark}${part}`;
      li.appendChild(info);
      if (busy) {
        const p = document.createElement('p');
        p.className = 'lab-take-wait';
        p.textContent = !t.stoppedAt ? '録画中' : '映像受信中';
        li.appendChild(p);
      } else {
        if (durMs >= 30 * 60000) { const n = document.createElement('p'); n.className = 'lab-note'; n.textContent = '保存に時間がかかります。'; li.appendChild(n); }
        const row = document.createElement('div');
        row.className = 'lab-take-btns';
        const mk = (icon, label, fn, dis, wide) => { const b = document.createElement('button'); b.type = 'button'; b.className = wide ? 'lab-act lab-act-text' : 'lab-act'; b.innerHTML = wide ? iconText(icon, label) : icon; b.setAttribute('aria-label', label); if (dis) b.disabled = true; b.addEventListener('click', fn); attachPress(b, { vibrate: 30 }); return b; };
        row.append(
          mk(ICON.play, '見る', () => openViewer(t.id)),
          mk(ICON.save, '保存', () => saveTake(t), savingIds.has(t.id) || !!making, isUnsaved(t)),
          mk(ICON.trash, '消す', () => removeTakes([t.id])),
        );
        li.appendChild(row);
        if (t.gaveUp) {
          const r = document.createElement('button');
          r.type = 'button'; r.className = 'lab-resume'; r.innerHTML = iconText(ICON.save, '続きを受信');
          r.addEventListener('click', () => resumeReceive(t)); attachPress(r, { vibrate: 30 });
          li.appendChild(r);
        }
      }
      ul.appendChild(li);
    });
  }
  let openedFor = null;
  function render() {
    const recording = isRecording();
    const collecting = isCollecting();
    const busy = collecting || !!making;
    // 下の操作: 録画前「VAR」「録画」、録画中「録画停止」「VAR」、映像受信中・まとめ中は「中止」だけ(今使える操作だけ)
    if (recBtn.dataset.rec !== String(recording)) {
      recBtn.dataset.rec = String(recording);
      recBtn.innerHTML = recording ? iconText(ICON.stop, '録画停止') : iconText(ICON.rec, '録画');
    }
    recBtn.classList.toggle('is-recording', recording);
    recBtn.hidden = busy;
    cancelBtn.hidden = !busy;
    monitorArea.classList.toggle('lab-recording', recording);
    monitorArea.classList.toggle('lab-busy', busy);
    if (collecting) lastEta = recvEtaMs(); else { lastEta = null; recvSamples.length = 0; }
    overlayBand.refresh();
    refreshSub();
    refreshProgress();
    // 受信が終わったら、録画の一覧を自動で開く
    if (take() && take().stoppedAt && take().collectedAt && openedFor !== take().id) { openedFor = take().id; if (vEl.hidden) setSheet('main', { list: true }); }
    // シートの中身: 録画前だけ、最長の選択と「録画開始」
    const open = sheet.classList.contains('open');
    el('#labStartBox').hidden = recording || busy || listOnly;
    if (open && !recording && !busy && !listOnly) { updateRemain().then(renderStartBox); renderStartBox(); }
    if (recording) updateRemain().then(checkSpaceWarn);
    if (open && !renderBusy) { renderBusy = true; renderTakes().finally(() => { renderBusy = false; }); }
    if (testSheet.classList.contains('open')) renderTest();
  }
  function renderTest() {
    const sum = parent.summary();
    el('#labNums').innerHTML = sum.rows.map((r) => {
      const child = parent.children.get(r.cam);
      const childRec = child && child.status && child.status.rec.recording;
      let st = r.role === '親機' ? (capture.recording ? '録画中' : '待機') : (r.connected ? (childRec ? '録画中' : '待機') : '切れている');
      if (r.alarm) st = '止まった';
      const segs = r.expected != null ? `${r.segs}/${r.expected}` : `${r.segs}`;
      const au = r.audio ? (r.audio.ok ? r.audio.codec : `×${r.audio.reason}`) : '-';
      return `<tr class="${r.alarm ? 'is-alarm' : ''}"><td>${esc(r.label)}</td><td>${st}${r.unsent ? `(未送信${r.unsent})` : ''}</td><td>${segs}</td><td>${r.mb.toFixed(1)}MB</td><td>${r.rtt ?? '-'}</td><td>${r.maxGapMs ?? '-'}</td><td>${esc(au)}</td></tr>`;
    }).join('');
  }
  // 音を出すカメラの選択肢を、つながっているカメラに合わせる
  let camSig = '';
  function syncLabels() {
    for (const c of parent.children.values()) {
      const cam = cameraLink.remoteCams.find((x) => x.id === c.camKey);
      if (cam) c.label = cam.label;
    }
    const cams = [['local', 'カメラ1'], ...[...parent.children.values()].map((c) => [c.camKey, c.label])];
    const sig = JSON.stringify(cams);
    if (sig === camSig) return;
    camSig = sig;
    const sel = el('#optAudioCam');
    const cur = sel.value;
    sel.innerHTML = `<option value="auto">自動</option>${cams.map(([k, l]) => `<option value="${esc(k)}">${esc(l)}だけ</option>`).join('')}`;
    sel.value = [...sel.options].some((o) => o.value === cur) ? cur : 'auto';
  }

  setInterval(() => { parent.tick(); syncLabels(); render(); }, 1000);
  setInterval(() => { if (parent.take) prebuilder.tick().catch(() => {}); }, 2000);
  window.__lab.cancelReceive = cancelReceive;
  window.__lab.resumeReceive = resumeReceive;
  render();
}

// ===========================================================================
async function initChild(app) {
  const store = await new LabStore('kendoVarLab').open();
  const { cameraLink } = app;
  const camKey = `remote-${cameraLink.peer.id}`;
  let conn = null;
  const agent = new ChildAgent({
    camKey, label: `カメラ${app.getCameraNumber()}`, store, getStream: () => cameraLink.ownStream,
    getConn: () => conn, onAlarm: raiseAlarm, onChange: () => render(),
  });
  window.__lab = { role: 'child', agent, store };
  // マイクの許可は、この試作のページに入ったときに取っておく(録画の合図が来たときに止まらないように)
  ensureMicPermission().then((r) => { if (!r.ok) showToast(`${r.reason}。音なしで録画します`); });

  function ensureConn() {
    if (conn && conn.open) return;
    if (conn && !conn.open && conn.__connecting && Date.now() - conn.__connecting < 8000) return;
    if (!cameraLink.peer || cameraLink.peer.destroyed || !cameraLink.targetId) return;
    try {
      conn = cameraLink.peer.connect(PEER_PREFIX + cameraLink.targetId, { reliable: true });
    } catch (err) { return; }
    if (!conn) return;
    conn.__connecting = Date.now();
    conn.on('open', () => agent.onConnOpen());
    conn.on('data', (m) => agent.handleMessage(m));
    conn.on('error', () => {});
  }

  // 子機の帯は、白黒だけ(赤は録画を操作する端末の帯用)。録画中は「録画中 0:10」
  const sub = document.getElementById('camSubBand');
  let subPrev = { text: '', hidden: true };
  const overlay = createBandOverlay({
    bandId: 'camStateBand',
    subEl: null,
    compute: () => {
      const st = agent.capture.status;
      if (!st.recording) return null;
      return { state: 'sending', text: `録画中 ${fmtMS(Date.now() - st.startedAt)}` };
    },
  });
  function render() {
    agent.setLabel(`カメラ${app.getCameraNumber()}`);
    const st = agent.capture.status;
    overlay.refresh();
    const connected = conn && conn.open;
    if (sub) {
      if (st.recording && !connected) {
        if (!sub.dataset.lab) { subPrev = { text: sub.textContent, hidden: sub.hidden }; sub.dataset.lab = '1'; }
        sub.textContent = '見ている端末とつながっていません'; sub.hidden = false;
      } else if (sub.dataset.lab) { // つながったら、元の表示(カメラの番号)に戻す
        sub.textContent = subPrev.text; sub.hidden = subPrev.hidden; delete sub.dataset.lab;
      }
    }
  }
  const timer = setInterval(() => {
    if (app.getRole() !== 'camera') { clearInterval(timer); agent.stopRecording('left'); window.__lab = null; labState.child = false; return; }
    ensureConn();
    agent.tick();
    render();
  }, 1000);
  render();
}

// ===========================================================================
const labState = { parent: false, child: false };
function boot(app) {
  setInterval(() => {
    const role = app.getRole();
    if (role === 'monitor' && !labState.parent) { labState.parent = true; initParent(app); }
    // 子機は参加が済んで(送信中の画面になって)から始める
    if (role === 'camera' && !labState.child && app.cameraLink.peer && app.cameraLink.targetId) { labState.child = true; initChild(app); }
  }, 500);
}

if (window.kendoVarApp) boot(window.kendoVarApp);
else document.addEventListener('kendovar-app-ready', () => boot(window.kendoVarApp), { once: true });
void batteryPercent;
