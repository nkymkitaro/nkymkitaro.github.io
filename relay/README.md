# 中継の試作: 合言葉を発行する Worker

目的: 携帯回線どうしで、親機と子機がつながるかを試す(`?relay=1` を付けたときだけ有効)。本番の動きは変わらない。

## 作る手順(中山さん。無料枠の範囲)

1. Cloudflare のアカウント(無料)を作る。**支払い方法の登録を求められたら、そこで止めて、技術マネージャーに知らせる。**
2. ダッシュボードの「Calls」→「TURN」で、TURN の鍵を1つ作る。表示される「Key ID」と「API Token」を、控える(チャットやメモには書かない)。
3. このフォルダ(`relay/`)で、次を実行する(パソコンのターミナル。Node.js が要る)。
   ```
   npx wrangler login
   npx wrangler secret put TURN_KEY_ID
   npx wrangler secret put TURN_KEY_API_TOKEN
   npx wrangler deploy
   ```
4. 最後に表示される URL(`https://mitori-relay-credentials.<名前>.workers.dev`)を、システムコーダーに伝える。`js/relay.js` の `RELAY_WORKER_URL` に入れて、反映する。

## 確かめ方

- `?relay=1` を付けて、親機と子機を開く。「試験用」の数値のコピーに `経路: 中継` か `経路: 直接` が出る。
- Wi‑Fi を切った携帯回線どうしでつながれば、経路が中継になる。同じ Wi‑Fi では、直接になる(中継を通らない)。
