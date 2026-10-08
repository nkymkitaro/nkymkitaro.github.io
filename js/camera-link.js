// CameraLink: WebRTC(PeerJS)による複数カメラ映像の取得・配信を担当するクラス。
// 親機自身のカメラ + 子機(最大3台) = 合計4台までの映像ソースを管理する。
// 「今どんなカメラが繋がっているか」が変わるたびに onCamsChanged で外部(composition root)
// に知らせるだけで、ボタンなどのDOM組み立てはこのクラスの外に任せる(疎結合)。
import { showToast } from './toast.js';

const MAX_REMOTE_CAMS = 3; // 親機1台 + 子機最大3台 = 合計4台まで
const LOCAL_CAMERA_NUMBER = 1; // 親機自身のカメラは「カメラ1」。参加してきた子機は「カメラ2」から(ゲームのプレイヤー番号のように)
const MAX_STALE_DISCONNECTED = 2; // 切断済みでも直後はレビューできるよう少しだけ残しておく数
const JOIN_TIMEOUT_MS = 10000; // 子機が参加を試みてから、あきらめるまでの時間
const RECONNECT_INTERVAL_MS = 3000; // 子機の通信が切れたとき、繋ぎ直しを試す間隔
const RECONNECT_ATTEMPT_MS = 8000; // 繋ぎ直し1回ぶんの待ち時間
const RECONNECT_GRACE_MS = 3000; // 回線が不安定になってから、切れたと見なすまでの待ち時間

export class CameraLink {
  constructor() {
    this.peer = null;
    this.myId = '';
    this.activeSource = 'local';
    this.remoteCams = []; // { id, label, videoEl, connected, call, dataConn }
    this.onCamsChanged = null; // (sources) => void
    this.onPauseStateChanged = null; // 子機側: (isPaused) => void
    this.onConnectionLost = null; // 子機側: 参加後に通信が切れた
    this.onReconnected = null; // 子機側: 繋ぎ直せた (number) => void
    this.onCamRemoved = null; // (camId) => void: 切断済みカメラを完全に破棄した時に呼ばれる(録画バッファの解放用)

    this.isPaused = false; // 親機側: 全カメラを一時停止中かどうか
    this.ownStream = null; // 子機側: 自分がカメラから取得した映像(一時停止トグル用)

    this.localMonitorVideo = document.getElementById('localMonitorVideo');
  }

  static generateShortId() {
    return Math.floor(1000 + Math.random() * 9000).toString();
  }

  getAllSources() {
    return [
      { id: 'local', label: `カメラ${LOCAL_CAMERA_NUMBER}`, videoEl: this.localMonitorVideo, connected: true },
      ...this.remoteCams.map((c) => ({ id: c.id, label: c.label, videoEl: c.videoEl, connected: c.connected })),
    ];
  }

  getActiveVideoElement() {
    const src = this.getAllSources().find((s) => s.id === this.activeSource);
    return src ? src.videoEl : this.localMonitorVideo;
  }

  _notifyCamsChanged() {
    if (this.onCamsChanged) this.onCamsChanged(this.getAllSources());
  }

