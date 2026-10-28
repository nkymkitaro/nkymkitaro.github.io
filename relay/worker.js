// relay/worker.js: 中継(TURN)に使う、短時間だけ有効な合言葉を発行する小さな仕組み。Cloudflare Workers(無料枠)に置く。
// - TURN の鍵(TURN_KEY_ID、TURN_KEY_API_TOKEN)は、Workers の「秘密の設定」にだけ入れる。アプリにもリポジトリにも書かない
// - 呼べる場所は https://kendovar.jp(ブラウザの Origin で確かめる)。ほかの場所からは 403
// - 返すもの: { iceServers: [...] }。有効なのは4時間。映像は中継を通っても暗号化されたままで、この仕組みは中身を見ない・残さない
// 手順は relay/README.md
const ALLOWED_ORIGINS = ['https://kendovar.jp'];
const TTL_SECONDS = 14400;

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const allowed = ALLOWED_ORIGINS.includes(origin);
    const cors = allowed
      ? { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Methods': 'GET, OPTIONS', 'Vary': 'Origin' }
      : { 'Vary': 'Origin' };
    if (request.method === 'OPTIONS') return new Response(null, { status: allowed ? 204 : 403, headers: cors });
    if (!allowed || request.method !== 'GET') return new Response('forbidden', { status: 403, headers: cors });
    if (!env.TURN_KEY_ID || !env.TURN_KEY_API_TOKEN) return new Response('not configured', { status: 500, headers: cors });

    const res = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${env.TURN_KEY_ID}/credentials/generate`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.TURN_KEY_API_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ttl: TTL_SECONDS }),
    });
    if (!res.ok) return new Response('upstream error', { status: 502, headers: cors });
    const data = await res.json();
    const servers = Array.isArray(data.iceServers) ? data.iceServers : [data.iceServers];
    return new Response(JSON.stringify({ iceServers: servers }), {
      status: 200,
      headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    });
  },
};
