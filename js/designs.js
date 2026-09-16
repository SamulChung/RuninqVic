/* RuninqVic - built-in design presets: backgrounds, frames, cinematic overlays, transitions */
(function (root) {
  const RV = (root.RV = root.RV || {});

  /* ---------- backgrounds ---------- */
  RV.BACKGROUNDS = [
    { id: 'none', label: '없음' },
    { id: 'custom', label: '사용자 색' },
    { id: 'black', label: '검정', solid: '#000000' },
    { id: 'white', label: '흰색', solid: '#ffffff' },
    { id: 'charcoal', label: '차콜', solid: '#1f2024' },
    { id: 'navy', label: '네이비', solid: '#0f1b3d' },
    { id: 'cream', label: '크림', solid: '#f6efe4' },
    { id: 'sunset', label: '노을', grad: ['#ff7e5f', '#feb47b'], dir: 'diag' },
    { id: 'ocean', label: '바다', grad: ['#1c3f60', '#4e4376'], dir: 'v' },
    { id: 'forest', label: '숲', grad: ['#134e5e', '#71b280'], dir: 'diag' },
    { id: 'night', label: '밤하늘', grad: ['#0f0c29', '#302b63', '#24243e'], dir: 'v' },
    { id: 'peach', label: '복숭아', grad: ['#ffecd2', '#fcb69f'], dir: 'h' },
    { id: 'mint', label: '민트', grad: ['#a8edea', '#fed6e3'], dir: 'diag' },
    { id: 'gold', label: '골드', grad: ['#b8860b', '#f5deb3', '#b8860b'], dir: 'diag' },
    { id: 'rose', label: '로즈', grad: ['#4a1530', '#b3446c'], dir: 'v' },
    { id: 'paper', label: '종이', solid: '#efe6d6', noise: 0.12 },
    { id: 'chalk', label: '칠판', solid: '#22302a', noise: 0.18 },
    { id: 'dots', label: '도트', solid: '#f3f4f6', pattern: 'dots' },
    { id: 'grid', label: '모눈', solid: '#fbfbf7', pattern: 'grid' },
    { id: 'stripes', label: '줄무늬', solid: '#f8efe8', pattern: 'stripes' },
  ];
  const BG_BY_ID = {}; RV.BACKGROUNDS.forEach((b) => (BG_BY_ID[b.id] = b));

  let noiseTile = null;
  function getNoiseTile() {
    if (noiseTile) return noiseTile;
    const c = document.createElement('canvas'); c.width = c.height = 256;
    const ctx = c.getContext('2d');
    const img = ctx.createImageData(256, 256);
    const r = RV.rng(1234);
    for (let i = 0; i < img.data.length; i += 4) {
      const v = Math.floor(r() * 255);
      img.data[i] = img.data[i + 1] = img.data[i + 2] = v; img.data[i + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    noiseTile = c; return c;
  }

  RV.drawBackground = function (ctx, W, H, id, customColor) {
    const b = BG_BY_ID[id] || BG_BY_ID.black;
    if (b.id === 'custom') { ctx.fillStyle = customColor || '#000'; ctx.fillRect(0, 0, W, H); return; }
    if (b.grad) {
      let g;
      if (b.dir === 'h') g = ctx.createLinearGradient(0, 0, W, 0);
      else if (b.dir === 'v') g = ctx.createLinearGradient(0, 0, 0, H);
      else g = ctx.createLinearGradient(0, 0, W, H);
      b.grad.forEach((c, i) => g.addColorStop(i / (b.grad.length - 1), c));
      ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    } else {
      ctx.fillStyle = b.solid || '#000'; ctx.fillRect(0, 0, W, H);
    }
    if (b.noise) {
      ctx.save(); ctx.globalAlpha = b.noise; ctx.globalCompositeOperation = 'overlay';
      ctx.fillStyle = ctx.createPattern(getNoiseTile(), 'repeat'); ctx.fillRect(0, 0, W, H); ctx.restore();
    }
    if (b.pattern) {
      const s = Math.min(W, H) / 1080;
      ctx.save();
      if (b.pattern === 'dots') {
        ctx.fillStyle = 'rgba(0,0,0,0.12)'; const step = 40 * s;
        for (let y = step / 2; y < H; y += step) for (let x = step / 2; x < W; x += step) { ctx.beginPath(); ctx.arc(x, y, 2.2 * s, 0, Math.PI * 2); ctx.fill(); }
      } else if (b.pattern === 'grid') {
        ctx.strokeStyle = 'rgba(70,110,160,0.18)'; ctx.lineWidth = 1 * s; const step = 48 * s;
        ctx.beginPath();
        for (let x = 0; x < W; x += step) { ctx.moveTo(x, 0); ctx.lineTo(x, H); }
        for (let y = 0; y < H; y += step) { ctx.moveTo(0, y); ctx.lineTo(W, y); }
        ctx.stroke();
      } else if (b.pattern === 'stripes') {
        ctx.fillStyle = 'rgba(200,120,90,0.10)'; const step = 36 * s;
        ctx.translate(W / 2, H / 2); ctx.rotate(-Math.PI / 4);
        const L = Math.max(W, H) * 1.5;
        for (let x = -L; x < L; x += step * 2) ctx.fillRect(x, -L, step, L * 2);
      }
      ctx.restore();
    }
  };

  /* ---------- frames ---------- */
  function rr(ctx, x, y, w, h, r) {
    ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
  }
  RV.FRAMES = [
    { id: 'none', label: '없음', inset: [0, 0, 0, 0] },
    { id: 'thin-white', label: '흰 테두리', inset: [0.025, 0.025, 0.025, 0.025],
      under: (c, W, H) => { c.fillStyle = '#fff'; c.fillRect(0, 0, W, H); } },
    { id: 'thick-white', label: '두꺼운 흰 테두리', inset: [0.07, 0.07, 0.07, 0.07],
      under: (c, W, H) => { c.fillStyle = '#fff'; c.fillRect(0, 0, W, H); } },
    { id: 'polaroid', label: '폴라로이드', inset: [0.06, 0.06, 0.2, 0.06],
      under: (c, W, H, r) => { c.fillStyle = '#fafafa'; c.fillRect(0, 0, W, H); c.save(); c.shadowColor = 'rgba(0,0,0,.35)'; c.shadowBlur = r.s * 20; c.fillStyle = '#e8e8e8'; c.fillRect(r.x, r.y, r.w, r.h); c.restore(); } },
    { id: 'film', label: '필름', inset: [0.11, 0, 0.11, 0],
      under: (c, W, H) => { c.fillStyle = '#0a0a0a'; c.fillRect(0, 0, W, H); },
      over: (c, W, H, r) => {
        c.fillStyle = '#f4f4f4'; const hw = r.s * 26, hh = r.s * 36, gap = r.s * 70, y1 = r.s * 30, y2 = H - r.s * 30 - hh;
        for (let x = gap / 2; x < W; x += gap) { rr(c, x, y1, hw, hh, r.s * 5); c.fill(); rr(c, x, y2, hw, hh, r.s * 5); c.fill(); }
      } },
    { id: 'rounded', label: '둥근 모서리', inset: [0.04, 0.04, 0.04, 0.04], radius: 0.04,
      under: (c, W, H, r) => { c.save(); c.shadowColor = 'rgba(0,0,0,.5)'; c.shadowBlur = r.s * 40; c.fillStyle = '#111'; rr(c, r.x, r.y, r.w, r.h, r.s * 0.04 * Math.min(W, H) / r.s); c.fill(); c.restore(); } },
    { id: 'vignette', label: '비네트', inset: [0, 0, 0, 0],
      over: (c, W, H) => { const g = c.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.35, W / 2, H / 2, Math.max(W, H) * 0.75); g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(1, 'rgba(0,0,0,0.75)'); c.fillStyle = g; c.fillRect(0, 0, W, H); } },
    { id: 'gold', label: '금색 액자', inset: [0.055, 0.055, 0.055, 0.055],
      under: (c, W, H, r) => { const g = c.createLinearGradient(0, 0, W, H); g.addColorStop(0, '#8a6a1c'); g.addColorStop(0.5, '#f1d27a'); g.addColorStop(1, '#8a6a1c'); c.fillStyle = g; c.fillRect(0, 0, W, H); c.strokeStyle = 'rgba(80,50,0,.6)'; c.lineWidth = r.s * 4; c.strokeRect(r.s * 14, r.s * 14, W - r.s * 28, H - r.s * 28); c.strokeRect(r.x - r.s * 6, r.y - r.s * 6, r.w + r.s * 12, r.h + r.s * 12); } },
    { id: 'tape', label: '테이프', inset: [0.08, 0.08, 0.08, 0.08],
      under: (c, W, H, r) => { c.save(); c.shadowColor = 'rgba(0,0,0,.45)'; c.shadowBlur = r.s * 30; c.shadowOffsetY = r.s * 8; c.fillStyle = '#fff'; c.fillRect(r.x - r.s * 12, r.y - r.s * 12, r.w + r.s * 24, r.h + r.s * 24); c.restore(); },
      over: (c, W, H, r) => { c.fillStyle = 'rgba(255,240,200,0.75)'; const tw = r.s * 120, th = r.s * 36;
        [[r.x, r.y, -0.6], [r.x + r.w, r.y, 0.6], [r.x, r.y + r.h, 0.6], [r.x + r.w, r.y + r.h, -0.6]].forEach(([x, y, a]) => { c.save(); c.translate(x, y); c.rotate(a); c.fillRect(-tw / 2, -th / 2, tw, th); c.restore(); }); } },
    { id: 'dark', label: '어두운 테두리', inset: [0.035, 0.035, 0.035, 0.035],
      under: (c, W, H) => { c.fillStyle = '#141414'; c.fillRect(0, 0, W, H); },
      over: (c, W, H, r) => { c.strokeStyle = 'rgba(255,255,255,.25)'; c.lineWidth = r.s * 2; c.strokeRect(r.x, r.y, r.w, r.h); } },
    { id: 'shadow', label: '그림자 카드', inset: [0.06, 0.06, 0.06, 0.06],
      under: (c, W, H, r) => { c.save(); c.shadowColor = 'rgba(0,0,0,.6)'; c.shadowBlur = r.s * 60; c.shadowOffsetY = r.s * 16; c.fillStyle = '#222'; c.fillRect(r.x, r.y, r.w, r.h); c.restore(); } },
  ];
  const FR_BY_ID = {}; RV.FRAMES.forEach((f) => (FR_BY_ID[f.id] = f));
  RV.frameById = (id) => FR_BY_ID[id] || FR_BY_ID.none;
  RV.frameRect = function (frame, W, H) {
    const m = Math.min(W, H); const [t, r, b, l] = frame.inset;
    return { x: l * m, y: t * m, w: W - (l + r) * m, h: H - (t + b) * m, s: m / 1080 };
  };
  RV.frameClip = function (ctx, frame, rect, W, H) {
    if (frame.radius) { rr(ctx, rect.x, rect.y, rect.w, rect.h, frame.radius * Math.min(W, H)); ctx.clip(); }
    else { ctx.beginPath(); ctx.rect(rect.x, rect.y, rect.w, rect.h); ctx.clip(); }
  };

  /* ---------- cinematic overlays ---------- */
  RV.CINEMATICS = [
    { id: 'none', label: '없음' },
    { id: 'bokeh', label: '보케' },
    { id: 'hearts', label: '하트' },
    { id: 'snow', label: '눈' },
    { id: 'stars', label: '별빛' },
    { id: 'petals', label: '꽃잎' },
    { id: 'lightleak', label: '빛샘' },
    { id: 'confetti', label: '색종이' },
  ];

  function makeSprite(kind, size) {
    const c = document.createElement('canvas'); c.width = c.height = size; const x = c.getContext('2d');
    const h = size / 2;
    if (kind === 'bokeh' || kind === 'snow' || kind === 'stars') {
      const g = x.createRadialGradient(h, h, 0, h, h, h);
      if (kind === 'bokeh') { g.addColorStop(0, 'rgba(255,255,255,0.55)'); g.addColorStop(0.75, 'rgba(255,255,255,0.35)'); g.addColorStop(1, 'rgba(255,255,255,0)'); }
      else if (kind === 'snow') { g.addColorStop(0, 'rgba(255,255,255,1)'); g.addColorStop(0.5, 'rgba(255,255,255,0.8)'); g.addColorStop(1, 'rgba(255,255,255,0)'); }
      else { g.addColorStop(0, 'rgba(255,255,230,1)'); g.addColorStop(0.3, 'rgba(255,255,230,0.6)'); g.addColorStop(1, 'rgba(255,255,230,0)'); }
      x.fillStyle = g; x.fillRect(0, 0, size, size);
      if (kind === 'stars') { x.strokeStyle = 'rgba(255,255,240,0.9)'; x.lineWidth = size * 0.04; x.beginPath(); x.moveTo(h, 0); x.lineTo(h, size); x.moveTo(0, h); x.lineTo(size, h); x.stroke(); }
    } else if (kind === 'hearts') {
      x.fillStyle = 'rgba(255,90,130,0.85)'; const s = size * 0.45; x.translate(h, h * 1.1);
      x.beginPath(); x.moveTo(0, s * 0.8); x.bezierCurveTo(-s * 1.2, -s * 0.1, -s * 0.6, -s, 0, -s * 0.4); x.bezierCurveTo(s * 0.6, -s, s * 1.2, -s * 0.1, 0, s * 0.8); x.fill();
    } else if (kind === 'petals') {
      x.fillStyle = 'rgba(255,190,210,0.9)'; x.translate(h, h); x.rotate(0.6); x.beginPath(); x.ellipse(0, 0, size * 0.42, size * 0.24, 0, 0, Math.PI * 2); x.fill();
      x.fillStyle = 'rgba(255,255,255,0.35)'; x.beginPath(); x.ellipse(-size * 0.1, -size * 0.05, size * 0.18, size * 0.08, 0, 0, Math.PI * 2); x.fill();
    } else if (kind === 'confetti') {
      x.fillStyle = '#fff'; x.fillRect(size * 0.2, size * 0.35, size * 0.6, size * 0.3);
    }
    return c;
  }

  const CONFETTI_COLORS = ['#ff595e', '#ffca3a', '#8ac926', '#1982c4', '#6a4c93', '#ff924c'];
  function particles(id, n) {
    const r = RV.rng(RV.hash('cine-' + id)); const out = [];
    for (let i = 0; i < n; i++) out.push({ x: r(), y: r(), sz: 0.4 + r() * 0.6, sp: 0.6 + r() * 0.8, ph: r() * Math.PI * 2, dr: r() * 2 - 1, rot: r() * Math.PI * 2, col: CONFETTI_COLORS[i % CONFETTI_COLORS.length] });
    return out;
  }

  RV.drawCinematic = function (ctx, W, H, id, t, cache) {
    if (!id || id === 'none') return;
    cache.sprites = cache.sprites || {}; cache.parts = cache.parts || {};
    const S = Math.min(W, H);
    if (id === 'lightleak') {
      ctx.save(); ctx.globalCompositeOperation = 'screen';
      const blobs = [[0.15, 0.2, '#ff9a3c'], [0.85, 0.7, '#ff4d7a'], [0.5, 0.95, '#ffd166']];
      blobs.forEach(([bx, by, col], i) => {
        const cx = W * (bx + Math.sin(t * 0.25 + i * 2) * 0.08), cy = H * (by + Math.cos(t * 0.2 + i) * 0.08);
        const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, S * (0.45 + 0.1 * Math.sin(t * 0.5 + i)));
        g.addColorStop(0, col + 'aa'); g.addColorStop(1, col + '00'); ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
      });
      ctx.restore(); return;
    }
    const kind = id;
    const sprite = cache.sprites[kind] || (cache.sprites[kind] = makeSprite(kind, 128));
    const parts = cache.parts[kind] || (cache.parts[kind] = particles(kind, kind === 'confetti' ? 90 : kind === 'snow' ? 110 : 45));
    ctx.save();
    if (kind === 'bokeh' || kind === 'stars') ctx.globalCompositeOperation = 'screen';
    for (const p of parts) {
      let x, y, a = 1, size;
      if (kind === 'bokeh') { size = S * (0.06 + p.sz * 0.16); x = (p.x + Math.sin(t * 0.15 * p.sp + p.ph) * 0.06) * W; y = ((p.y - t * 0.012 * p.sp) % 1 + 1) % 1 * H; a = 0.35 + 0.3 * Math.sin(t * 0.8 + p.ph); }
      else if (kind === 'stars') { size = S * (0.012 + p.sz * 0.02); x = p.x * W; y = p.y * H; a = 0.3 + 0.7 * Math.abs(Math.sin(t * (1 + p.sp) + p.ph)); }
      else if (kind === 'snow') { size = S * (0.008 + p.sz * 0.02); x = (p.x + Math.sin(t * 0.7 * p.sp + p.ph) * 0.03) * W; y = ((p.y + t * 0.06 * p.sp) % 1) * H; a = 0.6 + 0.4 * p.sz; }
      else if (kind === 'hearts') { size = S * (0.03 + p.sz * 0.05); x = (p.x + Math.sin(t * 0.9 * p.sp + p.ph) * 0.04) * W; y = ((p.y - t * 0.05 * p.sp) % 1 + 1) % 1 * H; a = 0.5 + 0.5 * p.sz; }
      else if (kind === 'petals') { size = S * (0.03 + p.sz * 0.04); x = (p.x + t * 0.03 * p.dr + Math.sin(t * p.sp + p.ph) * 0.05) * W; x = ((x / W) % 1 + 1) % 1 * W; y = ((p.y + t * 0.07 * p.sp) % 1) * H; a = 0.85; }
      else { size = S * (0.012 + p.sz * 0.018); x = (p.x + Math.sin(t * 1.3 * p.sp + p.ph) * 0.03) * W; y = ((p.y + t * 0.12 * p.sp) % 1) * H; a = 0.95; }
      ctx.globalAlpha = a;
      ctx.save(); ctx.translate(x, y);
      if (kind === 'petals' || kind === 'confetti') ctx.rotate(p.rot + t * 2 * p.dr);
      if (kind === 'confetti') { ctx.fillStyle = p.col; ctx.fillRect(-size / 2, -size / 4, size, size / 2); }
      else ctx.drawImage(sprite, -size / 2, -size / 2, size, size);
      ctx.restore();
    }
    ctx.restore();
  };

  /* ---------- transitions ---------- */
  RV.TRANSITIONS = [
    { id: 'none', label: '효과없음' },
    { id: 'crossfade', label: '겹치기' },
    { id: 'fadeblack', label: '어두워지기' },
    { id: 'fadewhite', label: '밝아지기' },
    { id: 'slideleft', label: '밀기 ←' },
    { id: 'slideright', label: '밀기 →' },
    { id: 'slideup', label: '밀기 ↑' },
    { id: 'slidedown', label: '밀기 ↓' },
    { id: 'wipe', label: '닦아내기' },
    { id: 'zoom', label: '확대' },
    { id: 'circle', label: '원형' },
    { id: 'blinds', label: '블라인드' },
    { id: 'random', label: '랜덤' },
  ];
  const REAL_TRANSITIONS = RV.TRANSITIONS.map((t) => t.id).filter((id) => id !== 'none' && id !== 'random');
  RV.resolveTransition = function (type, seedStr) {
    if (type !== 'random') return type;
    return REAL_TRANSITIONS[RV.hash('tr-' + seedStr) % REAL_TRANSITIONS.length];
  };

  RV.drawTransition = function (ctx, W, H, A, B, type, p) {
    const e = RV.easeInOut(p);
    ctx.save();
    switch (type) {
      case 'fadeblack': case 'fadewhite': {
        ctx.fillStyle = type === 'fadeblack' ? '#000' : '#fff'; ctx.fillRect(0, 0, W, H);
        if (p < 0.5) { ctx.globalAlpha = 1 - p * 2; ctx.drawImage(A, 0, 0); }
        else { ctx.globalAlpha = (p - 0.5) * 2; ctx.drawImage(B, 0, 0); }
        break;
      }
      case 'slideleft': ctx.drawImage(A, -e * W, 0); ctx.drawImage(B, (1 - e) * W, 0); break;
      case 'slideright': ctx.drawImage(A, e * W, 0); ctx.drawImage(B, (e - 1) * W, 0); break;
      case 'slideup': ctx.drawImage(A, 0, -e * H); ctx.drawImage(B, 0, (1 - e) * H); break;
      case 'slidedown': ctx.drawImage(A, 0, e * H); ctx.drawImage(B, 0, (e - 1) * H); break;
      case 'wipe': ctx.drawImage(A, 0, 0); ctx.beginPath(); ctx.rect(0, 0, e * W, H); ctx.clip(); ctx.drawImage(B, 0, 0); break;
      case 'zoom': {
        ctx.drawImage(A, 0, 0);
        ctx.save(); ctx.translate(W / 2, H / 2); ctx.scale(1 + 0.25 * e, 1 + 0.25 * e); ctx.globalAlpha = 1 - e; ctx.drawImage(A, -W / 2, -H / 2); ctx.restore();
        ctx.save(); ctx.translate(W / 2, H / 2); const z = 0.85 + 0.15 * e; ctx.scale(z, z); ctx.globalAlpha = e; ctx.drawImage(B, -W / 2, -H / 2); ctx.restore();
        break;
      }
      case 'circle': {
        ctx.drawImage(A, 0, 0); const R = Math.hypot(W, H) / 2 * e;
        ctx.beginPath(); ctx.arc(W / 2, H / 2, R, 0, Math.PI * 2); ctx.clip(); ctx.drawImage(B, 0, 0); break;
      }
      case 'blinds': {
        ctx.drawImage(A, 0, 0); const n = 10, bh = H / n; ctx.beginPath();
        for (let i = 0; i < n; i++) ctx.rect(0, i * bh, W, bh * e);
        ctx.clip(); ctx.drawImage(B, 0, 0); break;
      }
      case 'none': ctx.drawImage(B, 0, 0); break;
      default: /* crossfade */
        ctx.drawImage(A, 0, 0); ctx.globalAlpha = e; ctx.drawImage(B, 0, 0);
    }
    ctx.restore();
  };

  RV.TITLE_STYLES = [
    { id: 'classic', label: '클래식' },
    { id: 'cinematic', label: '시네마틱' },
    { id: 'minimal', label: '미니멀' },
  ];
  RV.CAPTION_EFFECTS = [
    { id: 'none', label: '효과없음' },
    { id: 'fade', label: '페이드' },
    { id: 'rise', label: '떠오르기' },
    { id: 'typewriter', label: '타자기' },
    { id: 'zoom', label: '확대' },
  ];
})(typeof window !== 'undefined' ? window : globalThis);
