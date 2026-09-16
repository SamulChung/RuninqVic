/* RuninqVic - Vercel serverless proxy for AI music generation (Node runtime, Fluid compute).
   GET  /api/music?probe=1  -> { ok: true, providers: { elevenlabs: bool, minimax: bool, mureka: bool }, maxSeconds }
   POST /api/music          -> forwards one vendor request and STREAMS the vendor response back
                               (streaming avoids Vercel's 4.5 MB response limit for multi-MB songs).
   Body: { url, method, headers, body, provider, useServerKey }
   Only allow-listed vendor hosts are proxied. Server keys come from env:
   ELEVENLABS_API_KEY, MINIMAX_API_KEY, MUREKA_API_KEY (set in Vercel > Settings > Environment Variables). */
const { Readable } = require('stream');

const ALLOWED_HOSTS = ['api.elevenlabs.io', 'api.minimax.io', 'api.minimaxi.com', 'api.minimax.cn', 'api.mureka.ai'];
/* finished-song downloads (GET only, never with a server key): vendor CDNs */
const DOWNLOAD_SUFFIXES = ['mureka.ai', 'skywork.ai', 'cloudfront.net', 'amazonaws.com', 'aliyuncs.com', 'myqcloud.com', 'googleapis.com', 'elevenlabs.io'];
const SERVER_KEYS = {
  elevenlabs: { env: 'ELEVENLABS_API_KEY', header: 'xi-api-key', format: (k) => k },
  minimax: { env: 'MINIMAX_API_KEY', header: 'authorization', format: (k) => 'Bearer ' + k },
  mureka: { env: 'MUREKA_API_KEY', header: 'authorization', format: (k) => 'Bearer ' + k },
};
const MAX_SECONDS = 300;

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'GET') {
    const providers = {};
    for (const [id, cfg] of Object.entries(SERVER_KEYS)) providers[id] = !!process.env[cfg.env];
    res.status(200).json({ ok: true, providers, maxSeconds: MAX_SECONDS });
    return;
  }
  if (req.method !== 'POST') { res.status(405).json({ error: 'POST only' }); return; }
  let payload = req.body;
  if (typeof payload === 'string') { try { payload = JSON.parse(payload); } catch (e) { payload = null; } }
  if (!payload || !payload.url) { res.status(400).json({ error: 'url required' }); return; }
  let target;
  try { target = new URL(payload.url); } catch (e) { res.status(400).json({ error: 'bad url' }); return; }
  const method = (payload.method || 'POST').toUpperCase();
  const hostOk = ALLOWED_HOSTS.includes(target.hostname) || (method === 'GET' && DOWNLOAD_SUFFIXES.some((sfx) => target.hostname === sfx || target.hostname.endsWith('.' + sfx)));
  if (target.protocol !== 'https:' || !hostOk) { res.status(400).json({ error: 'host not allowed: ' + target.hostname }); return; }

  const headers = {};
  for (const [k, v] of Object.entries(payload.headers || {})) if (typeof v === 'string') headers[k.toLowerCase()] = v;
  const cfg = SERVER_KEYS[payload.provider];
  if (payload.useServerKey && ALLOWED_HOSTS.includes(target.hostname)) {
    const key = cfg && process.env[cfg.env];
    if (!key) { res.status(401).json({ error: '이 서비스의 서버 키가 등록되어 있지 않습니다. API 키를 입력해 주세요.' }); return; }
    headers[cfg.header] = cfg.format(key);
  }
  delete headers.host; delete headers['content-length']; delete headers.origin; delete headers.referer;

  const ac = new AbortController();
  req.on('close', () => { if (!res.writableEnded) ac.abort(); });
  let upstream;
  try {
    upstream = await fetch(target.toString(), {
      method, headers, signal: ac.signal,
      body: payload.body == null ? undefined : (typeof payload.body === 'string' ? payload.body : JSON.stringify(payload.body)),
    });
  } catch (e) {
    if (!res.headersSent) res.status(502).json({ error: '작곡 서비스에 연결할 수 없습니다: ' + (e.message || e) });
    return;
  }
  res.status(upstream.status);
  res.setHeader('Content-Type', upstream.headers.get('content-type') || 'application/octet-stream');
  for (const h of ['song-id', 'x-request-id', 'trace-id']) { const v = upstream.headers.get(h); if (v) res.setHeader(h, v); }
  if (!upstream.body) { res.end(); return; }
  Readable.fromWeb(upstream.body).on('error', () => { try { res.end(); } catch (e) { /* ignore */ } }).pipe(res);
};
