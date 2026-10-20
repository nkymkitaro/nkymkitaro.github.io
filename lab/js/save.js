// save.js: 録画を端末に保存する。カメラごとに1本の動画(MP4)を作り、共有の画面(「ファイルに保存」やギャラリー)に出す。
// - iPhone・iPad は共有の画面、それ以外はダウンロード(試験用で変えられる)。共有の画面が使えないときもダウンロード
// - 1分ごとの区切りは内部の仕組みで、保存するファイルには出さない
// - MP4にまとめられない録画(圧縮が使えない端末の「ふつう」の録画)だけ、区切りごとのファイルになる(その旨を伝える)
import { buildCameraMp4 } from './mux.js';
import { B_MIME } from './recorder-b.js';

const pad2 = (n) => String(n).padStart(2, '0');

// 例: kendovar_20261017_1330_カメラ1.mp4
export function fileStamp(startedAt) {
  const d = new Date(startedAt);
  return `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}_${pad2(d.getHours())}${pad2(d.getMinutes())}`;
}

const camName = (label) => String(label || 'カメラ').replace(/[\\/:*?"<>|\s]+/g, '');


// 保存してある映像のファイルが一時的に読めないことがある(NotReadableError)ため、読めなかったら記録を取り直して読み直す(最大2回)。
// それでも読めないときは、どのカメラの何番目の区切りかをエラーに入れる(試験用の数値の「保存の失敗」に出る)
async function buildCameraMp4WithRetry(store, list, opts) {
  let cur = list;
  let lastErr = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      // 先に、全部の区切りが読めるか確かめる(1バイトずつ)
      for (const s of cur) {
        try { await s.blob.slice(0, 1).arrayBuffer(); await s.blob.slice(Math.max(0, s.blob.size - 1)).arrayBuffer(); }
        catch (err) { throw Object.assign(new Error(`${s.label || s.cam} の ${s.seq} 番目の区切り(${(s.blob.size / 1048576).toFixed(1)}MB)が読めません: ${err && err.name ? err.name : err}`), { name: err && err.name, unreadable: true }); }
      }
      return await buildCameraMp4(cur, opts);
    } catch (err) {
      lastErr = err;
      const readErr = err && (err.unreadable || err.name === 'NotReadableError');
      if (!readErr || (err && err.cancelled) || attempt === 2) break;
      await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
      const fresh = [];
      for (const s of cur) { const r = await store.get(s.key); if (r && r.blob) fresh.push(r); }
      if (fresh.length === cur.length) cur = fresh.sort((a, b) => a.t0 - b.t0);
    }
  }
  if (lastErr && lastErr.unreadable) lastErr.message += `(${3}回読み直しても読めませんでした)`;
  throw lastErr;
}

// 録画1本ぶんのファイルを作る。戻り値: { files: File[], note: string, info: [...] }
// onProgress({ index, total, label, fraction })。shouldCancel() が true なら中止する
export async function buildTakeFiles(store, take, { onProgress = () => {}, shouldCancel = () => false } = {}) {
  const segs = (await store.listByTake(take.id)).filter((s) => s.blob);
  if (!segs.length) throw new Error('保存できる映像がありません');
  const byCam = new Map();
  segs.forEach((s) => { if (!byCam.has(s.cam)) byCam.set(s.cam, []); byCam.get(s.cam).push(s); });
  const cams = [...byCam.values()].sort((a, b) => String(a[0].label).localeCompare(String(b[0].label), 'ja'));
  const stamp = fileStamp(take.startedAt);
  const files = [];
  const info = [];
  let split = false;
  for (let i = 0; i < cams.length; i++) {
    const list = cams[i].sort((a, b) => a.t0 - b.t0);
    const name = camName(list[0].label);
    onProgress({ index: i, total: cams.length, label: list[0].label, fraction: i / cams.length });
    if (list.every((s) => s.mime === B_MIME)) {
      const out = await buildCameraMp4WithRetry(store, list, { shouldCancel, onProgress: (f) => onProgress({ index: i, total: cams.length, label: list[0].label, fraction: (i + f) / cams.length }) });
      files.push(new File([out.blob], `kendovar_${stamp}_${name}.${out.ext}`, { type: out.mime }));
      info.push({ cam: list[0].label, kind: 'one', ext: out.ext, hasAudio: out.hasAudio, videoCodec: out.videoCodec, audioCodec: out.audioCodec, bytes: out.blob.size, frames: out.frames });
    } else {
      // MediaRecorder の区切りは、1本につなげられない。区切りごとのファイルにする
      split = true;
      list.forEach((s, k) => {
        const ext = s.mime.startsWith('video/mp4') ? 'mp4' : 'webm';
        files.push(new File([s.blob], `kendovar_${stamp}_${name}_${pad2(k + 1)}.${ext}`, { type: s.mime.split(';')[0] }));
      });
      info.push({ cam: list[0].label, kind: 'split', parts: list.length, bytes: list.reduce((a, s) => a + s.size, 0) });
    }
  }
  onProgress({ index: cams.length, total: cams.length, label: '', fraction: 1 });
  return { files, info, split, note: split ? 'この端末では1本にまとめられないため、区切りごとのファイルになりました' : '' };
}

// 保存のしかた。'auto' は、iPhone・iPad だけ共有の画面(「ビデオを保存」で写真に入れられる唯一の道)、それ以外はダウンロード
// (Androidの共有の画面は「保存」ではなく送り先の一覧になるため)。'share' / 'download' は試験用で選べる
export function resolveSaveMode(pref = 'auto') {
  if (pref === 'share' || pref === 'download') return pref;
  const ua = navigator.userAgent || '';
  const ios = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  return ios ? 'share' : 'download';
}

// 端末に出す。戻り値: 'shared' | 'downloaded' | 'cancelled'
export async function deliverFiles(files, { title = '剣道VAR', mode = 'auto' } = {}) {
  if (resolveSaveMode(mode) === 'share' && navigator.canShare && navigator.share) {
    try {
      if (navigator.canShare({ files })) {
        await navigator.share({ files, title });
        return 'shared';
      }
    } catch (err) {
      if (err && err.name === 'AbortError') return 'cancelled';
      // 共有の画面を出せなかった(時間がかかって、押した操作の効力が切れたなど)ときは、ダウンロードにする
    }
  }
  for (const f of files) {
    const url = URL.createObjectURL(f);
    const a = document.createElement('a');
    a.href = url; a.download = f.name;
    a.style.display = 'none';
    document.body.appendChild(a); a.click();
    await new Promise((r) => setTimeout(r, 600));
    a.remove(); URL.revokeObjectURL(url);
  }
  return 'downloaded';
}
