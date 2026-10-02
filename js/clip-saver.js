// clipSaver.js: VARリプレイで見ていた区間を、動画クリップとして書き出す。
// - 中身: 保存ボタンを押した瞬間に録画バッファへ残っているフレーム
//   (=そのときリプレイで見返せていた範囲)をそのまま動画にエンコードする
// - 保存先: 端末内(IndexedDB)に残しつつ、Web Share APIが使えればその場で共有(LINEなど)、
//   使えない端末ではダウンロードに切り替える
// - コーデック: Chrome/Firefoxはwebm、古いSafariはmp4しか録画できないため、
//   実際に使えた形式(MediaRecorder.mimeType)に合わせて拡張子を決める
import { showToast } from './toast.js';

const DB_NAME = 'kendo-var-clips';
const STORE_NAME = 'clips';

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE_NAME, { keyPath: 'id', autoIncrement: true });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// 端末内(IndexedDB)に保存するだけの処理。失敗しても共有/ダウンロードは続行する。
async function storeClip(record) {
  try {
    const db = await openDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).add(record);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch (err) {
    console.error('クリップの端末内保存に失敗しました', err);
  }
}

function pad(n) {
  return String(n).padStart(2, '0');
}

// 日時_カメラ名 のファイル名を作る(LINEで送った先でも端末のフォルダでも区別しやすいように)
function buildFilename(camLabel, ext) {
  const d = new Date();
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  const safeLabel = camLabel.replace(/[^\w\-一-龠ぁ-んァ-ヶー]/g, '') || 'カメラ';
  return `${stamp}_${safeLabel}.${ext}`;
}

function pickMimeType() {
  const candidates = [
    'video/webm;codecs=vp9',
    'video/webm;codecs=vp8',
    'video/webm',
    'video/mp4;codecs=avc1.42E01E',
    'video/mp4',
  ];
  if (!window.MediaRecorder) return '';
  for (const type of candidates) {
    try {
      if (MediaRecorder.isTypeSupported(type)) return type;
    } catch (err) {
      // isTypeSupported自体が無い/例外を投げる古い実装への保険
    }
  }
  return '';
}

function extensionFor(mimeType) {
  if (mimeType && mimeType.startsWith('video/mp4')) return 'mp4';
  return 'webm';
}

async function blobToDrawable(blob) {
  if (window.createImageBitmap) return await createImageBitmap(blob);
  return await new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(blob);
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = reject;
    img.src = url;
  });
}

// framesの並びをcanvasに描き直しながら、MediaRecorderでそのまま動画にエンコードする。
// (録画バッファの長さぶん、実時間と同じだけ時間がかかる。動画の長さは実際に撮った長さと一致させる)
async function encodeFramesToVideo(frames, fps) {
  if (!window.MediaRecorder || frames.length === 0) return null;

  const first = await blobToDrawable(frames[0].blob);
  const width = first.width || first.videoWidth;
  const height = first.height || first.videoHeight;
  if (first.close) first.close();
  if (!width || !height) return null;

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  const stream = canvas.captureStream(fps);

  const mimeType = pickMimeType();
  let recorder;
  try {
    recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
  } catch (err) {
    console.error('MediaRecorderを開始できませんでした', err);
    return null;
  }

  const chunks = [];
  recorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) chunks.push(e.data);
  };
  const done = new Promise((resolve) => { recorder.onstop = resolve; });

  try {
    recorder.start();
  } catch (err) {
    console.error('MediaRecorder.start()に失敗しました', err);
    return null;
  }

  // 各コマを「撮影された時刻(frame.ts)」どおりのタイミングで描く。
  // MediaRecorderは実時間で記録するので、「1コマ描いてから1/fps秒待つ」方式だと
  // デコードにかかった時間のぶんだけ動画が引き伸ばされ、スローで長い動画になってしまう。
  // そこで開始時刻からの絶対時刻で待ち、処理が追いつかないときはコマを飛ばして長さを保つ。
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const ts0 = frames[0].ts;
  const startedAt = performance.now();
  const dueAt = (i) => startedAt + (frames[i].ts - ts0);
  let pending = blobToDrawable(frames[0].blob);
  let dropped = 0;

  for (let i = 0; i < frames.length; i++) {
    let drawable;
    try {
      drawable = await pending;
    } catch (err) {
      drawable = null;
    }
    // 待っている間に次のコマを先にデコードしておく
    pending = i + 1 < frames.length ? blobToDrawable(frames[i + 1].blob) : null;
    if (pending) pending.catch(() => {});

    const wait = dueAt(i) - performance.now();
    if (wait > 0) {
      await sleep(wait);
    } else if (i + 1 < frames.length && performance.now() >= dueAt(i + 1)) {
      // 次のコマの時刻も過ぎている = 遅れている。このコマは飛ばす
      if (drawable && drawable.close) drawable.close();
      dropped++;
      continue;
    }
    if (drawable) {
      ctx.drawImage(drawable, 0, 0, width, height);
      if (drawable.close) drawable.close();
    }
  }
  await sleep(1000 / fps); // 最後のコマも1コマぶん映してから止める
  if (dropped > 0) console.info(`クリップ書き出し: 処理が追いつかず${dropped}コマ飛ばしました`);

  recorder.stop();
  await done;
  stream.getTracks().forEach((t) => t.stop());

  const actualType = recorder.mimeType || mimeType || 'video/webm';
  return { blob: new Blob(chunks, { type: actualType }), mimeType: actualType };
}

async function shareOrDownload(files) {
  if (navigator.canShare && navigator.share && navigator.canShare({ files })) {
    try {
      await navigator.share({ files, title: '剣道VAR クリップ' });
      return;
    } catch (err) {
      if (err && err.name === 'AbortError') return; // 共有シートを閉じただけなので何もしない
      console.error(err);
      // 共有に失敗した場合はダウンロードにフォールバックする
    }
  }
  files.forEach((file) => {
    const url = URL.createObjectURL(file);
    const a = document.createElement('a');
    a.href = url;
    a.download = file.name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  });
}

// targets: [{ id, label, frames }] のリスト。
// 「選択中のみ」なら1件、「全カメラ」なら接続中カメラの数ぶん渡す想定。
export async function saveClip(targets, fps) {
  const usable = (targets || []).filter((t) => t && t.frames && t.frames.length > 0);
  if (usable.length === 0) {
    showToast('保存できる録画データがまだありません');
    return;
  }

  showToast('クリップを書き出し中…');

  const files = [];
  for (const target of usable) {
    const framesSnapshot = target.frames.slice(); // 書き出し中にバッファが進んでも影響しないようコピーしておく
    const result = await encodeFramesToVideo(framesSnapshot, fps);
    if (!result) continue;
    const ext = extensionFor(result.mimeType);
    const filename = buildFilename(target.label, ext);
    files.push(new File([result.blob], filename, { type: result.mimeType }));
    storeClip({ filename, blob: result.blob, camLabel: target.label, createdAt: new Date().toISOString() });
  }

  if (files.length === 0) {
    showToast('クリップの書き出しに失敗しました。この端末は対応していない可能性があります');
    return;
  }

  await shareOrDownload(files);
  showToast(files.length === 1 ? `保存しました: ${files[0].name}` : `${files.length}件のクリップを保存しました`);
}
