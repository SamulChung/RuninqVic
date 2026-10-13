/* RuninqVic - timeline computation (pure functions, no DOM) */
(function (root) {
  const RV = (root.RV = root.RV || {});
  const MIN_DUR = 0.5;

  function buildSequence(project) {
    const seq = [];
    const title = (role) => {
      const src = project[role];
      const media = src.media && src.media.assetId ? src.media : null;
      return { id: '__' + role, type: 'title', role, duration: src.duration || 3, transition: null, src, media };
    };
    if (project.opening && project.opening.enabled) seq.push(title('opening'));
    for (const s of project.slides) seq.push(s);
    if (project.ending && project.ending.enabled) seq.push(title('ending'));
    return seq;
  }
  /* the video that plays for a timeline entry: a video slide itself, or the video attached to an opening/ending card */
  function videoOf(s) {
    if (!s) return null;
    if (s.type === 'video') return s;
    if (s.type === 'title' && s.media && s.media.type === 'video') return s.media;
    return null;
  }

  function slideDuration(project, s) {
    const v = videoOf(s);
    if (v) return Math.max(MIN_DUR, videoClipLength(v));
    const d = (s.duration != null && s.duration > 0) ? s.duration : project.defaultDuration;
    return Math.max(MIN_DUR, +d || 3);
  }
  /* video clip length from in/out points (out 0 => source end) */
  function videoClipLength(s) {
    const src = +s.srcDuration || 0;
    const a = Math.max(0, +s.in || 0);
    const b = (s.out && s.out > a) ? Math.min(s.out, src || s.out) : src;
    return Math.max(0, b - a);
  }
  /* durations that must not be rescaled by fit-to-music / beat sync */
  function isFixed(s) { return !!videoOf(s); }

  function transitionOf(project, s) {
    const t = s.transition != null ? s.transition : project.transition;
    return t || 'none';
  }

  /* durations: seconds per seq item; trs: transition length into item i (0 for first) */
  function layout(seq, durations, trs) {
    const items = [];
    let start = 0;
    for (let i = 0; i < seq.length; i++) {
      const d = durations[i];
      const trIn = i === 0 ? 0 : trs[i];
      if (i > 0) start -= trIn;
      items.push({ slide: seq[i], index: i, start, end: start + d, duration: d, trIn });
      start += d;
    }
    const total = items.length ? items[items.length - 1].end : 0;
    return { items, total };
  }

  function computeTransitions(project, seq, durations) {
    const trs = [0];
    for (let i = 1; i < seq.length; i++) {
      const type = transitionOf(project, seq[i]);
      let tr = type === 'none' ? 0 : (project.transitionDuration || 0);
      tr = Math.min(tr, 0.5 * Math.min(durations[i - 1], durations[i]));
      trs.push(Math.max(0, tr));
    }
    return trs;
  }

  /*
   * compute(project, opts) -> { items, total, seq, byId }
   * opts.musicLength: total music seconds (for fitToMusic)
   * opts.beats: array of beat times (for beatSync)
   */
  RV.computeTimeline = function (project, opts) {
    opts = opts || {};
    const seq = buildSequence(project);
    if (!seq.length) return { items: [], total: 0, seq, byId: {} };
    let durations = seq.map((s) => slideDuration(project, s));
    let trs = computeTransitions(project, seq, durations);

    const musicLen = opts.musicLength || 0;
    const fixed = seq.map((s) => (isFixed(s) ? slideDuration(project, s) : null));
    const anyFree = fixed.some((f) => f == null);
    if (project.beatSync && anyFree && opts.beats && opts.beats.length > 2 && musicLen > 1) {
      durations = beatDurations(seq.length, musicLen, opts.beats, trs, fixed);
      trs = computeTransitions(project, seq, durations);
      durations = beatDurations(seq.length, musicLen, opts.beats, trs, fixed);
      trs = computeTransitions(project, seq, durations);
    } else if (project.fitToMusic && anyFree && musicLen > 1) {
      for (let iter = 0; iter < 3; iter++) {
        const sumT = trs.reduce((a, b) => a + b, 0);
        let sumFree = 0, sumFixed = 0;
        durations.forEach((d, i) => { if (fixed[i] == null) sumFree += d; else sumFixed += fixed[i]; });
        const target = musicLen + sumT - sumFixed;
        if (target <= 0 || sumFree <= 0) break;
        const k = target / sumFree;
        durations = durations.map((d, i) => (fixed[i] == null ? Math.max(MIN_DUR, d * k) : fixed[i]));
        trs = computeTransitions(project, seq, durations);
      }
    }
    const res = layout(seq, durations, trs);
    res.seq = seq;
    res.byId = {};
    for (const it of res.items) res.byId[it.slide.id] = it;
    return res;
  };

  /* snap N slide boundaries to beats within [0, L] */
  function beatDurations(n, L, beats, trs, fixed) {
    const MIN_GAP = 0.7;
    const bounds = [0];
    const sorted = beats.filter((b) => b > 0 && b < L).sort((a, b) => a - b);
    let prev = 0;
    /* free items share the time left after fixed clips, in proportion to their position */
    const fixedTotal = fixed ? fixed.reduce((a, f) => a + (f || 0), 0) : 0;
    const freeCount = fixed ? fixed.filter((f) => f == null).length : n;
    const freeSlot = Math.max(MIN_DUR, (L - fixedTotal) / Math.max(1, freeCount));
    for (let i = 1; i < n; i++) {
      const prevFixed = fixed && fixed[i - 1] != null;
      if (prevFixed) { const b = prev + fixed[i - 1] - (i - 1 > 0 ? trs[i - 1] : 0); bounds.push(Math.min(L, b)); prev = bounds[bounds.length - 1]; continue; }
      const ideal = prev + freeSlot;
      let best = ideal, bestDist = Infinity;
      for (const b of sorted) {
        if (b <= prev + MIN_GAP) continue;
        const d = Math.abs(b - ideal);
        if (d < bestDist) { bestDist = d; best = b; }
      }
      if (best <= prev + MIN_GAP) best = prev + MIN_GAP;
      bounds.push(best);
      prev = best;
    }
    bounds.push(L);
    const out = [];
    for (let i = 0; i < n; i++) {
      const visible = bounds[i + 1] - bounds[i];
      const trIn = i === 0 ? 0 : trs[i];
      out.push(fixed && fixed[i] != null ? fixed[i] : Math.max(MIN_DUR, visible + trIn));   /* a clip keeps its length, also as the last item */
    }
    return out;
  }

  /* what's on screen at time t: { b: item, a: prevItem|null, p: transitionProgress, ua, ub } */
  RV.locate = function (tl, t) {
    const items = tl.items;
    if (!items.length) return null;
    t = Math.max(0, Math.min(tl.total, t));
    let bi = 0;
    for (let i = 0; i < items.length; i++) { if (items[i].start <= t) bi = i; else break; }
    const b = items[bi];
    const ub = clamp01((t - b.start) / b.duration);
    if (bi > 0 && b.trIn > 0 && t < b.start + b.trIn) {
      const a = items[bi - 1];
      const p = clamp01((t - b.start) / b.trIn);
      const ua = clamp01((t - a.start) / a.duration);
      return { b, a, p, ua, ub };
    }
    return { b, a: null, p: 1, ua: 0, ub };
  };

  function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }

  RV.transitionOf = transitionOf;
  RV.slideDuration = slideDuration;
  RV.videoClipLength = videoClipLength;
  RV.videoOf = videoOf;
  /* when the words of an opening/ending card are on screen: the whole card, or on a long video card
     the first (opening) / last (ending) N seconds, N = the title length setting. Returns [from, to] in card seconds. */
  RV.titleTextWindow = function (s, dur) {
    const tDur = Math.max(1, +(s.src && s.src.duration) || 3);
    if (s.media && s.media.type === 'video' && dur > tDur + 0.5) return s.role === 'ending' ? [dur - tDur, dur] : [0, tDur];
    return [0, dur];
  };
})(typeof window !== 'undefined' ? window : globalThis);
