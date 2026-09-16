/* RuninqVic - AI music generation (lyrics + style -> song) via pluggable providers.
   Calls go through the Vercel proxy (api/music.js) when the app is served over http(s) and the
   proxy is reachable; otherwise the browser calls the vendor API directly with the user's key. */
(function (root) {
  const RV = (root.RV = root.RV || {});
  const LS_KEY = 'rv.musicgen.keys';

  const STYLE_CHIPS = [
    '잔잔한 피아노 발라드', '따뜻한 어쿠스틱 기타', '신나는 팝', '감성 R&B', '부드러운 재즈', '로파이 힙합',
    '웅장한 시네마틱 오케스트라', '경쾌한 트로트', '밝은 동요', '크리스마스 캐럴', '차분한 뉴에이지', '축하 파티 댄스',
  ];

  function loadKeys() { try { return JSON.parse(localStorage.getItem(LS_KEY) || '{}'); } catch (e) { return {}; } }
  function saveKeys(k) { try { localStorage.setItem(LS_KEY, JSON.stringify(k)); } catch (e) { /* ignore */ } }

  /* Build the style prompt sent to any provider */
  function buildPrompt(p) {
    const parts = [];
    if (p.style) parts.push(p.style.trim());
    if (p.vocal === 'female') parts.push('female vocals, Korean lyrics');
    else if (p.vocal === 'male') parts.push('male vocals, Korean lyrics');
    else if (p.vocal === 'none') parts.push('instrumental, no vocals');
    else parts.push('vocals, Korean lyrics');
    parts.push('high quality, clear mix, suitable as background music for a photo slideshow video');
    return parts.join(', ');
  }

  /* split user lyrics into sections: "[chorus]" style tags or blank lines start a new section */
  function parseLyricSections(lyrics) {
    const lines = String(lyrics || '').replace(/\r/g, '').split('\n');
    const sections = []; let cur = null;
    const push = () => { if (cur && cur.lines.length) sections.push(cur); };
    for (const raw of lines) {
      const line = raw.trim();
      const tag = line.match(/^\[([^\]]{1,40})\]$/);
      if (tag) { push(); cur = { name: tag[1], lines: [] }; continue; }
      if (!line) { if (cur && cur.lines.length) { push(); cur = null; } continue; }
      if (!cur) cur = { name: '', lines: [] };
      cur.lines.push(line.slice(0, 200));
    }
    push();
    return sections.length ? sections : [{ name: '', lines: [] }];
  }
  const DEFAULT_SECTION_NAMES = ['Verse 1', 'Chorus', 'Verse 2', 'Chorus', 'Bridge', 'Chorus', 'Outro'];
  function sectionName(sec, i) {
    if (sec.name) {
      const n = sec.name.toLowerCase().replace(/[-_]/g, ' ');
      if (/verse|절/.test(n)) return 'Verse' + (n.match(/\d+/) ? ' ' + n.match(/\d+/)[0] : '');
      if (/pre.?chorus/.test(n)) return 'Pre-Chorus';
      if (/chorus|후렴|hook/.test(n)) return 'Chorus';
      if (/bridge|브릿지|브리지/.test(n)) return 'Bridge';
      if (/intro|인트로/.test(n)) return 'Intro';
      if (/outro|아웃트로|ending/.test(n)) return 'Outro';
      return sec.name.slice(0, 40);
    }
    return DEFAULT_SECTION_NAMES[Math.min(i, DEFAULT_SECTION_NAMES.length - 1)];
  }

  const providers = {
    /* ---- Mureka (https://platform.mureka.ai/docs) ----
       async task: POST /v1/song/generate (lyrics required) or /v1/instrumental/generate, then poll /v1/song/query/{id}.
       Korean vocals officially supported. No length parameter: length follows the lyrics. */
    mureka: {
      label: 'Mureka (추천 · 한국어 보컬 공식 지원)',
      keyUrl: 'https://platform.mureka.ai/',
      note: '가사·스타일 지원, 한국어 보컬 공식 지원, 곡당 약 $0.05~0.15 (선불 충전). 길이는 가사 분량에 따라 정해짐(최대 5분 30초)',
      envName: 'MUREKA_API_KEY',
      directCors: true,
      async generate(p, key, o) {
        const H = { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' };
        const B = 'https://api.mureka.ai';
        const wantVocals = p.vocal !== 'none';
        let lyrics = wantVocals && p.lyrics ? p.lyrics.trim().slice(0, 5000) : '';
        const stylePrompt = buildPrompt(p).slice(0, 1024);
        let task, queryPath, madeLyrics = null;
        if (!wantVocals) {
          o.onStatus && o.onStatus('Mureka에 연주곡을 요청하는 중…');
          const r = await callVendor(B + '/v1/instrumental/generate', { method: 'POST', headers: H, body: JSON.stringify({ model: MUREKA_MODEL, prompt: stylePrompt, n: 1 }) }, o);
          task = await r.json(); queryPath = '/v1/instrumental/query/';
        } else {
          if (!lyrics) {
            o.onStatus && o.onStatus('분위기에 맞는 가사를 짓는 중…');
            const lr = await callVendor(B + '/v1/lyrics/generate', { method: 'POST', headers: H, body: JSON.stringify({ prompt: '한국어 가사. ' + (p.style || '') + '. 사진 슬라이드쇼 영상의 배경음악용. 2절과 후렴으로 구성.' }) }, o);
            const lj = await lr.json(); lyrics = String(lj.lyrics || '').slice(0, 5000); madeLyrics = lyrics;
            if (!lyrics) throw new Error('가사를 만들지 못했습니다. 가사를 직접 입력해 주세요.');
          }
          o.onStatus && o.onStatus('Mureka에 작곡을 요청하는 중…');
          const body = { lyrics, model: MUREKA_MODEL, prompt: stylePrompt, n: 1 };
          if (p.vocal === 'female' || p.vocal === 'male') body.gender = p.vocal;
          const r = await callVendor(B + '/v1/song/generate', { method: 'POST', headers: H, body: JSON.stringify(body) }, o);
          task = await r.json(); queryPath = '/v1/song/query/';
        }
        if (!task || !task.id) throw new Error('Mureka 작업을 시작하지 못했습니다: ' + JSON.stringify(task).slice(0, 200));
        /* poll */
        const t0 = performance.now(); let st = task;
        while (!['succeeded', 'failed', 'timeouted', 'cancelled'].includes(st.status)) {
          if (performance.now() - t0 > 8 * 60 * 1000) throw new Error('작곡이 8분 안에 끝나지 않았습니다. 잠시 후 다시 시도해 주세요.');
          await sleep(4000, o.signal);
          const qr = await callVendor(B + queryPath + encodeURIComponent(task.id), { method: 'GET', headers: { Authorization: 'Bearer ' + key } }, o);
          st = await qr.json();
          o.onStatus && o.onStatus('Mureka가 작곡하는 중… (' + ({ preparing: '준비', queued: '대기', running: '생성', streaming: '생성' }[st.status] || st.status) + ', ' + Math.round((performance.now() - t0) / 1000) + '초)');
        }
        if (st.status !== 'succeeded') throw new Error('Mureka 작곡 실패: ' + (st.failed_reason || st.status));
        const song = st.choices && st.choices[0]; if (!song || !song.url) throw new Error('Mureka 응답에 곡이 없습니다.');
        o.onStatus && o.onStatus('완성된 곡을 내려받는 중…');
        const blob = await fetchAudio(song.url, o);
        return { blob, mime: blob.type || 'audio/mpeg', ext: /\.wav($|\?)/i.test(song.url) ? 'wav' : 'mp3', lyrics: madeLyrics, durationMs: song.duration };
      },
    },
    /* ---- ElevenLabs Music (https://elevenlabs.io/docs/api-reference/music) ----
       prompt XOR composition_plan. Styles must be English, lyrics can be any language.
       With user lyrics: ask /v1/music/plan (free) for English styles from the Korean description,
       then compose with a chunk plan that carries the user's exact lyrics. */
    elevenlabs: {
      label: 'ElevenLabs (Eleven Music · 개인 이용)',
      keyUrl: 'https://elevenlabs.io/app/settings/api-keys',
      note: '가사·스타일 지원, 길이를 정확히 지정, 59개 언어 보컬(한국어는 미공식). 요금: 분당 크레딧. 셀프서비스 요금제는 개인 용도 한정',
      envName: 'ELEVENLABS_API_KEY',
      directCors: true,
      async generate(p, key, o) {
        const H = { 'xi-api-key': key, 'Content-Type': 'application/json' };
        const lengthMs = Math.round(RV.clamp(p.lengthSec, 10, 300) * 1000);
        const wantVocals = p.vocal !== 'none';
        const userLyrics = wantVocals && p.lyrics && p.lyrics.trim();
        const model = 'music_v2_5';
        let body;
        if (userLyrics) {
          o.onStatus && o.onStatus('가사에 맞는 곡 구성을 만드는 중…');
          let styles = null;
          try {
            const pr = await callVendor('https://api.elevenlabs.io/v1/music/plan', { method: 'POST', headers: H, body: JSON.stringify({ prompt: buildPrompt(p) + '. Lyrics will be provided in Korean.', music_length_ms: lengthMs, model_id: model }) }, o);
            const plan = await pr.json();
            const pos = [], neg = [];
            if (plan.chunks) plan.chunks.forEach((c) => { (c.positive_styles || []).forEach((s) => pos.push(s)); (c.negative_styles || []).forEach((s) => neg.push(s)); });
            if (plan.positive_global_styles) { plan.positive_global_styles.forEach((s) => pos.push(s)); (plan.negative_global_styles || []).forEach((s) => neg.push(s)); }
            if (pos.length) styles = { pos: Array.from(new Set(pos)).slice(0, 30), neg: Array.from(new Set(neg)).slice(0, 20) };
          } catch (e) { console.warn('plan failed, falling back to prompt lyrics', e); }
          if (styles) {
            const vocalStyle = p.vocal === 'female' ? 'female vocals' : p.vocal === 'male' ? 'male vocals' : 'vocals';
            const secs = parseLyricSections(userLyrics).slice(0, 30);
            const per = Math.max(3000, Math.round(lengthMs / secs.length));
            body = { model_id: model, composition_plan: { chunks: secs.map((s, i) => ({
              text: '[' + sectionName(s, i) + ']\n' + s.lines.slice(0, 30).join('\n'),
              duration_ms: per, positive_styles: Array.from(new Set([vocalStyle, 'Korean lyrics'].concat(styles.pos))).slice(0, 50), negative_styles: styles.neg, context_adherence: 'high',
            })) } };
          } else {
            body = { model_id: model, prompt: (buildPrompt(p) + '\n\nSing exactly these Korean lyrics:\n' + userLyrics).slice(0, 4100), music_length_ms: lengthMs };
          }
        } else {
          body = { model_id: model, prompt: buildPrompt(p).slice(0, 4100), music_length_ms: lengthMs, force_instrumental: !wantVocals };
        }
        o.onStatus && o.onStatus('ElevenLabs가 작곡하는 중… (보통 30초~2분)');
        const r = await callVendor('https://api.elevenlabs.io/v1/music?output_format=mp3_44100_128', { method: 'POST', headers: Object.assign({ Accept: 'audio/mpeg' }, H), body: JSON.stringify(body) }, o);
        const blob = await r.blob();
        if (!blob.size) throw new Error('빈 응답을 받았습니다.');
        return { blob: blob.type && blob.type.startsWith('audio') ? blob : new Blob([blob], { type: 'audio/mpeg' }), mime: 'audio/mpeg', ext: 'mp3' };
      },
    },
    /* ---- MiniMax Music (https://platform.minimax.io/docs/api-reference/music-generation) ----
       synchronous JSON, audio as hex; HTTP 200 even on errors -> check base_resp.status_code */
    minimax: {
      label: 'MiniMax Music (2026년 8월 이전 가입 계정만)',
      keyUrl: 'https://platform.minimax.io/user-center/basic-information/interface-key',
      note: '가사·스타일 지원, 최대 5분, 길이는 가사 분량에 따라 정해짐. 2026년 8월 20일 이후 신규 가입 계정은 사용할 수 없습니다',
      envName: 'MINIMAX_API_KEY',
      directCors: true,
      async generate(p, key, o) {
        const wantVocals = p.vocal !== 'none';
        const userLyrics = wantVocals && p.lyrics && p.lyrics.trim();
        const body = { model: MINIMAX_MODEL, prompt: buildPrompt(p).slice(0, 2000), output_format: 'hex', audio_setting: { sample_rate: 44100, bitrate: 128000, format: 'mp3' } };
        if (!wantVocals) { body.is_instrumental = true; }
        else if (userLyrics) { body.lyrics = userLyrics.slice(0, 3500); }
        else { body.lyrics_optimizer = true; body.lyrics = ''; }
        o.onStatus && o.onStatus('MiniMax가 작곡하는 중… (보통 30초~2분)');
        const r = await callVendor(MINIMAX_URL, { method: 'POST', headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, o);
        const j = await r.json();
        const code = j.base_resp && j.base_resp.status_code;
        if (code) {
          const map = { 1002: '요청이 너무 많습니다. 잠시 후 다시 시도하세요.', 1004: 'API 키가 올바르지 않습니다.', 2049: 'API 키가 올바르지 않습니다.', 1008: '서비스 잔액(크레딧)이 부족합니다.', 1026: '가사나 설명에 허용되지 않는 내용이 있어 거부되었습니다.', 2013: '요청 값이 잘못되었습니다.' };
          throw new Error('MiniMax: ' + (map[code] || j.base_resp.status_msg || code));
        }
        const hex = j.data && j.data.audio; if (!hex) throw new Error('MiniMax 응답에 오디오가 없습니다.');
        const bytes = new Uint8Array(hex.length >> 1); for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
        return { blob: new Blob([bytes], { type: 'audio/mpeg' }), mime: 'audio/mpeg', ext: 'mp3' };
      },
    },
    /* ---- demo: no network, synthesizes a simple tune so the flow can be tried without a key ---- */
    demo: {
      label: '데모 (연습용 · 인터넷 불필요)',
      keyUrl: '', note: '실제 작곡이 아닌 연습용 멜로디를 만듭니다', envName: '', directCors: true, noKey: true,
      async generate(p, key, o) {
        o.onStatus && o.onStatus('연습용 멜로디 생성 중…');
        const buf = RV.audio.makeTone(Math.min(p.lengthSec, 180), p.style && /신나|댄스|팝|트로트/.test(p.style) ? 128 : 84);
        await new Promise((r) => setTimeout(r, 800));
        return { blob: wavBlob(buf), mime: 'audio/wav', ext: 'wav' };
      },
    },
  };
  const MINIMAX_URL = 'https://api.minimax.io/v1/music_generation';
  const MINIMAX_MODEL = 'music-3.0';
  const MUREKA_MODEL = 'mureka-9'; /* pinned: 'auto' may resolve to the 3x pricier 9.5 */

  function sleep(ms, signal) {
    return new Promise((res, rej) => { const t = setTimeout(res, ms); if (signal) signal.addEventListener('abort', () => { clearTimeout(t); rej(new DOMException('취소됨', 'AbortError')); }, { once: true }); });
  }
  /* download a finished song: direct first (CDNs usually allow it), then via the proxy */
  async function fetchAudio(url, o) {
    try { const r = await fetch(url, { signal: o.signal }); if (r.ok) { const b = await r.blob(); if (b.size) return b; } } catch (e) { /* CORS or network: try proxy */ }
    const info = await probeServer();
    if (!info.ok) throw new Error('완성된 곡 파일을 내려받을 수 없습니다(브라우저 보안 제한). 웹 버전(runinqvic.vercel.app)에서 다시 시도해 주세요.');
    const r = await fetch('api/music', { method: 'POST', signal: o.signal, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url, method: 'GET', headers: {}, body: null, provider: o.provider, useServerKey: false }) });
    if (!r.ok) throw new Error('곡 파일 내려받기 실패: ' + r.status);
    return await r.blob();
  }

  function wavBlob(buffer) {
    const n = buffer.length, ch = 2, sr = buffer.sampleRate; const out = new DataView(new ArrayBuffer(44 + n * ch * 2));
    const s = (o, str) => { for (let i = 0; i < str.length; i++) out.setUint8(o + i, str.charCodeAt(i)); };
    s(0, 'RIFF'); out.setUint32(4, 36 + n * ch * 2, true); s(8, 'WAVE'); s(12, 'fmt '); out.setUint32(16, 16, true); out.setUint16(20, 1, true); out.setUint16(22, ch, true); out.setUint32(24, sr, true); out.setUint32(28, sr * ch * 2, true); out.setUint16(32, ch * 2, true); out.setUint16(34, 16, true); s(36, 'data'); out.setUint32(40, n * ch * 2, true);
    const L = buffer.getChannelData(0), R = buffer.getChannelData(1); let o = 44;
    for (let i = 0; i < n; i++) { out.setInt16(o, Math.max(-1, Math.min(1, L[i])) * 32767, true); o += 2; out.setInt16(o, Math.max(-1, Math.min(1, R[i])) * 32767, true); o += 2; }
    return new Blob([out.buffer], { type: 'audio/wav' });
  }

  /* server proxy discovery (only meaningful when served over http/https) */
  let serverInfo = null;
  async function probeServer() {
    if (serverInfo) return serverInfo;
    if (!/^https?:/.test(location.protocol)) return (serverInfo = { ok: false, providers: {} });
    try {
      const r = await fetch('api/music?probe=1', { cache: 'no-store' });
      serverInfo = r.ok ? await r.json() : { ok: false, providers: {} };
    } catch (e) { serverInfo = { ok: false, providers: {} }; }
    return serverInfo;
  }

  /* Perform a vendor request: through the proxy when available (avoids CORS, can use a server key), else direct. */
  async function callVendor(url, init, o) {
    const info = await probeServer();
    let r;
    if (info.ok) {
      const headers = Object.assign({}, init.headers || {});
      r = await fetch('api/music', { method: 'POST', signal: o.signal, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url, method: init.method || 'POST', headers, body: init.body || null, provider: o.provider, useServerKey: !o.key }) });
    } else {
      if (!o.key) throw new Error('API 키가 필요합니다.');
      r = await fetch(url, Object.assign({}, init, { signal: o.signal }));
    }
    if (!r.ok) {
      let msg = r.status + ' ' + r.statusText;
      try { const t = await r.text(); try { const j = JSON.parse(t); msg = (j.error && (j.error.message || j.error)) || j.detail && (j.detail.message || JSON.stringify(j.detail)) || j.message || msg; } catch (e2) { if (t) msg = t.slice(0, 300); } } catch (e) { /* ignore */ }
      if (r.status === 401 || r.status === 403) msg = 'API 키가 올바르지 않거나 권한이 없습니다. (' + msg + ')';
      if (r.status === 402) msg = '서비스 잔액(크레딧)이 부족합니다. (' + msg + ')';
      throw new Error(msg);
    }
    return r;
  }

  RV.musicgen = {
    STYLE_CHIPS,
    providers,
    providerIds: () => Object.keys(providers),
    getKey: (id) => (loadKeys()[id] || ''),
    setKey: (id, key, persist) => { const k = loadKeys(); if (persist && key) k[id] = key; else delete k[id]; saveKeys(k); if (!persist && key) sessionKeys[id] = key; },
    probeServer,
    buildPrompt,
    _internals: { parseLyricSections, sectionName },
    /* generate({provider, style, lyrics, vocal, lengthSec, key, signal, onStatus}) -> {blob, mime, ext, meta} */
    async generate(p) {
      const prov = providers[p.provider]; if (!prov) throw new Error('알 수 없는 작곡 서비스입니다.');
      const info = await probeServer();
      const key = p.key || sessionKeys[p.provider] || RV.musicgen.getKey(p.provider) || '';
      const serverHasKey = !!(info.ok && info.providers && info.providers[p.provider]);
      if (!prov.noKey && !key && !serverHasKey) throw new Error('API 키를 입력해 주세요.');
      if (!info.ok && !prov.directCors && !prov.noKey) throw new Error('이 서비스는 웹 버전(https://runinqvic.vercel.app)에서만 쓸 수 있습니다. 브라우저에서 직접 호출할 수 없습니다.');
      const t0 = performance.now();
      p.onStatus && p.onStatus('작곡 요청을 보냈습니다. 보통 30초~2분 걸립니다…');
      const res = await prov.generate(p, key, { signal: p.signal, onStatus: p.onStatus, provider: p.provider, key: serverHasKey && !p.key ? '' : key });
      res.meta = { provider: p.provider, style: p.style, lyrics: res.lyrics || p.lyrics, vocal: p.vocal, lengthSec: p.lengthSec, madeLyrics: res.lyrics || null, seconds: Math.round((performance.now() - t0) / 1000), prompt: buildPrompt(p) };
      return res;
    },
  };
  const sessionKeys = {};
})(typeof window !== 'undefined' ? window : globalThis);
