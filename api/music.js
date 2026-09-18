/* RuninqVic - Vercel serverless proxy for AI music generation (Node runtime, Fluid compute).

   GET  /api/music?probe=1  -> { ok, guard, providers:{elevenlabs:bool}, needsCode:bool, maxSongSeconds:number|null, maxSeconds }
   GET  /api/music?usage=1  -> usage summary of the server key (header x-admin-code must equal ADMIN_CODE)
   POST /api/music          -> forwards ONE of two ElevenLabs calls and streams the answer back:
                                 POST https://api.elevenlabs.io/v1/music/plan   (free: composition plan)
                                 POST https://api.elevenlabs.io/v1/music        (compose; streamed so songs may exceed 4.5 MB)
        Body (application/json only): { url, method, headers, body, provider, useServerKey, accessCode, clientId }

   Environment variables (set with the 강의설정 tool or in Vercel > Settings > Environment Variables):
     ELEVENLABS_API_KEY     the operator's key. Visitors can then compose without their own key...
     LECTURE_CODE           ...but only with this code. Without a code the server key stays OFF unless
     LECTURE_OPEN=1         the operator deliberately opens it to everyone.
     ADMIN_CODE             required to read the usage summary.
     LECTURE_MAX_SECONDS    default 120. Longest song the server key pays for.
     LECTURE_RATE_PER_10MIN compositions per visitor IP per 10 minutes. Default 60 with a lecture code
                            (a classroom usually shares one IP), 6 in open mode. Best effort (per instance).
   The real spending ceiling is the credit limit set on the key at ElevenLabs. */
const { Readable, pipeline } = require('stream');
const crypto = require('crypto');

const GUARD = 2; /* bumped when the protection logic changes; the setup tool reads it */
const VENDOR_HOST = 'api.elevenlabs.io';
const PLAN_PATH = '/v1/music/plan', COMPOSE_PATH = '/v1/music';
const SERVER_KEYS = { elevenlabs: { env: 'ELEVENLABS_API_KEY', header: 'xi-api-key' } };
const MAX_SECONDS = 300;
const WINDOW_MS = 10 * 60 * 1000;

const env = (name) => String(process.env[name] || '').trim();
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const lectureMaxSeconds = () => clamp(parseInt(env('LECTURE_MAX_SECONDS'), 10) || 120, 10, 300);
const lectureCode = () => env('LECTURE_CODE');
const openMode = () => env('LECTURE_OPEN') === '1';
const ratePer10Min = () => clamp(parseInt(env('LECTURE_RATE_PER_10MIN'), 10) || (lectureCode() ? 60 : 6), 1, 1000);
const PER_BROWSER_10MIN = 5;
const BAD_TRIES_10MIN = 40;   /* a whole classroom may share one IP, so typos must not lock everyone out */

/* the key as usable header value: whitespace removed (a pasted key may wrap), printable ASCII only - otherwise "not registered" */
function serverKey() {
  const k = env(SERVER_KEYS.elevenlabs.env).replace(/\s+/g, '');
  return /^[\x21-\x7E]{20,200}$/.test(k) ? k : '';
}
/* the server key is usable only behind a lecture code, or when the operator opened it on purpose */
const serverKeyUsable = () => !!serverKey() && (!!lectureCode() || openMode());

