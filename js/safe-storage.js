// 端末に覚えておく印の読み書き。プライベート表示や制限のある端末では例外になるので、
// 読めない・書けないときは何もせず、アプリは覚えていない状態で普通に動く。
export function readLocal(key) {
  try { return localStorage.getItem(key); } catch (err) { return null; }
}

export function writeLocal(key, value) {
  try { localStorage.setItem(key, value); } catch (err) { /* 覚えられなくても動く */ }
}
