/* RuninqVic - timeline computation (pure functions, no DOM) */
(function (root) {
  const RV = (root.RV = root.RV || {});
  const MIN_DUR = 0.5;

  function buildSequence(project) {
    const seq = [];
    if (project.opening && project.opening.enabled) {
      seq.push({ id: '__opening', type: 'title', role: 'opening', duration: project.opening.duration || 3, transition: null, src: project.opening });
    }
    for (const s of project.slides) seq.push(s);
    if (project.ending && project.ending.enabled) {
      seq.push({ id: '__ending', type: 'title', role: 'ending', duration: project.ending.duration || 3, transition: null, src: project.ending });
    }
    return seq;
  }

  function slideDuration(project, s) {
    const d = (s.duration != null && s.duration > 0) ? s.duration : project.defaultDuration;
    return Math.max(MIN_DUR, +d || 3);
  }

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
    if (project.beatSync && opts.beats && opts.beats.length > 2 && musicLen > 1) {
      durations = beatDurations(seq.length, musicLen, opts.beats, trs);
      trs = computeTransitions(project, seq, durations);
      durations = beatDurations(seq.length, musicLen, opts.beats, trs);
      trs = computeTransitions(project, seq, durations);
    } else if (project.fitToMusic && musicLen > 1) {
      for (let iter = 0; iter < 3; iter++) {
        const sumD = durations.reduce((a, b) => a + b, 0);
        const sumT = trs.reduce((a, b) => a + b, 0);
        const k = (musicLen + sumT) / sumD;
        durations = durations.map((d) => Math.max(MIN_DUR, d * k));
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
  function beatDurations(n, L, beats, trs) {
    const MIN_GAP = 0.7;
    const bounds = [0];
    const sorted = beats.filter((b) => b > 0 && b < L).sort((a, b) => a - b);
    let prev = 0;
    for (let i = 1; i < n; i++) {
      const ideal = (i * L) / n;
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
      out.push(Math.max(MIN_DUR, visible + trIn));
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
})(typeof window !== 'undefined' ? window : globalThis);