function safeEqual(a, b) {
  const norm = (v) => String(v).normalize('NFC').trim();   /* Korean codes typed on different keyboards compare equal */
  const ha = crypto.createHash('sha256').update(norm(a)).digest();
  const hb = crypto.createHash('sha256').update(norm(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

/* ---- best-effort, per-instance counters (sliding 10 minute windows) ---- */
function makeCounter() {
  const map = new Map();
  const recent = (key) => { const now = Date.now(); const list = (map.get(key) || []).filter((t) => now - t < WINDOW_MS); map.set(key, list); return list; };
  return {
    count: (key) => recent(key).length,
    add: (key) => { const list = recent(key); const stamp = Date.now(); list.push(stamp); if (map.size > 5000) for (const [k, v] of map) { if (!v.some((t) => stamp - t < WINDOW_MS)) map.delete(k); } return stamp; },
    remove: (key, stamp) => { const list = map.get(key); if (!list) return; const i = list.lastIndexOf(stamp); if (i >= 0) list.splice(i, 1); },
  };
}
const songsByIp = makeCounter(), songsByBrowser = makeCounter(), badTries = makeCounter(), relayCalls = makeCounter();

function rateLimited(ip) { if (songsByIp.count(ip) >= ratePer10Min()) return true; songsByIp.add(ip); return false; }               /* kept for tests */
function tooManyBadTries(ip, record) { if (record) badTries.add(ip); return badTries.count(ip) > BAD_TRIES_10MIN; }

function clientIp(req) {
  /* Vercel sets these itself; a caller-supplied x-forwarded-for is not trusted first */
  const v = String(req.headers['x-vercel-forwarded-for'] || req.headers['x-real-ip'] || '').split(',')[0].trim();
  const xf = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return v || xf || (req.socket && req.socket.remoteAddress) || 'unknown';
}

/* keep songs paid by the server key within LECTURE_MAX_SECONDS.
   Returns null when the body is not a JSON object or cannot be brought under the cap (the caller rejects it). */
function clampSongLength(bodyText, maxSec) {
  let j; try { j = JSON.parse(bodyText); } catch (e) { return null; }
  if (!j || typeof j !== 'object' || Array.isArray(j)) return null;
  const maxMs = maxSec * 1000;
  const plan = j.composition_plan;
  if (plan && typeof plan === 'object' && !Array.isArray(plan)) {
    delete j.music_length_ms; delete j.prompt;
    const keyName = Array.isArray(plan.chunks) ? 'chunks' : Array.isArray(plan.sections) ? 'sections' : null;
    if (!keyName) return null;
    for (const other of ['chunks', 'sections']) if (other !== keyName) delete plan[other];   /* one list only, so the cap cannot be doubled */
    const parts = plan[keyName].filter((c) => c && typeof c === 'object').slice(0, Math.max(1, Math.floor(maxMs / 3000)));
    if (!parts.length) return null;
    parts.forEach((c) => { c.duration_ms = clamp(Math.round(Number(c.duration_ms)) || 3000, 3000, 120000); });
    const total = parts.reduce((a, c) => a + c.duration_ms, 0);
    if (total > maxMs) {
      const floorMs = 3000 * parts.length;                       /* <= maxMs thanks to the slice above */
      const k = (maxMs - floorMs) / (total - floorMs);
      parts.forEach((c) => { c.duration_ms = 3000 + Math.floor((c.duration_ms - 3000) * k); });
    }
    if (parts.reduce((a, c) => a + c.duration_ms, 0) > maxMs) return null;
    plan[keyName] = parts;
  } else {
    delete j.composition_plan;
    /* prompt mode: always pin the length so the model cannot choose a long one */
    j.music_length_ms = clamp(Math.round(Number(j.music_length_ms)) || maxMs, 3000, maxMs);
  }
  /* options that cost extra or keep data on the operator's account */
  delete j.store_for_inpainting; delete j.finetune_id; delete j.finetune_strength;
  return JSON.stringify(j);
}

async function usageSummary(key) {
  const H = { 'xi-api-key': key };
  const out = { ok: true, subscription: null, days: [], byProduct: {}, errors: [] };
  /* only the vendor's short status text is shown; exception text is never echoed (it can contain header values) */
  const readErr = async (r) => { let m = String(r.status); try { const j = await r.json(); const d = j && j.detail; const s = d && (d.status || d.message); if (s) m += ' ' + String(s).slice(0, 120); } catch (e) { /* ignore */ } return m; };
  try {
    const r = await fetch('https://' + VENDOR_HOST + '/v1/user/subscription', { headers: H, redirect: 'error' });
    if (r.ok) {
      const s = await r.json();
      out.subscription = { used: s.character_count, limit: s.character_limit, remaining: Math.max(0, (s.character_limit || 0) - (s.character_count || 0)), resetUnix: s.next_character_count_reset_unix || null, tier: s.tier || null, status: s.status || null };
    } else out.errors.push('구독 정보: ' + await readErr(r));
  } catch (e) { out.errors.push('구독 정보: ElevenLabs에 연결하지 못했습니다.'); }

  const end = Date.now(), start = end - 14 * 86400000;
  const stats = async (metric) => {
    const u = 'https://' + VENDOR_HOST + '/v1/usage/character-stats?start_unix=' + start + '&end_unix=' + end + '&aggregation_interval=day&metric=' + metric + '&breakdown_type=product_type';
    const r = await fetch(u, { headers: H, redirect: 'error' });
    if (!r.ok) { const err = new Error('vendor'); err.vendor = await readErr(r); throw err; }
    return await r.json();
  };
  try {
    const [credits, requests] = await Promise.all([stats('credits'), stats('request_count')]);
    const times = credits.time || [];
    const sumAt = (usage, i) => Object.values(usage || {}).reduce((a, arr) => a + (+((arr || [])[i]) || 0), 0);
    out.days = times.map((t, i) => ({ t, credits: Math.round(sumAt(credits.usage, i)), requests: Math.round(sumAt(requests.usage, i)) }));
    for (const [name, arr] of Object.entries(credits.usage || {})) out.byProduct[String(name).slice(0, 40)] = Math.round((arr || []).reduce((a, b) => a + (+b || 0), 0));
  } catch (e) { out.errors.push('날짜별 사용량: ' + (e.vendor || 'ElevenLabs에 연결하지 못했습니다.') + ' (키의 접근 범위에 사용량 조회 권한이 있어야 합니다)'); }
  return out;
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
  const ip = clientIp(req);

  if (req.method === 'GET') {
    const q = req.query || {};
    if (q.usage) {
      const admin = env('ADMIN_CODE');
      if (!admin) { res.status(403).json({ error: '관리자 코드(ADMIN_CODE)가 설정되어 있지 않습니다. 강의설정 도구에서 관리자 코드를 넣어 주세요.' }); return; }
      if (tooManyBadTries(ip, false)) { res.status(429).json({ error: '잘못된 코드를 너무 많이 입력했습니다. 10분 뒤에 다시 시도해 주세요.' }); return; }
      const sent = String(req.headers['x-admin-code'] || ''); let decoded = sent; try { decoded = decodeURIComponent(sent); } catch (e) { /* not encoded */ }
      if (!safeEqual(decoded, admin) && !safeEqual(sent, admin)) { tooManyBadTries(ip, true); res.status(403).json({ error: '관리자 코드가 올바르지 않습니다.' }); return; }
      const key = serverKey();
      if (!key) { res.status(400).json({ error: '서버에 등록된 ElevenLabs 키가 없습니다.' }); return; }
      const summary = await usageSummary(key);
      summary.settings = { lectureCode: !!lectureCode(), openMode: openMode(), maxSongSeconds: lectureMaxSeconds(), songsPer10MinPerIp: ratePer10Min() };
      res.status(200).json(summary);
      return;
    }
    const usable = serverKeyUsable();
    res.status(200).json({ ok: true, guard: GUARD, providers: { elevenlabs: usable }, needsCode: usable && !!lectureCode(), maxSongSeconds: usable ? lectureMaxSeconds() : null, maxSeconds: MAX_SECONDS });
    return;
  }
  if (req.method !== 'POST') { res.status(405).json({ error: 'POST only' }); return; }

  /* only our own page may drive the relay: JSON posts (an HTML form cannot send these) from the same site */
  if (!/^application\/json\b/i.test(String(req.headers['content-type'] || ''))) { res.status(415).json({ error: 'application/json only' }); return; }
  const site = String(req.headers['sec-fetch-site'] || '');
  if (site && site !== 'same-origin' && site !== 'none') { res.status(403).json({ error: '다른 사이트에서는 사용할 수 없습니다.' }); return; }
  relayCalls.add(ip);
  if (relayCalls.count(ip) > 300) { res.status(429).json({ error: '요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.' }); return; }

  let payload;
  try { payload = req.body; } catch (e) { res.status(400).json({ error: '요청 형식이 올바르지 않습니다.' }); return; }   /* the body getter throws on malformed JSON */
  if (!payload || typeof payload !== 'object' || typeof payload.url !== 'string') { res.status(400).json({ error: 'url required' }); return; }
  let target;
  try { target = new URL(payload.url); } catch (e) { res.status(400).json({ error: 'bad url' }); return; }
  const method = String(payload.method || 'POST').toUpperCase();
  const isPlan = target.pathname === PLAN_PATH, isCompose = target.pathname === COMPOSE_PATH;
  if (target.protocol !== 'https:' || target.hostname !== VENDOR_HOST || target.port || target.username || target.password || method !== 'POST' || !(isPlan || isCompose)) {
    res.status(400).json({ error: '허용되지 않은 요청입니다.' }); return;
  }
  let body = payload.body == null ? '' : (typeof payload.body === 'string' ? payload.body : JSON.stringify(payload.body));
  if (body.length > 200000) { res.status(413).json({ error: '요청이 너무 큽니다.' }); return; }

  /* headers sent upstream are built here - nothing is copied blindly from the caller */
  const headers = { 'content-type': 'application/json' };
  if (isCompose) headers.accept = 'audio/mpeg';
  let usingServerKey = false, refund = null;

  if (payload.useServerKey) {
    const key = serverKey();
    if (!key || !serverKeyUsable()) { res.status(401).json({ error: '이 사이트에는 사용할 수 있는 강의용 키가 없습니다. 내 API 키를 입력해 주세요.' }); return; }
    const code = lectureCode();
    if (code) {
      if (tooManyBadTries(ip, false)) { res.status(429).json({ error: '잘못된 코드를 너무 많이 입력했습니다. 10분 뒤에 다시 시도해 주세요.' }); return; }
      if (!safeEqual(String(payload.accessCode || ''), code)) { tooManyBadTries(ip, true); res.status(403).json({ error: '강의 코드가 올바르지 않습니다. 강사에게 받은 코드를 다시 확인해 주세요.', reason: 'bad_code' }); return; }
    }
    body = clampSongLength(body, lectureMaxSeconds());
    if (body == null) { res.status(400).json({ error: '요청 형식이 올바르지 않습니다.' }); return; }
    if (isCompose) {
      const browser = ip + '|' + String(payload.clientId || '').slice(0, 64);   /* can only make the limit stricter, never replaces the IP ceiling */
      if (songsByIp.count(ip) >= ratePer10Min() || songsByBrowser.count(browser) >= PER_BROWSER_10MIN) {
        res.status(429).json({ error: '잠시 후 다시 시도해 주세요. 10분 동안 만들 수 있는 곡 수를 넘었습니다. (한 사람 ' + PER_BROWSER_10MIN + '곡)' }); return;
      }
      const s1 = songsByIp.add(ip), s2 = songsByBrowser.add(browser);
      refund = () => { songsByIp.remove(ip, s1); songsByBrowser.remove(browser, s2); };   /* give the slot back when no song was produced */
    }
    target.search = isCompose ? '?output_format=mp3_44100_128' : '';   /* fixed output format; no caller-chosen query options */
    headers[SERVER_KEYS.elevenlabs.header] = key;
    usingServerKey = true;
  } else {
    const own = payload.headers && typeof payload.headers === 'object' ? String(payload.headers['xi-api-key'] || payload.headers['Xi-Api-Key'] || '') : '';
    if (!/^[\x21-\x7E]{10,200}$/.test(own)) { res.status(401).json({ error: 'API 키를 입력해 주세요.' }); return; }
    headers['xi-api-key'] = own;
    target.search = isCompose ? '?output_format=mp3_44100_128' : '';
  }

  const ac = new AbortController();
  res.on('close', () => { if (!res.writableFinished) ac.abort(); });   /* visitor cancelled or left: stop paying for the upstream call */
  let upstream;
  try {
    upstream = await fetch(target.toString(), { method: 'POST', headers, body, signal: ac.signal, redirect: 'error' });
  } catch (e) {
    if (refund) refund();
    /* never echo exception text: it can quote header values */
    if (!res.headersSent) res.status(502).json({ error: '작곡 서비스에 연결할 수 없습니다. 잠시 후 다시 시도해 주세요.' });
    return;
  }

  if (!upstream.ok && refund) refund();
  if (usingServerKey && [401, 402, 403, 429].includes(upstream.status)) {
    /* a problem with the OPERATOR's key or quota: tell the student to call the lecturer, and do not reveal balances */
    let detail = ''; try { const j = JSON.parse((await upstream.text()).slice(0, 4000)); detail = String((j.detail && j.detail.status) || '').slice(0, 60); } catch (e) { /* ignore */ }
    console.error('server key rejected', upstream.status, detail);
    const msg = upstream.status === 429 ? '작곡 요청이 몰려 있습니다. 잠시 후 다시 시도해 주세요.'
      : (upstream.status === 402 || /quota|credit/i.test(detail)) ? '강의용 키의 크레딧이 부족해 작곡할 수 없습니다. 강사에게 알려 주세요.'
      : '강의용 키의 설정 문제로 작곡할 수 없습니다. 강사에게 알려 주세요.';
    res.status(upstream.status === 429 ? 429 : 503).json({ error: msg, reason: 'server_key', upstream: detail || upstream.status });
    return;
  }

  const ct = String(upstream.headers.get('content-type') || '');
  res.status(upstream.status);
  res.setHeader('Content-Type', /^audio\//i.test(ct) ? ct : /^application\/json\b/i.test(ct) ? 'application/json; charset=utf-8' : 'application/octet-stream');
  if (!upstream.body) { res.end(); return; }
  /* pipeline destroys the response when the upstream breaks mid-song, so the browser sees an error instead of a cut-off MP3 */
  pipeline(Readable.fromWeb(upstream.body), res, () => {});
};
module.exports._internals = { clampSongLength, safeEqual, rateLimited, tooManyBadTries, serverKey, BAD_TRIES_10MIN };
