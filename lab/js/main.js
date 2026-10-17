// main.js: 長めの録画(試作)の画面と、既存のアプリ(js/app.js)との結び付け。試作用。
// 画面の考え方(claude/specs/long-recording-spec.md):
// - 録画前: 状態の帯は LIVE のまま。操作ボタンの列に「録画」が1つ。押すとシートが開き、「録画を始める」
// - 録画中: 帯が「REC 0:10」(赤地・白文字)。ボタンが「録画を終える」に替わる
// - 集めている間: 帯が「集めています 60%」(グレー)
// - 終わったら: 録画の一覧(1本ごとに 見る・保存・消す)
// - 試験用の設定と数値は、シート「試験用」の中だけに置く
// - 既存のVAR(直近30秒の写真方式)には手を入れない。接続とカメラの映像だけ window.kendoVarApp から借りる
import { LabStore } from './store.js';
import { LocalCapture, ChildAgent, ParentAgent, DEFAULTS, probeMethods, batteryPercent } from './agents.js';
import { LabViewer } from './viewer.js';
import { buildTakeFiles, deliverFiles, fileStamp, resolveSaveMode } from './save.js';
import { composeTake, QUALITY } from './compose.js';
import { ensureMicPermission } from './audio-input.js';
import { showToast } from '../../js/toast.js';
import { attachPress } from '../../js/press-feedback.js';
import { enableWakeLock } from '../../js/wake-lock.js';

