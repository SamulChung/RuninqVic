/* RuninqVic - project model & defaults */
(function (root) {
  const RV = (root.RV = root.RV || {});

  RV.VERSION = '1.6.2';

  RV.ASPECTS = {
    '16:9': { w: 16, h: 9, label: '와이드 (16:9)' },
    '4:3':  { w: 4,  h: 3, label: '기본 (4:3)' },
    '1:1':  { w: 1,  h: 1, label: '정사각 (1:1)' },
    '9:16': { w: 9,  h: 16, label: '세로 (9:16) 쇼츠·릴스' },
  };

  RV.RESOLUTIONS = {
    '720p':  { short: 720,  label: 'HD 720p' },
    '1080p': { short: 1080, label: 'Full HD 1080p (추천)' },
    '1440p': { short: 1440, label: 'QHD 1440p' },
    '2160p': { short: 2160, label: '4K UHD 2160p' },
  };

  RV.FONTS = ['맑은 고딕', '나눔고딕', '나눔명조', '바탕', '궁서', '굴림', '돋움', 'Segoe UI', 'Arial', 'Georgia', 'Impact', 'Times New Roman', 'Verdana'];

  let _seq = 0;
  RV.uid = function (prefix) {
    _seq += 1;
    return (prefix || 'id') + '_' + Date.now().toString(36) + '_' + _seq.toString(36) + Math.random().toString(36).slice(2, 6);
  };

  /* deterministic PRNG (mulberry32) */
  RV.rng = function (seed) {
    let a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  };
  RV.hash = function (str) {
    let h = 2166136261 >>> 0;
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  };

  RV.defaultCaption = function () {
    return {
      text: '', font: '맑은 고딕', size: 48, color: '#ffffff',
      bold: true, italic: false, shadow: true, outline: false, box: false,
      pos: 'bc', /* tl tc tr ml mc mr bl bc br */
      effect: 'fade', /* none fade rise typewriter zoom */
    };
  };

  /* Ken Burns params: deterministic per slide id */
  RV.makeKenBurns = function (seedStr) {
    const r = RV.rng(RV.hash(seedStr));
    const zoomIn = r() > 0.5;
    const z0 = zoomIn ? 1.0 : 1.12 + r() * 0.08;
    const z1 = zoomIn ? 1.12 + r() * 0.08 : 1.0;
    const ang = r() * Math.PI * 2;
    const mag = 0.5 + r() * 0.5;
    return { z0, z1, x0: -Math.cos(ang) * mag, y0: -Math.sin(ang) * mag, x1: Math.cos(ang) * mag, y1: Math.sin(ang) * mag };
  };

  RV.createSlide = function (opts) {
    const id = RV.uid('s');
    return Object.assign({
      id, type: 'photo', /* photo | text | video */
      name: '', assetId: null, width: 0, height: 0,
      duration: null, /* null => project default (photo/text only) */
      /* video only */
      srcDuration: 0, in: 0, out: 0, volume: 1, muted: false,
      rotation: 0,
      transition: null, /* null => project default */
      bgStyle: null, frame: null, cinematic: null,
      caption: RV.defaultCaption(),
      kb: RV.makeKenBurns(id),
    }, opts || {});
  };

  RV.createProject = function () {
    const today = new Date();
    const dateStr = today.getFullYear() + '.' + String(today.getMonth() + 1).padStart(2, '0') + '.' + String(today.getDate()).padStart(2, '0');
    return {
      version: 1,
      app: 'RuninqVic',
      name: '내 영상',
      aspect: '16:9',
      fit: 'fit',            /* fit | fill | original */
      blurFill: true,        /* 여백에 사진넣기 */
      blurAmount: 40, blurDarken: 0.35,
      bgColor: '#000000',
      bgStyle: 'none',
      frame: 'none',
      kenBurns: true, kbIntensity: 1.0,
      defaultDuration: 3,
      transition: 'crossfade', transitionDuration: 0.8,
      cinematic: 'none',
      fitToMusic: false, beatSync: false,
      slides: [],
      opening: { enabled: true, title: dateStr, subtitle: '', duration: 3, style: 'classic' },
      ending: { enabled: true, title: 'RuninqVic', subtitle: '', duration: 3, style: 'classic' },
      music: { tracks: [], volume: 1, fadeIn: 1.5, fadeOut: 3, loop: true, trimStart: 0, duckVideo: true, duckLevel: 0.25 },
      captionDefaults: RV.defaultCaption(),
      export: { res: '1080p', fps: 30, quality: 'high', bitrate: 0, name: '' },
    };
  };

  RV.canvasSize = function (aspect, shortSide) {
    const a = RV.ASPECTS[aspect] || RV.ASPECTS['16:9'];
    const s = shortSide;
    let w, h;
    if (a.w >= a.h) { h = s; w = Math.round(s * a.w / a.h); }
    else { w = s; h = Math.round(s * a.h / a.w); }
    w -= w % 2; h -= h % 2;
    return { w, h };
  };

  RV.fmtTime = function (sec, withMs) {
    sec = Math.max(0, sec || 0);
    const m = Math.floor(sec / 60), s = Math.floor(sec % 60);
    const base = String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
    if (!withMs) return base;
    return base + '.' + String(Math.floor((sec % 1) * 10));
  };
  RV.clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  RV.lerp = (a, b, t) => a + (b - a) * t;
  RV.easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
  RV.easeOut = (t) => 1 - Math.pow(1 - t, 3);
})(typeof window !== 'undefined' ? window : globalThis);
