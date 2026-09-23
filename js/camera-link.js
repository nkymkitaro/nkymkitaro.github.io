// CameraLink: WebRTC(PeerJS)による複数カメラ映像の取得・配信を担当するクラス。
// 親機自身のカメラ + 子機(最大3台) = 合計4台までの映像ソースを管理する。
// 「今どんなカメラが繋がっているか」が変わるたびに onCamsChanged で外部(composition root)
// に知らせるだけで、ボタンなどのDOM組み立てはこのクラスの外に任せる(疎結合)。
import { showToast } from './toast.js';

const MAX_REMOTE_CAMS = 3; // 親機1台 + 子機最大3台 = 合計4台まで
const MAX_STALE_DISCONNECTED = 2; // 切断済みでも直後はレビューできるよう少しだけ残しておく数

export class CameraLink {
  constructor() {
    this.peer = null;
    this.myId = '';
    this.activeSource = 'local';
    this.remoteCams = []; // { id, label, videoEl, connected, call, dataConn }
    this.onCamsChanged = null; // (sources) => void
    this.onPauseStateChanged = null; // 子機側: (isPaused) => void
    this.onCamRemoved = null; // (camId) => void: 切断済みカメラを完全に破棄した時に呼ばれる(録画バッファの解放用)

    this.isPaused = false; // 親機側: 全カメラを一時停止中かどうか
    this.ownStream = null; // 子機側: 自分がカメラから取得した映像(一時停止トグル用)

    this._nextChildNumber = 1;
    this.localMonitorVideo = document.getElementById('localMonitorVideo');
  }

  static generateShortId() {
    return Math.floor(1000 + Math.random() * 9000).toString();
  }

  getAllSources() {
    return [
      { id: 'local', label: '親機', videoEl: this.localMonitorVideo, connected: true },
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
    // 満員判定は「現在接続中」の子機だけで数える。切断済みの子機はスロットを
    // 塞いだままにしない(でないと切れたはずの子機のせいで新しい子機が入れなくなる)。
    const connectedCount = this.remoteCams.filter((c) => c.connected).length;
    if (connectedCount >= MAX_REMOTE_CAMS) {
      // 満員。繋いできた子機にその旨を伝えてから切る。
      const rejectConn = this.peer.connect(call.peer);
      rejectConn.on('open', () => rejectConn.send('FULL'));
      rejectConn.on('error', (e) => console.error(e));
      call.close();
      return;
    }

    this._pruneStaleDisconnected();
    call.answer();
    const camId = 'remote-' + call.peer;
    const label = '子機' + this._nextChildNumber++;
    const videoEl = document.createElement('video');
    videoEl.autoplay = true;
    videoEl.playsInline = true;
    videoEl.muted = true;
    videoEl.style.display = 'none';
    document.body.appendChild(videoEl);

    // 映像(call)とは別に、一時停止/再開などの合図を送るための専用回線を張っておく
    const dataConn = this.peer.connect(call.peer);
    dataConn.on('error', (e) => console.error(e));

    const camEntry = { id: camId, label, videoEl, connected: true, call, dataConn };
    this.remoteCams.push(camEntry);

    if (this.isPaused) {
      dataConn.on('open', () => dataConn.send('PAUSE')); // 一時停止中に繋いできた子機にも合わせる
    }

    const markDisconnected = () => {
      if (!camEntry.connected) return;
      camEntry.connected = false;
      if (this.activeSource === camEntry.id) {
        // ライブ表示中に切断された場合、固まった最後のコマを映し続けないよう親機に戻す
        this.activeSource = 'local';
        showToast(`${camEntry.label}が切断されたため、親機の映像に戻しました`);
      }
      this._notifyCamsChanged();
    };
    call.on('close', markDisconnected);

    call.on('stream', (remoteStream) => {
      videoEl.srcObject = remoteStream;
      videoEl.onloadedmetadata = () => {
        videoEl.play();
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

  // 子機として起動: 映像を送るだけの軽量ピア
  startAsCamera() {
    this.peer = new Peer();
    this.peer.on('connection', (conn) => {
      conn.on('data', (data) => {
        if (data === 'FULL') {
          showToast('満員のため接続できませんでした(最大3台まで)');
          const statusEl = document.getElementById('cameraStatus');
          if (statusEl) statusEl.textContent = '未接続';
        } else if (data === 'PAUSE' || data === 'RESUME') {
          const enabled = data === 'RESUME';
          if (this.ownStream) {
            this.ownStream.getVideoTracks().forEach((t) => { t.enabled = enabled; });
          }
          if (this.onPauseStateChanged) this.onPauseStateChanged(!enabled);
        }
      });
    });
  }

  async connectToMonitor(targetId) {
    const statusEl = document.getElementById('cameraStatus');
    statusEl.textContent = 'カメラ起動中...';
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment', width: { ideal: 640 }, height: { ideal: 480 } },
        audio: false,
      });
      this.ownStream = stream;
      statusEl.textContent = '接続しています...';
      this.peer.call('kendo-var-room-' + targetId, stream);
      statusEl.textContent = '送信中';
    } catch (err) {
      console.error(err);
      statusEl.textContent = '未接続';
      showToast('接続できませんでした。もう一度お試しください。');
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
