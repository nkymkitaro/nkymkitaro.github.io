// main.js: 地稽古の録画(試作)の画面と、既存のアプリ(js/app.js)との結び付け。試作用。
// - 親機: 「録画開始」「終わり」、各カメラの様子、録画の一覧、全カメラを並べて見る画面
// - 子機: 録画の様子(録画中・区切り・未送信・空き容量)と、止まったときの警報
// - 既存のVAR(直近30秒の写真方式)には手を入れない。接続とカメラの映像だけ window.kendoVarApp から借りる
import { LabStore } from './store.js';
import { LocalCapture, ChildAgent, ParentAgent, DEFAULTS, probeMethods, batteryPercent } from './agents.js';
import { LabViewer } from './viewer.js';

const PEER_PREFIX = 'kendo-var-room-';
const $ = (root, sel) => root.querySelector(sel);

const fmtTime = (ms) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}分${String(s % 60).padStart(2, '0')}秒`;
};
const fmtClock = (ms) => {
  const d = new Date(ms);
  return `${d.getMonth() + 1}/${d.getDate()} ${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
};
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ---- 警報(録画が止まったとき): 帯・音・振動 ----
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

// ===========================================================================
async function initParent(app) {
  const store = await new LabStore('kendoVarLab').open();
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

  const root = document.createElement('div');
  root.className = 'lab-root';
  root.innerHTML = `
    <button class="lab-fab" type="button" data-fab>録画(試作)</button>
    <section class="lab-sheet" data-sheet hidden>
      <header class="lab-head"><strong>地稽古の録画</strong><span class="lab-tag">試作です。</span><button type="button" data-close>閉じる</button></header>
      <div class="lab-body">
        <div class="lab-ctl">
          <button type="button" class="lab-rec" data-rec>録画開始</button>
          <span class="lab-timer" data-timer></span>
        </div>
        <div class="lab-opts">
          <label>方式<select data-method><option value="A">A(標準の録画)</option><option value="B">B(WebCodecs)</option></select></label>
          <label>区切り<select data-seg><option value="10">10秒</option><option value="30">30秒</option><option value="60" selected>60秒</option></select></label>
          <label>最長<select data-max><option value="180">3分</option><option value="600" selected>10分</option><option value="1200">20分</option></select></label>
        </div>
        <p class="lab-note" data-support></p>
        <table class="lab-table"><thead><tr><th>カメラ</th><th>状態</th><th>区切り</th><th>容量</th><th>往復</th><th>欠け</th></tr></thead><tbody data-cams></tbody></table>
        <p class="lab-result" data-result></p>
        <p class="lab-note"><button type="button" data-measure-photo>写真のコマ送りを測る</button> <span data-photo></span></p>
        <h4>録画の一覧</h4>
        <ul class="lab-takes" data-takes></ul>
        <div class="lab-actions">
          <button type="button" data-copy>数値をコピー</button>
          <button type="button" data-clear>記録をすべて消す</button>
        </div>
        <textarea class="lab-text" data-text readonly rows="8" hidden></textarea>
      </div>
    </section>
    <section class="lab-viewer" data-viewer hidden>
      <canvas data-canvas class="lab-canvas"></canvas>
      <div class="lab-vbar">
        <input type="range" data-seek min="0" max="1000" value="0">
        <div class="lab-vrow">
          <button type="button" data-v="back30">−30秒</button>
          <button type="button" data-v="prev">◀コマ</button>
          <button type="button" data-v="play">再生</button>
          <button type="button" data-v="next">コマ▶</button>
          <button type="button" data-v="fwd30">+30秒</button>
          <button type="button" data-v="close">閉じる</button>
        </div>
        <p class="lab-vinfo" data-vinfo></p>
      </div>
    </section>`;
  document.body.appendChild(root);
  const el = (s) => $(root, s);

  const sheet = el('[data-sheet]');
  el('[data-fab]').addEventListener('click', () => { sheet.hidden = !sheet.hidden; render(); });
  el('[data-close]').addEventListener('click', () => { sheet.hidden = true; });

  methodsPromise.then((m) => {
    el('[data-support]').textContent = `この端末: 方式A ${m.A.ok ? `使えます(${m.A.mime})` : '使えません'} / 方式B ${m.B.ok ? `使えます(${m.B.codec})` : `使えません(${m.B.reason})`}`;
  });

  el('[data-rec]').addEventListener('click', async () => {
    if (parent.take && !parent.take.stoppedAt) { await parent.stopTake('user'); return; }
    const u = await store.usage();
    if (u && u.freeMB < DEFAULTS.minFreeMB * 2) { raiseAlarm(`空き容量が少ないため(あと約${Math.round(u.freeMB)}MB)、録画を始められません`); return; }
    parent.startTake({
      method: el('[data-method]').value, segSec: Number(el('[data-seg]').value), maxSec: Number(el('[data-max]').value),
    });
  });

  // ラベルを接続中のカメラの名前にそろえる
  function syncLabels() {
    for (const c of parent.children.values()) {
      const cam = cameraLink.remoteCams.find((x) => x.id === c.camKey);
      if (cam) c.label = cam.label;
    }
  }

  const viewer = new LabViewer({ store, canvas: el('[data-canvas]'), onChange: () => renderViewer() });
  const vEl = el('[data-viewer]');
  const seek = el('[data-seek]');
  let seeking = false;
  function renderViewer() {
    if (vEl.hidden) return;
    const dur = viewer.durationMs || 1;
    if (!seeking) seek.value = String(Math.round(((viewer.t - viewer.tMin) / dur) * 1000));
    const m = viewer.metrics;
    el('[data-vinfo]').textContent = `${fmtTime(viewer.t - viewer.tMin)} / ${fmtTime(dur)}　離れた場面へ ${m.jumpMs ?? '-'}ms　コマ送り ${m.stepMs ?? '-'}ms　カメラ間のずれ ${m.spreadMs ?? '-'}ms`;
    $(vEl, '[data-v="play"]').textContent = viewer.playing ? '止める' : '再生';
  }
  seek.addEventListener('input', () => { seeking = true; viewer.pause(); viewer.seek(viewer.tMin + (Number(seek.value) / 1000) * viewer.durationMs).finally(() => { seeking = false; }); });
  vEl.addEventListener('click', async (e) => {
    const act = e.target.dataset && e.target.dataset.v;
    if (!act) return;
    if (act === 'close') { viewer.close(); vEl.hidden = true; sheet.hidden = false; render(); return; }
    if (act === 'play') { viewer.playing ? viewer.pause() : viewer.play(); renderViewer(); return; }
    if (act === 'prev') await viewer.step(-1);
    if (act === 'next') await viewer.step(1);
    if (act === 'back30') { viewer.pause(); await viewer.seek(viewer.t - 30000); }
    if (act === 'fwd30') { viewer.pause(); await viewer.seek(viewer.t + 30000); }
    renderViewer();
  });
  async function openViewer(takeId) {
    vEl.hidden = false;
    sheet.hidden = true;
    try { await viewer.open(takeId); } catch (err) { raiseAlarm(`再生できませんでした(${err && err.message ? err.message : err})`); vEl.hidden = true; return; }
    renderViewer();
  }
  window.__lab.viewer = viewer;
  window.__lab.openViewer = openViewer;

  // ---- 写真方式(VARの直近30秒)で1コマを出す時間。動画との比べ用 ----
  let photoStepMs = null;
  async function measurePhoto() {
    const frames = app.recorder.getFrames(cameraLink.activeSource) || [];
    if (frames.length < 10) { el('[data-photo]').textContent = '写真がまだたまっていません。少し待ってからもう一度押してください'; return; }
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
    el('[data-photo]').textContent = `写真1コマを出す時間: 平均${photoStepMs.avg}ms(最大${photoStepMs.max}ms)`;
  }
  el('[data-measure-photo]').addEventListener('click', measurePhoto);

  // ---- 数値のまとめ ----
  async function summaryText(takeId) {
    const take = takeId ? await store.getTake(takeId) : parent.take;
    if (!take) return '録画がまだありません';
    const segs = await store.listByTake(take.id);
    const byCam = new Map();
    segs.forEach((s) => { const a = byCam.get(s.cam) || { label: s.label, n: 0, bytes: 0, role: s.origin === 'own' ? '親機' : '子機' }; a.n++; a.bytes += s.size; byCam.set(s.cam, a); });
    const live = parent.take && parent.take.id === take.id ? parent.summary() : null;
    const lines = [];
    lines.push(`【録画の数値】${fmtClock(take.startedAt)} 方式${take.method} 区切り${take.segSec}秒 長さ${take.stoppedAt ? fmtTime(take.stoppedAt - take.startedAt) : '録画中'}`);
    if (segs[0]) lines.push(`録画の形式: ${segs[0].mime}`);
    if (live && live.take.collectMs != null) lines.push(`終わり→全カメラの映像がそろうまで: ${(live.take.collectMs / 1000).toFixed(1)}秒`);
    else if (take.collectedAt && take.stoppedAt) lines.push(`終わり→全カメラの映像がそろうまで: ${((take.collectedAt - take.stoppedAt) / 1000).toFixed(1)}秒`);
    else if (take.stoppedAt) lines.push('終わり→全カメラの映像がそろうまで: まだそろっていません');
    lines.push(`電池: ${take.bat0 ?? '-'}% → ${take.bat1 ?? '-'}%(熱さは手で触って記録してください)`);
    lines.push(`画面が隠れた回数・時間: ${hidden.count}回 ${Math.round(hidden.totalMs / 1000)}秒`);
    byCam.forEach((a, cam) => {
      const row = live && live.rows.find((r) => r.cam === cam);
      const exp = row && row.expected != null ? `/${row.expected}` : '';
      let extra = '';
      if (row) extra = ` 欠け最大${row.maxGapMs ?? '-'}ms 往復${row.rtt ?? '-'}ms 時計差${row.offset ?? '-'}ms 未送信${row.unsent ?? '-'} 落としたコマ${row.dropped ?? '-'}${row.errors && row.errors.length ? ` 記録:${row.errors.join(' / ')}` : ''}`;
      lines.push(`${a.label}(${a.role}): 区切り${a.n}${exp} ${(a.bytes / 1048576).toFixed(1)}MB${extra}`);
    });
    const m = viewer.metrics;
    if (m.seekMs != null) lines.push(`動画から見る: 離れた場面へ移る${m.jumpMs ?? '-'}ms 1コマ送り${m.stepMs ?? '-'}ms 画面上のカメラ間のずれ${m.spreadMs ?? '-'}ms`);
    if (photoStepMs != null) lines.push(`写真方式(VARの直近30秒): 1コマを出す${photoStepMs.avg}ms(最大${photoStepMs.max}ms、${photoStepMs.n}コマの平均)`);
    lines.push(`端末: ${navigator.userAgent}`);
    return lines.join('\n');
  }
  el('[data-copy]').addEventListener('click', async () => {
    const text = await summaryText();
    const ta = el('[data-text]');
    ta.hidden = false; ta.value = text; ta.select();
    try { await navigator.clipboard.writeText(text); } catch (err) { try { document.execCommand('copy'); } catch (e2) { /* 手でコピーしてもらう */ } }
  });
  el('[data-clear]').addEventListener('click', async () => {
    if (parent.take && !parent.take.stoppedAt) return;
    if (!window.confirm('この端末の録画の記録をすべて消します。よろしいですか。')) return;
    await store.clear();
    renderTakes();
  });

  // ---- 画面の更新 ----
  async function renderTakes() {
    const list = await store.listTakes();
    const ul = el('[data-takes]');
    ul.innerHTML = list.length ? '' : '<li class="lab-empty">まだありません</li>';
    list.forEach((t) => {
      const li = document.createElement('li');
      const cams = Object.keys(t.cams || {}).length;
      li.innerHTML = `<span>${fmtClock(t.startedAt)} ${t.stoppedAt ? fmtTime(t.stoppedAt - t.startedAt) : '録画中'} ${cams}台 方式${t.method}</span>`;
      const view = document.createElement('button'); view.type = 'button'; view.textContent = '見る';
      view.addEventListener('click', () => openViewer(t.id));
      const num = document.createElement('button'); num.type = 'button'; num.textContent = '数値';
      num.addEventListener('click', async () => { const ta = el('[data-text]'); ta.hidden = false; ta.value = await summaryText(t.id); });
      const del = document.createElement('button'); del.type = 'button'; del.textContent = '消す';
      del.addEventListener('click', async () => { if (window.confirm('この録画を消します。')) { await store.deleteTake(t.id); renderTakes(); } });
      li.append(view, num, del);
      ul.appendChild(li);
    });
  }
  let renderBusy = false;
  function render() {
    syncLabels();
    const recording = parent.take && !parent.take.stoppedAt;
    const fab = el('[data-fab]');
    fab.classList.toggle('is-rec', !!recording);
    fab.textContent = recording ? `● ${fmtTime(Date.now() - parent.take.startedAt)}` : '録画(試作)';
    if (sheet.hidden) return;
    const rec = el('[data-rec]');
    rec.textContent = recording ? '終わり' : '録画開始';
    rec.classList.toggle('is-rec', !!recording);
    ['[data-method]', '[data-seg]', '[data-max]'].forEach((s) => { el(s).disabled = !!recording; });
    el('[data-timer]').textContent = recording ? fmtTime(Date.now() - parent.take.startedAt) : '';
    const sum = parent.summary();
    el('[data-cams]').innerHTML = sum.rows.map((r) => {
      const child = parent.children.get(r.cam);
      const childRec = child && child.status && child.status.rec.recording;
      const state = r.role === '親機' ? (capture.recording ? '録画中' : '待機') : (r.connected ? (childRec ? '録画中' : '待機') : '切断');
      const segs = r.expected != null ? `${r.segs}/${r.expected}` : `${r.segs}`;
      return `<tr class="${r.alarm ? 'is-alarm' : ''}"><td>${esc(r.label)}</td><td>${state}${r.alarm ? ' ⚠' : ''}</td><td>${segs}</td><td>${r.mb.toFixed(1)}MB</td><td>${r.rtt ?? '-'}</td><td>${r.maxGapMs ?? '-'}</td></tr>`;
    }).join('');
    const t = sum.take;
    el('[data-result]').textContent = t && t.stoppedAt
      ? (t.collectMs != null ? `全カメラの映像がそろいました(終わりから ${(t.collectMs / 1000).toFixed(1)}秒)` : '終わりました。子機の映像を集めています…')
      : '';
    if (!renderBusy) { renderBusy = true; renderTakes().finally(() => { renderBusy = false; }); }
  }

  setInterval(() => { parent.tick(); render(); }, 1000);
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

  const root = document.createElement('div');
  root.className = 'lab-root lab-child';
  root.innerHTML = '<div class="lab-chip" data-chip>試作です。録画: 待機中</div>';
  document.body.appendChild(root);
  const chip = $(root, '[data-chip]');
  function render() {
    const st = agent.capture.status;
    agent.setLabel(`カメラ${app.getCameraNumber()}`);
    const connected = conn && conn.open;
    chip.classList.toggle('is-rec', st.recording);
    chip.classList.toggle('is-alarm', !!st.alarm && !st.recording);
    chip.textContent = `試作です。録画: ${st.recording ? '● 録画中' : '待機中'}　区切り${st.segs}　${connected ? '' : '親機と未接続　'}${agent.free != null ? `空き${agent.free}MB` : ''}`;
  }
  const timer = setInterval(() => {
    if (app.getRole() !== 'camera') { clearInterval(timer); agent.stopRecording('left'); root.remove(); window.__lab = null; labState.child = false; return; }
    ensureConn();
    agent.tick();
    agent.sender.unsentCount().then((n) => { chip.dataset.unsent = String(n); if (n) chip.textContent += `　未送信${n}`; });
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
