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

  function clientId() {
    try { let id = localStorage.getItem('rv.client.id'); if (!id) { id = (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2) + Date.now()); localStorage.setItem('rv.client.id', id); } return id; }
    catch (e) { return ''; }
  }
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

  /* a bundled song presented as a "provider": choosing it just loads the file */
  function builtinSong(title, url, lengthLabel) {
    return {
      label: '🎵 ' + title + ' (' + lengthLabel + ')', title, url, group: 'builtin', builtin: true, noKey: true, directCors: true, keyUrl: '', envName: '',
      note: '기본 제공 음악 · 키 없이 바로 사용',
      async generate(p, key, o) {
        o.onStatus && o.onStatus('곡을 불러오는 중…');
        let r;
        try { r = await fetch(url, { signal: o.signal }); }
        catch (e) { if (e.name === 'AbortError') throw e; throw new Error(/^file:/.test(location.protocol) ? '이 실행 방식에서는 기본 제공 곡을 불러올 수 없습니다. RuninqVic.bat으로 실행하거나 웹 버전(runinqvic.vercel.app)을 이용해 주세요.' : '곡 파일을 불러오지 못했습니다. 인터넷 연결을 확인해 주세요.'); }
        if (!r.ok) throw new Error('곡 파일을 불러오지 못했습니다 (' + r.status + ').');
        const blob = await r.blob();
        return { blob: blob.type && blob.type.startsWith('audio') ? blob : new Blob([blob], { type: 'audio/mpeg' }), mime: 'audio/mpeg', ext: 'mp3' };
      },
    };
  }

  const providers = {
    /* ---- ElevenLabs Music (https://elevenlabs.io/docs/api-reference/music) ----
       prompt XOR composition_plan. Styles must be English, lyrics can be any language.
       With user lyrics: ask /v1/music/plan (free) for English styles from the Korean description,
       then compose with a chunk plan that carries the user's exact lyrics. */
    elevenlabs: {
      label: 'ElevenLabs로 새 곡 만들기 (AI 작곡)', group: 'ai',
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
        let blob;
        try { blob = await r.blob(); }
        catch (e) { if (e && e.name === 'AbortError') throw e; throw new Error('곡을 받는 중 연결이 끊겼습니다. 다시 시도해 주세요.'); }
        if (!blob.size) throw new Error('빈 응답을 받았습니다.');
        /* mp3_44100_128 is about 16 KB per second: far less than that means the download was cut off */
        if (blob.size < lengthMs / 1000 * 16000 * 0.2) throw new Error('곡이 끝까지 받아지지 않았습니다. 다시 시도해 주세요.');
        return { blob: blob.type && blob.type.startsWith('audio') ? blob : new Blob([blob], { type: 'audio/mpeg' }), mime: 'audio/mpeg', ext: 'mp3' };
      },
    },
    /* ---- built-in songs: bundled with the app, no key, no network service ---- */
    'song-spring-1': builtinSong('봄의 첫빛 (1)', 'assets/music/spring-first-light-1.mp3', '2:19'),
    'song-spring-2': builtinSong('봄의 첫빛 (2)', 'assets/music/spring-first-light-2.mp3', '2:36'),
    'song-rosemarine': builtinSong('Rosemarine', 'assets/music/rosemarine.mp3', '1:42'),
  };

  function sleep(ms, signal) {
    return new Promise((res, rej) => { const t = setTimeout(res, ms); if (signal) signal.addEventListener('abort', () => { clearTimeout(t); rej(new DOMException('취소됨', 'AbortError')); }, { once: true }); });
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
  let serverInfo = null, serverInfoAt = 0;
  let probing = null;
  function probeServer() {
    /* re-check every minute so a change made by the operator reaches open pages; a failed check is retried after 5 s */
    const ttl = serverInfo && serverInfo.ok ? 60000 : 5000;
    if (serverInfo && performance.now() - serverInfoAt < ttl) return Promise.resolve(serverInfo);
    if (probing) return probing;   /* share one request between callers that ask at the same time */
    if (!/^https?:/.test(location.protocol)) { serverInfoAt = performance.now(); return Promise.resolve(serverInfo = { ok: false, providers: {} }); }
    probing = (async () => {
      let info;
      try { const r = await fetch('api/music?probe=1', { cache: 'no-store' }); info = r.ok ? await r.json() : null; } catch (e) { info = null; }
      serverInfo = info && typeof info === 'object' && info.providers ? info : { ok: false, providers: {} };
      serverInfoAt = performance.now(); probing = null;
      return serverInfo;
    })();
    return probing;
  }

  /* Perform a vendor request: through the proxy when available (avoids CORS, can use a server key), else direct. */
  async function callVendor(url, init, o) {
    const info = await probeServer();
    let r;
    if (info.ok) {
      const headers = Object.assign({}, init.headers || {});
      r = await fetch('api/music', { method: 'POST', signal: o.signal, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url, method: init.method || 'POST', headers, body: init.body || null, provider: o.provider, useServerKey: !o.key, accessCode: o.accessCode || '', clientId: clientId() }) });
    } else {
      if (!o.key) throw new Error('API 키가 필요합니다.');
      r = await fetch(url, Object.assign({}, init, { signal: o.signal }));
    }
    if (!r.ok) {
      let msg = r.status + ' ' + r.statusText, ours = false, reason = '';
      try {
        const t = await r.text();
        try {
          const j = JSON.parse(t);
          if (typeof j.error === 'string') { msg = j.error; ours = true; reason = String(j.reason || ''); }   /* message from our own proxy (already Korean) */
          else msg = (j.error && j.error.message) || (j.detail && (j.detail.message || JSON.stringify(j.detail))) || j.message || msg;
        } catch (e2) { if (t) msg = t.slice(0, 300); }
      } catch (e) { /* ignore */ }
      if (!ours && (r.status === 401 || r.status === 403)) msg = 'API 키가 올바르지 않거나 권한이 없습니다. (' + msg + ')';
      if (!ours && r.status === 402) msg = '서비스 잔액(크레딧)이 부족합니다. (' + msg + ')';
      const err = new Error(msg); err.status = r.status; err.ours = ours; err.reason = reason; throw err;
    }
    return r;
  }

  RV.musicgen = {
    STYLE_CHIPS,
    providers,
    providerIds: () => Object.keys(providers),
    getKey: (id) => (sessionKeys[id] || loadKeys()[id] || ''),
    setKey: (id, key, persist) => { const k = loadKeys(); if (persist && key) k[id] = key; else delete k[id]; saveKeys(k); if (!persist && key) sessionKeys[id] = key; else if (!key) delete sessionKeys[id]; },
    probeServer,
    buildPrompt,
    _internals: { parseLyricSections, sectionName },
    /* operator-only: usage summary of the key registered on the server */
    async usage(adminCode) {
      const r = await fetch('api/music?usage=1', { cache: 'no-store', headers: { 'x-admin-code': adminCode || '' } });
      let j = null; try { j = await r.json(); } catch (e) { /* ignore */ }
      if (!r.ok) throw new Error((j && j.error) || ('사용량을 불러오지 못했습니다 (' + r.status + ')'));
      return j;
    },
    /* generate({provider, style, lyrics, vocal, lengthSec, key, accessCode, signal, onStatus}) -> {blob, mime, ext, meta}
       Key choice: the server (lecture) key when the site has one - and, if the site asks for a lecture code, only when a code is given;
       otherwise the visitor's own key. */
    async generate(p) {
      const prov = providers[p.provider]; if (!prov) throw new Error('알 수 없는 작곡 서비스입니다.');
      const info = await probeServer();
      const ownKey = p.key || sessionKeys[p.provider] || RV.musicgen.getKey(p.provider) || '';
      const serverHasKey = !!(info.ok && info.providers && info.providers[p.provider]);
      const useServer = !prov.noKey && serverHasKey && (!info.needsCode || !!p.accessCode);
      if (!prov.noKey && !useServer && !ownKey) throw new Error(serverHasKey && info.needsCode ? '강의 코드를 입력하거나 내 API 키를 넣어 주세요.' : 'API 키를 입력해 주세요.');
      if (!info.ok && !prov.directCors && !prov.noKey) throw new Error('이 서비스는 웹 버전(https://runinqvic.vercel.app)에서만 쓸 수 있습니다. 브라우저에서 직접 호출할 수 없습니다.');
      if (useServer && info.maxSongSeconds && p.lengthSec > info.maxSongSeconds) p = Object.assign({}, p, { lengthSec: info.maxSongSeconds });
      const key = useServer ? '' : ownKey;
      const t0 = performance.now();
      p.onStatus && p.onStatus('작곡 요청을 보냈습니다. 보통 30초~2분 걸립니다…');
      const res = await prov.generate(p, key, { signal: p.signal, onStatus: p.onStatus, provider: p.provider, key, accessCode: useServer ? (p.accessCode || '') : '' });
      res.meta = { provider: p.provider, style: p.style, lyrics: res.lyrics || p.lyrics, vocal: p.vocal, lengthSec: p.lengthSec, madeLyrics: res.lyrics || null, seconds: Math.round((performance.now() - t0) / 1000), prompt: buildPrompt(p), usedServerKey: useServer };
      return res;
    },
  };
  const sessionKeys = {};
})(typeof window !== 'undefined' ? window : globalThis);