  // 親機として起動: 自分のカメラを取得し、子機からの着信も受け付ける(最大3台まで)
  async startAsMonitor(onLocalStreamReady) {
    this.myId = CameraLink.generateShortId();
    document.getElementById('myIdDisplay').textContent = this.myId;

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment', width: { ideal: 640 }, height: { ideal: 480 } },
        audio: false,
      });
      this.localMonitorVideo.srcObject = stream;
      this.localMonitorVideo.onloadedmetadata = () => {
        this.localMonitorVideo.play();
        onLocalStreamReady(this.localMonitorVideo);
        this._notifyCamsChanged();
      };
    } catch (err) {
      console.error(err);
      showToast('カメラを起動できませんでした。カメラの利用を許可してください。');
    }

    this.peer = new Peer('kendo-var-room-' + this.myId);
    this.peer.on('call', (call) => this._handleIncomingCall(call));
  }

  _handleIncomingCall(call) {
    const camId = 'remote-' + call.peer;
    const existing = this.remoteCams.find((c) => c.id === camId);
    // 満員判定は「現在接続中」の子機だけで数える。切断済みの子機はスロットを
    // 塞いだままにしない(でないと切れたはずの子機のせいで新しい子機が入れなくなる)。
    // すでに繋がっている同じ子機が繋ぎ直してきた場合は、台数を増やさないので満員でも受け入れる。
    const connectedCount = this.remoteCams.filter((c) => c.connected).length;
    const isRejoinOfConnected = existing && existing.connected;
    if (!isRejoinOfConnected && connectedCount >= MAX_REMOTE_CAMS) {
      // 満員。繋いできた子機にその旨を伝えてから切る。
      const rejectConn = this.peer.connect(call.peer);
      rejectConn.on('open', () => rejectConn.send('FULL'));
      rejectConn.on('error', (e) => console.error(e));
      call.close();
      return;
    }

    // 通信が切れた子機が同じ端末のまま繋ぎ直してきた場合は、新しい子機として数えず元の枠に戻す
    // (名前・録画の続きを引き継ぐ。でないと、再接続のたびに子機が増えてしまう)
    if (existing) {
      const wasConnected = existing.connected;
      const oldCall = existing.call;
      existing.connected = true;
      this._attachCall(existing, call);
      if (oldCall && oldCall !== call) {
        try { oldCall.close(); } catch (err) { console.error(err); }
      }
      if (!wasConnected) showToast(`${existing.label}が再接続しました`);
      this._notifyCamsChanged();
      return;
    }

    this._pruneStaleDisconnected();
    const number = this._freeCameraNumber();
    const videoEl = document.createElement('video');
    videoEl.autoplay = true;
    videoEl.playsInline = true;
    videoEl.muted = true;
    videoEl.style.display = 'none';
    document.body.appendChild(videoEl);

    const camEntry = { id: camId, label: `カメラ${number}`, number, videoEl, connected: true, call: null, dataConn: null };
    this.remoteCams.push(camEntry);
    this._attachCall(camEntry, call);
  }

  // 新しく参加してきたカメラの番号。使われていない中でいちばん小さい番号にする
  // (切断済みで残っているカメラの番号とも重ならないようにして、同じ名前が2つ並ばないようにする)
  _freeCameraNumber() {
    const used = new Set(this.remoteCams.map((c) => c.number));
    let n = LOCAL_CAMERA_NUMBER + 1;
    while (used.has(n)) n++;
    return n;
  }

  // 子機1台ぶんの着信(映像)と、合図用の回線を、camEntryに結びつける。
  // 新しく繋いできたときも、繋ぎ直してきたときも同じ手順で使う。
  _attachCall(camEntry, call) {
    camEntry.call = call;
    call.answer();

    // 映像(call)とは別に、一時停止/再開などの合図を送るための専用回線を張っておく
    if (camEntry.dataConn) {
      try { camEntry.dataConn.close(); } catch (err) { console.error(err); }
    }
    const dataConn = this.peer.connect(call.peer);
    camEntry.dataConn = dataConn;
    dataConn.on('error', (e) => console.error(e));
    dataConn.on('open', () => {
      // 子機側が「参加できた」と分かるよう、まず受け入れたことと、カメラの番号(カメラ2なら2)を返す
      dataConn.send({ type: 'JOINED', number: camEntry.number });
      if (this.isPaused) dataConn.send('PAUSE'); // 一時停止中に繋いできた子機にも合わせる
    });

    const markDisconnected = () => {
      // 繋ぎ直しで置き換わった古い回線の終了には反応しない
      if (camEntry.call !== call || !camEntry.connected) return;
      camEntry.connected = false;
      if (this.activeSource === camEntry.id) {
        // ライブ表示中に切断された場合、固まった最後のコマを映し続けないよう親機に戻す
        this.activeSource = 'local';
        showToast(`${camEntry.label}が切断されたため、カメラ${LOCAL_CAMERA_NUMBER}の映像に戻しました`);
      }
      this._notifyCamsChanged();
    };
    call.on('close', markDisconnected);

    call.on('stream', (remoteStream) => {
      camEntry.videoEl.srcObject = remoteStream;
      camEntry.videoEl.onloadedmetadata = () => {
        camEntry.videoEl.play();
        this._notifyCamsChanged();
      };
      remoteStream.getVideoTracks().forEach((track) => {
        track.addEventListener('ended', markDisconnected);
      });
      // ブラウザによってはcall.on('close')が発火しないことがあるための保険
      const pc = call.peerConnection;
      if (pc) {
        pc.addEventListener('iceconnectionstatechange', () => {
          if (['disconnected', 'failed', 'closed'].includes(pc.iceConnectionState)) {
            markDisconnected();
          }
        });
      }
    });
  }

  // 切断済みの子機が溜まりすぎないように、古いものから片付ける。
  // (直近に切れた分は少しだけ残して、VARで見返せる余地を残す)
  _pruneStaleDisconnected() {
    const disconnected = this.remoteCams.filter((c) => !c.connected);
    const excess = disconnected.length - MAX_STALE_DISCONNECTED;
    if (excess <= 0) return;
    disconnected.slice(0, excess).forEach((c) => this._removeCam(c));
  }

  // 切断済みの子機を完全に破棄する(DOM要素・回線・録画バッファをすべて解放)
  _removeCam(camEntry) {
    this.remoteCams = this.remoteCams.filter((c) => c !== camEntry);
    if (camEntry.videoEl && camEntry.videoEl.parentNode) {
      camEntry.videoEl.parentNode.removeChild(camEntry.videoEl);
    }
    if (camEntry.dataConn) {
      try { camEntry.dataConn.close(); } catch (err) { console.error(err); }
    }
    if (this.onCamRemoved) this.onCamRemoved(camEntry.id);
    this._notifyCamsChanged();
  }

  // ---- 子機側 ----
  // 子機として起動: 映像を送るだけの軽量ピア
  startAsCamera() {
    this.peer = new Peer();
    this._peerReady = new Promise((resolve) => this.peer.on('open', resolve));
    this.peer.on('connection', (conn) => {
      conn.on('data', (data) => this._onMonitorMessage(data));
    });
    this.peer.on('error', (err) => this._onCameraPeerError(err));
    this.peer.on('disconnected', () => {
      // 通信サーバーとの接続が切れただけなら、つなぎ直せる
      try { this.peer.reconnect(); } catch (err) { console.error(err); }
    });
  }

  // 親機からの合図を受ける
  _onMonitorMessage(data) {
    if (data === 'FULL') {
      if (this._pendingJoin) this._pendingJoin.finish({ ok: false, reason: 'full' });
    } else if (data && data.type === 'JOINED') {
      if (this._pendingJoin) this._pendingJoin.finish({ ok: true, number: data.number });
    } else if (data === 'PAUSE' || data === 'RESUME') {
      const enabled = data === 'RESUME';
      if (this.ownStream) {
        this.ownStream.getVideoTracks().forEach((t) => { t.enabled = enabled; });
      }
      if (this.onPauseStateChanged) this.onPauseStateChanged(!enabled);
    }
  }

  _onCameraPeerError(err) {
    console.error(err);
    if (!this._pendingJoin) return;
    if (err && err.type === 'peer-unavailable') {
      this._pendingJoin.finish({ ok: false, reason: 'not-found' });
    } else if (err && ['network', 'server-error', 'socket-error', 'socket-closed'].includes(err.type)) {
      this._pendingJoin.finish({ ok: false, reason: 'network' });
    }
  }

  // 自分のカメラの映像を用意する(つなぎ直しのたびに許可を求めないよう、取れていれば使い回す)
  async _ensureOwnStream() {
    if (this.ownStream && this.ownStream.getVideoTracks().some((t) => t.readyState === 'live')) return true;
    try {
      this.ownStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment', width: { ideal: 640 }, height: { ideal: 480 } },
        audio: false,
      });
      return true;
    } catch (err) {
      console.error(err);
      return false;
    }
  }

  // 親機に映像を送り始め、「参加できた」の合図が返るまで待つ。
  // 結果: { ok: true, number } か { ok: false, reason: 'camera' | 'not-found' | 'full' | 'closed' | 'timeout' | 'network' }
  _callMonitor(timeoutMs) {
    return new Promise((resolve) => {
      let settled = false;
      let call = null;
      let closeTimer = null;
      const timer = setTimeout(() => finish({ ok: false, reason: this._peerIsOpen ? 'timeout' : 'network' }), timeoutMs);
      const finish = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearTimeout(closeTimer);
        this._pendingJoin = null;
        if (result.ok) {
          this._watchCall(call);
        } else if (call) {
          try { call.close(); } catch (err) { console.error(err); }
        }
        resolve(result);
      };
      this._pendingJoin = { finish };
      this._peerReady.then(() => {
        this._peerIsOpen = true;
        if (settled) return;
        call = this.peer.call('kendo-var-room-' + this.targetId, this.ownStream);
        this.cameraCall = call;
        // 参加できる前に回線が閉じられたら、満員で断られた可能性が高い。
        // 理由を伝える合図(FULL)が少し遅れて届くことがあるので、少しだけ待つ
        call.on('close', () => {
          if (!settled) closeTimer = setTimeout(() => finish({ ok: false, reason: 'closed' }), 1200);
        });
      });
    });
  }

  // 参加できたあとの回線を見張り、切れたら onConnectionLost で知らせて自動で繋ぎ直す
  _watchCall(call) {
    if (!call) return;
    let lost = false;
    let softTimer = null;
    const markLost = () => {
      if (lost || this.cameraCall !== call) return;
      lost = true;
      clearTimeout(softTimer);
      this._startReconnecting();
    };
    call.on('close', markLost);
    const pc = call.peerConnection;
    if (pc) {
      pc.addEventListener('iceconnectionstatechange', () => {
        const state = pc.iceConnectionState;
        if (state === 'failed' || state === 'closed') {
          markLost();
        } else if (state === 'disconnected') {
          // 一瞬の途切れで戻ることがあるので、少し待っても戻らなければ切れたと見なす
          clearTimeout(softTimer);
          softTimer = setTimeout(markLost, RECONNECT_GRACE_MS);
        } else {
          clearTimeout(softTimer);
        }
      });
    }
  }

  // 参加を試みる。番号が4桁そろったら呼ぶ(自動でつなぐ)
  async connectToMonitor(targetId) {
    this.targetId = targetId;
    this._userLeft = false;
    if (!(await this._ensureOwnStream())) return { ok: false, reason: 'camera' };
    const result = await this._callMonitor(JOIN_TIMEOUT_MS);
    if (result.ok) {
      this.ownStream.getVideoTracks().forEach((t) => { t.enabled = true; });
      if (this.onPauseStateChanged) this.onPauseStateChanged(false);
    }
    return result;
  }

  // 切れたあと、親機が見つかるまで一定間隔で繋ぎ直しを試す(「接続を切る」を押すまで続ける)
  async _startReconnecting() {
    if (this._reconnecting || this._userLeft) return;
    this._reconnecting = true;
    if (this.onConnectionLost) this.onConnectionLost();
    while (!this._userLeft) {
      await new Promise((r) => setTimeout(r, RECONNECT_INTERVAL_MS));
      if (this._userLeft) break;
      try { if (this.cameraCall) this.cameraCall.close(); } catch (err) { /* すでに閉じている */ }
      const result = await this._callMonitor(RECONNECT_ATTEMPT_MS);
      if (result.ok) {
        this._reconnecting = false;
        this.ownStream.getVideoTracks().forEach((t) => { t.enabled = true; });
        if (this.onReconnected) this.onReconnected(result.number);
        return;
      }
    }
    this._reconnecting = false;
  }

  // 自分から参加をやめる(カメラも止める)
  disconnectFromMonitor() {
    this._userLeft = true;
    this._reconnecting = false;
    if (this._pendingJoin) this._pendingJoin.finish({ ok: false, reason: 'cancelled' });
    const call = this.cameraCall;
    this.cameraCall = null;
    try { if (call) call.close(); } catch (err) { console.error(err); }
    if (this.ownStream) {
      this.ownStream.getTracks().forEach((t) => t.stop());
      this.ownStream = null;
    }
  }

  // 親機自身のカメラ + 全ての子機のカメラを、まとめて一時停止/再開する。
  // (子機のカメラハードウェア自体は止めず、映像を黒画面にすることで
  //  通信量・エンコード負荷を下げる。休憩中などに使う想定)
  togglePauseAll() {
    this.isPaused = !this.isPaused;
    this._setLocalTrackEnabled(!this.isPaused);
    const message = this.isPaused ? 'PAUSE' : 'RESUME';
    this.remoteCams.forEach((c) => {
      if (c.connected && c.dataConn && c.dataConn.open) {
        c.dataConn.send(message);
      }
    });
    return this.isPaused;
  }

  _setLocalTrackEnabled(enabled) {
    const stream = this.localMonitorVideo.srcObject;
    if (stream) stream.getVideoTracks().forEach((t) => { t.enabled = enabled; });
  }

  // ライブ表示するカメラを切り替える。切断済みのカメラへはライブ切り替えできない。
  switchSource(id) {
    const src = this.getAllSources().find((s) => s.id === id);
    if (!src) return false;
    if (!src.connected) {
      showToast(`${src.label}は現在接続されていません`);
      return false;
    }
    this.activeSource = id;
    return true;
  }
}
