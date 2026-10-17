// store.js: 録画した区切り(セグメント)を、端末の中(IndexedDB)に保存する入れ物。試作用。
// - 1つのセグメント = 1台のカメラの1分ぶんの動画。キーは「録画の番号|カメラ|通し番号」
// - sent: 0 = 親機へ未送信 / 1 = 送信済み(子機は送信後も消さず、手元にも残す)
// - takes: 親機が持つ「1回の録画(テイク)」の記録

const DB_VERSION = 1;

function wrap(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export class LabStore {
  constructor(name = 'kendoVarLab') {
    this.name = name;
    this.db = null;
  }

  async open() {
    if (this.db) return this;
    this.db = await new Promise((resolve, reject) => {
      const req = indexedDB.open(this.name, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        const seg = db.createObjectStore('segments', { keyPath: 'key' });
        seg.createIndex('take', 'take');
        seg.createIndex('sent', 'sent');
        db.createObjectStore('takes', { keyPath: 'id' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return this;
  }

  _tx(storeName, mode = 'readonly') {
    return this.db.transaction(storeName, mode).objectStore(storeName);
  }

  put(rec) { return wrap(this._tx('segments', 'readwrite').put(rec)); }
  get(key) { return wrap(this._tx('segments').get(key)); }
  delete(key) { return wrap(this._tx('segments', 'readwrite').delete(key)); }
  listByTake(take) { return wrap(this._tx('segments').index('take').getAll(take)); }
  listUnsent() { return wrap(this._tx('segments').index('sent').getAll(0)); }
  async has(key) { return (await wrap(this._tx('segments').getKey(key))) !== undefined; }

  async markSent(key) {
    const rec = await this.get(key);
    if (!rec) return;
    rec.sent = 1;
    await this.put(rec);
  }

  putTake(take) { return wrap(this._tx('takes', 'readwrite').put(take)); }
  getTake(id) { return wrap(this._tx('takes').get(id)); }
  async listTakes() {
    const all = await wrap(this._tx('takes').getAll());
    return all.sort((a, b) => b.startedAt - a.startedAt);
  }

  async deleteTake(id) {
    const segs = await this.listByTake(id);
    for (const s of segs) await this.delete(s.key);
    await wrap(this._tx('takes', 'readwrite').delete(id));
  }

  async clear() {
    await wrap(this._tx('segments', 'readwrite').clear());
    await wrap(this._tx('takes', 'readwrite').clear());
  }

  // 使っている量と、あとどれだけ書き込めそうか(MB)。分からない端末では null
  async usage() {
    try {
      if (typeof window !== 'undefined' && typeof window.__labFakeFreeMB === 'number') {
        return { usedMB: 0, freeMB: window.__labFakeFreeMB, quotaMB: window.__labFakeFreeMB };
      }
      if (!navigator.storage || !navigator.storage.estimate) return null;
      const { usage, quota } = await navigator.storage.estimate();
      return { usedMB: usage / 1048576, quotaMB: quota / 1048576, freeMB: (quota - usage) / 1048576 };
    } catch (err) {
      return null;
    }
  }
}