const PEER_PREFIX = 'kendo-var-room-';
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
  return `${d.getMonth() + 1}/${d.getDate()} ${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
};
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
  const parent = new ParentAgent({ store, capture, onAlarm: raiseAlarm, onChange: () => render() });
  window.__lab = { role: 'parent', parent, store, capture };

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
    <div id="labSheet" class="help-sheet lab-sheet" role="dialog" aria-label="長めの録画" aria-hidden="true">
      <div class="help-sheet-handle"></div>
      <h3>長めの録画</h3>
      <button type="button" class="btn-hero lab-big" id="labStart">録画を始める</button>
      <p class="lab-line" id="labLine" hidden></p>
      <ul class="lab-takes" id="labTakes"></ul>
      <div class="lab-foot">
        <button type="button" class="lab-link" id="labOpenTest">試験用</button>
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
        <label>最長<select id="optMax"><option value="180">3分</option><option value="600" selected>10分</option><option value="1200">20分</option></select></label>
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
    <div class="toast lab-undo" id="labUndo" role="status"><span id="labUndoText">消しました</span><button type="button" id="labUndoBtn">元に戻す</button></div>
    <div class="toast lab-undo lab-make" id="labMake" role="status"><span id="labMakeText">まとめができました</span><button type="button" id="labMakeBtn">保存</button></div>`;
  document.body.appendChild(root);
  const el = (s) => $(root, s);

  // 操作ボタンの列に「録画」を入れる(LIVEのとき N秒前VAR の隣に出る。見た目は lab.css)
  const recBtn = document.createElement('button');
  recBtn.type = 'button';
  recBtn.id = 'labRec';
  recBtn.className = 'action-btn lab-rec-btn';
  const REC_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2.4"/><circle cx="12" cy="12" r="4.6" fill="currentColor"/></svg>';
  const STOP_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="5" width="14" height="14" rx="2.5" fill="currentColor"/></svg>';
  recBtn.innerHTML = `${REC_SVG}<span class="lab-rec-label">録画</span>`;
  actions.appendChild(recBtn);
  // 「REC 0:10」などを、リプレイ中にも見せるための小さい帯
  const subBand = document.createElement('div');
  subBand.className = 'state-band state-band-sub';
  subBand.id = 'labSubBand';
  subBand.hidden = true;
  bands.appendChild(subBand);

  [recBtn, el('#labStart'), el('#labCloseSheet'), el('#labBackSheet'), el('#labVClose'), el('#labVGrid'), el('#labPlay'), el('#labUndoBtn'), el('#labMakeBtn')].forEach((b) => attachPress(b, { vibrate: 30 }));

  const sheet = el('#labSheet');
  const testSheet = el('#labTestSheet');
  const overlay = el('#labOverlay');
  function setSheet(which) { // 'main' | 'test' | null
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
  el('#labOpenTest').addEventListener('click', () => setSheet('test'));
  el('#labBackSheet').addEventListener('click', () => setSheet('main'));

  methodsPromise.then((m) => {
    const a = m.A.ok ? `○(${m.A.mime})` : '×';
    const b = m.B.ok ? `○(${m.B.codec}${m.B.audio ? ` + ${m.B.audio}` : '、音は使えません'})` : `×(${m.B.reason})`;
    el('#labSupport').textContent = `この端末で使える録画: ふつう(MP4にまとめる) ${b} / 比べる用 ${a}`;
  });

  // ---- 状態の帯 ----
  const take = () => parent.take;
  const isRecording = () => !!(take() && !take().stoppedAt);
  const isCollecting = () => !!(take() && take().stoppedAt && !take().collectedAt && !take().gaveUp);
  let saving = null; // { text } 保存中の表示
  function collectPercent() {
    const sum = parent.summary();
    let got = 0; let want = 0;
    for (const r of sum.rows) {
      if (r.expected == null) return null;
      got += Math.min(r.segs, r.expected); want += r.expected;
    }
    return want ? Math.round((got / want) * 100) : null;
  }
  function bandWant() {
    if (isRecording()) return { state: 'rec', text: `REC ${fmtMS(Date.now() - take().startedAt)}` };
    if (isCollecting()) { const p = collectPercent(); return { state: 'collect', text: p == null ? '集めています' : `集めています ${p}%` }; }
    return null;
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

  // ---- 録画を始める・終える ----
  let starting = false;
  async function startRec() {
    if (starting || isRecording() || isCollecting()) return;
    starting = true;
    try {
      const u = await store.usage();
      if (u && u.freeMB < DEFAULTS.minFreeMB * 2) { raiseAlarm(`空き容量が少ないため(あと約${Math.round(u.freeMB)}MB)、録画を始められません`); return; }
      setSheet(null);
      const ok = await parent.startTake({
        method: el('#optMethod').value, segSec: Number(el('#optSeg').value), maxSec: Number(el('#optMax').value), audio: el('#optAudio').value === '1',
      });
      if (!ok) showToast('録画を始められませんでした');
      else if (capture.status.audio && capture.status.audio.ok === false && el('#optAudio').value === '1') showToast('音なしで録画します');
      enableWakeLock({ quiet: true });
    } finally { starting = false; render(); }
  }
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
  function showMake(text, btn, act, hideAfterMs = 0) {
    clearTimeout(makeTimer);
    el('#labMakeText').textContent = text;
    el('#labMakeBtn').textContent = btn;
    makeAct = act;
    makeEl.classList.add('show');
    if (hideAfterMs) makeTimer = setTimeout(hideMake, hideAfterMs);
  }
  function hideMake() { clearTimeout(makeTimer); makeEl.classList.remove('show'); makeAct = null; }
  el('#labMakeBtn').addEventListener('click', () => { if (makeAct) makeAct(); });
  const fmtRemain = (ms) => (ms < 60000 ? `あと${Math.max(1, Math.round(ms / 1000))}秒` : `あと約${Math.round(ms / 60000)}分`);

  async function makeCombined(t) {
    let cancel = false;
    const started = performance.now();
    const stamp = fileStamp(t.startedAt);
    saving = { text: 'まとめを作っています 0%' };
    refreshSub();
    showMake('まとめを作っています', 'やめる', () => { cancel = true; });
    let out;
    try {
      out = await composeTake(store, t, {
        quality: el('#optQuality').value,
        audioCam: el('#optAudioCam').value,
        shouldCancel: () => cancel,
        onProgress: ({ fraction, remainMs, replay }) => {
          const pct = Math.round(fraction * 100);
          saving = { text: `まとめを作っています ${pct}%${replay ? `(${fmtRemain(remainMs)})` : ''}` };
          el('#labMakeText').textContent = saving.text; // 縦の画面では状態の帯がシートに隠れるので、「やめる」の横にも出す
          refreshSub();
        },
      });
    } catch (err) {
      hideMake();
      window.__lastMakeError = String(err && err.message ? err.message : err);
      if (err && err.cancelled) showToast('まとめをやめました。カメラごとの動画は保存済みです');
      else if (err && err.unsupported) showToast('この端末では、まとめ動画は作れません');
      else showToast('まとめを作れませんでした。カメラごとの動画は保存済みです');
      return;
    }
    const file = new File([out.blob], `kendovar_${stamp}_まとめ.${out.ext}`, { type: out.mime });
    lastSave.make = { mode: out.mode, ms: out.ms, bytes: file.size, width: out.width, height: out.height, fps: out.fps, frames: out.frames, videoCodec: out.videoCodec, audioCodec: out.audioCodec, hasAudio: out.hasAudio, audioCam: out.audioCam, name: file.name, quality: el('#optQuality').value };
    window.__lastMake = { file, ...lastSave.make };
    saving = null;
    refreshSub();
    const deliver = async () => {
      hideMake();
      const how = await deliverFiles([file], { title: '剣道VAR 長めの録画(まとめ)', mode: el('#optSave').value });
      if (how === 'cancelled') showToast('保存をやめました');
      else { saving = { text: '保存しました' }; refreshSub(); setTimeout(() => { saving = null; refreshSub(); }, 2200); }
    };
    window.__lab.deliverMake = deliver;
    // ダウンロードなら、押した操作が要らないので、できたらそのまま保存する。共有の画面は押した直後でないと出せない端末があるため、「保存」を押してもらう
    if (resolveSaveMode(el('#optSave').value) === 'download') deliver();
    else showMake('まとめができました', '保存', deliver, 120000);
    window.__lastMake.performanceNote = `${Math.round(performance.now() - started)}ms`;
  }

  // ---- 保存 ----
  const savingIds = new Set();
  let lastSave = null;
  async function saveTake(t) {
    if (savingIds.has(t.id)) return; // 二度押ししても、保存は1回だけ
    savingIds.add(t.id);
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
        showToast(err && err.message && /映像がありません/.test(err.message) ? err.message : '途中で止まりました。もう一度保存してください。');
        return;
      }
      const how = await deliverFiles(res.files, { title: '剣道VAR 長めの録画', mode: el('#optSave').value });
      lastSave = { at: Date.now(), ms: Math.round(performance.now() - started), how, info: res.info, files: res.files.map((f) => ({ name: f.name, type: f.type, size: f.size })) };
      window.__lastSave = lastSave;
      if (how === 'cancelled') showToast('保存をやめました');
      else {
        if (res.note) showToast(res.note);
        if (res.info.length >= 2) await makeCombined(t);
        else {
          saving = { text: '保存しました' };
          refreshSub();
          await new Promise((r) => setTimeout(r, 2200));
        }
      }
    } finally {
      saving = null; savingIds.delete(t.id); refreshSub(); takesSig = ''; render();
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
  function closeViewer() { viewer.close(); vEl.hidden = true; setSheet('main'); }
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
    try { await viewer.open(takeId); } catch (err) { showToast('再生できませんでした'); window.__labViewerError = String(err && err.message ? err.message : err); vEl.hidden = true; setSheet('main'); return; }
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
    lines.push(`【録画の数値】${fmtClock(tk.startedAt)} 録画のしかた:${tk.method === 'B' ? 'ふつう(MP4にまとめる)' : '比べる用'} 内部の区切り${tk.segSec}秒 長さ${tk.stoppedAt ? fmtDur(tk.stoppedAt - tk.startedAt) : '録画中'}${tk.partial ? ' 途中まで' : ''}`);
    if (segs[0]) lines.push(`録画の形式: ${segs[0].mime}`);
    if (live && live.take.collectMs != null) lines.push(`終わり→全カメラの映像がそろうまで: ${(live.take.collectMs / 1000).toFixed(1)}秒`);
    else if (tk.collectedAt && tk.stoppedAt) lines.push(`終わり→全カメラの映像がそろうまで: ${((tk.collectedAt - tk.stoppedAt) / 1000).toFixed(1)}秒`);
    else if (tk.stoppedAt) lines.push('終わり→全カメラの映像がそろうまで: まだそろっていません');
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
    }
    if (lastSave) {
      lines.push(`保存: ${lastSave.how === 'shared' ? '共有の画面' : lastSave.how === 'downloaded' ? 'ダウンロード' : 'やめた'} ${lastSave.ms}ms ${lastSave.info.map((i) => (i.kind === 'one' ? `${i.cam}:${i.ext}(映像${i.videoCodec} 音${i.hasAudio ? i.audioCodec : 'なし'}) ${(i.bytes / 1048576).toFixed(1)}MB` : `${i.cam}:${i.parts}個に分かれた`)).join(' / ')}`);
    }
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
    const sig = JSON.stringify([list.map((t) => [t.id, t.stoppedAt, t.collectedAt, !!t.partial, Object.keys(t.cams || {}).length]), [...savingIds], cur && cur.id, isCollecting()]);
    if (sig === takesSig) return;
    takesSig = sig;
    const ul = el('#labTakes');
    ul.innerHTML = '';
    list.forEach((t) => {
      const li = document.createElement('li');
      li.dataset.take = t.id;
      const collecting = !!(cur && cur.id === t.id && (!t.stoppedAt || isCollecting()));
      const cams = Object.keys(t.cams || {}).length;
      const info = document.createElement('div');
      info.className = 'lab-take-info';
      const dur = t.stoppedAt ? fmtDur(t.stoppedAt - t.startedAt) : '';
      info.innerHTML = `<b>${esc(fmtClock(t.startedAt))}</b><span>${dur ? `${dur} ・ ` : ''}${cams}台</span>${t.partial ? '<em>途中まで</em>' : ''}`;
      li.appendChild(info);
      if (collecting) {
        const p = document.createElement('div');
        p.className = 'lab-take-wait';
        p.textContent = !t.stoppedAt ? '録画中' : '集めています';
        li.appendChild(p);
      } else {
        const row = document.createElement('div');
        row.className = 'lab-take-btns';
        const mk = (text, cls, fn, dis) => { const b = document.createElement('button'); b.type = 'button'; b.textContent = text; b.className = cls; if (dis) b.disabled = true; b.addEventListener('click', fn); attachPress(b, { vibrate: 30 }); return b; };
        row.append(
          mk('見る', 'lab-act lab-act-main', () => openViewer(t.id)),
          mk('保存', 'lab-act', () => saveTake(t), savingIds.has(t.id)),
          mk('消す', 'lab-act', () => removeTakes([t.id])),
        );
        li.appendChild(row);
      }
      ul.appendChild(li);
    });
  }
  let openedFor = null;
  function render() {
    const recording = isRecording();
    const collecting = isCollecting();
    // 操作ボタン: 録画中だけ「録画を終える」。集めている間は出さない(今使える操作だけ)
    if (recBtn.dataset.rec !== String(recording)) {
      recBtn.dataset.rec = String(recording);
      recBtn.innerHTML = `${recording ? STOP_SVG : REC_SVG}<span class="lab-rec-label">${recording ? '録画を終える' : '録画'}</span>`;
    }
    recBtn.classList.toggle('is-recording', recording);
    recBtn.hidden = collecting;
    monitorArea.classList.toggle('lab-recording', recording);
    overlayBand.refresh();
    refreshSub();
    // 集め終わったら、録画の一覧を自動で開く
    if (take() && take().stoppedAt && take().collectedAt && openedFor !== take().id) { openedFor = take().id; if (vEl.hidden) setSheet('main'); }
    // シートの中身
    const open = sheet.classList.contains('open');
    el('#labStart').hidden = recording || collecting;
    const line = el('#labLine');
    line.hidden = !(recording || collecting);
    if (recording) line.textContent = '録画しています。終えるには、画面の下の「録画を終える」を押します。';
    else if (collecting) {
      const p = collectPercent();
      line.textContent = `ほかのスマホの映像を集めています${p == null ? '' : ` ${p}%`}`;
    }
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
  // 「集めるのをやめる」: 子機の映像がそろわないまま待ち続けないため(試験用の扱い。普通は自動でそろう)
  window.__lab.giveUpCollect = () => { if (take() && take().stoppedAt && !take().collectedAt) { take().gaveUp = true; take().collectedAt = Date.now(); take().partial = true; parent._saveTake(); render(); } };
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
