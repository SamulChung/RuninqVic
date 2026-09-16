/* RuninqVic - audio: decode, offline mix (sequence/loop/fades), beat detection, preview playback */
(function (root) {
  const RV = (root.RV = root.RV || {});
  const SR = 48000;

  const audio = {
    _ctx: null,
    get ctx() {
      if (!this._ctx) this._ctx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: SR });
      return this._ctx;
    },

    async decode(file) {
      const buf = await file.arrayBuffer();
      return await this.ctx.decodeAudioData(buf);
    },

    /* total playable music length after trim (one pass, no loop) */
    musicLength(project, assets) {
      let total = 0;
      for (const tr of project.music.tracks) {
        const a = assets.audio.get(tr.assetId);
        if (a && a.buffer) total += a.buffer.duration;
      }
      return Math.max(0, total - (project.music.trimStart || 0));
    },

    /* build the final mixed stereo buffer for [0, duration]: music tracks + video clip audio (with ducking) */
    async buildMix(project, assets, duration, tl) {
      const m = project.music;
      const tracks = m.tracks.map((t) => ({ t, a: assets.audio.get(t.assetId) })).filter((x) => x.a && x.a.buffer);
      const vids = ((tl && tl.items) || []).filter((it) => it.slide.type === 'video' && !it.slide.muted && (it.slide.volume == null || it.slide.volume > 0))
        .map((it) => ({ it, a: assets.images.get(it.slide.assetId) })).filter((x) => x.a && x.a.audioBuffer);
      if ((!tracks.length && !vids.length) || duration <= 0) return null;
      const frames = Math.ceil(duration * SR);
      const off = new OfflineAudioContext(2, frames, SR);
      const duck = off.createGain(); duck.connect(off.destination);
      const master = off.createGain();
      master.connect(duck);
      const vol = m.volume == null ? 1 : m.volume;

      /* video clip audio (bypasses music fades/ducking) */
      for (const { it, a } of vids) {
        const src = off.createBufferSource(); src.buffer = a.audioBuffer;
        const g = off.createGain(); g.gain.value = it.slide.volume == null ? 1 : it.slide.volume;
        src.connect(g); g.connect(off.destination);
        const inPt = Math.max(0, +it.slide.in || 0);
        const len = Math.max(0, Math.min(it.duration, a.audioBuffer.duration - inPt));
        if (len > 0) src.start(it.start, inPt, len);
      }
      /* duck music while video sound plays */
      if (vids.length && m.duckVideo !== false && tracks.length) {
        const lvl = m.duckLevel == null ? 0.25 : m.duckLevel, R = 0.4;
        const ivs = vids.map(({ it }) => [it.start, it.end]).sort((p, q) => p[0] - q[0]);
        const merged = [];
        for (const iv of ivs) { const last = merged[merged.length - 1]; if (last && iv[0] <= last[1] + R) last[1] = Math.max(last[1], iv[1]); else merged.push(iv.slice()); }
        duck.gain.setValueAtTime(1, 0);
        for (const [s, e] of merged) {
          const s0 = Math.max(0, s), e0 = Math.min(duration, e);
          duck.gain.setValueAtTime(1, s0); duck.gain.linearRampToValueAtTime(lvl, Math.min(e0, s0 + R));
          duck.gain.setValueAtTime(lvl, Math.max(s0 + R, e0 - R)); duck.gain.linearRampToValueAtTime(1, e0);
        }
      }
      if (!tracks.length) return await off.startRendering();

      /* schedule sequence */
      let pos = 0, offset = m.trimStart || 0, pass = 0, musicEnd = 0;
      outer: while (pos < duration) {
        for (const { t, a } of tracks) {
          const len = a.buffer.duration;
          if (offset >= len) { offset -= len; continue; }
          const play = Math.min(len - offset, duration - pos);
          if (play <= 0) break outer;
          const src = off.createBufferSource(); src.buffer = a.buffer;
          const g = off.createGain(); g.gain.value = t.volume == null ? 1 : t.volume;
          src.connect(g); g.connect(master);
          src.start(pos, offset, play);
          pos += play; offset = 0; musicEnd = pos;
          if (pos >= duration) break outer;
        }
        pass++;
        if (!m.loop || pass > 200) break;
      }
      const end = Math.min(duration, musicEnd);
      const fi = Math.min(m.fadeIn || 0, end / 2), fo = Math.min(m.fadeOut || 0, end / 2);
      master.gain.setValueAtTime(fi > 0 ? 0 : vol, 0);
      if (fi > 0) master.gain.linearRampToValueAtTime(vol, fi);
      if (fo > 0) { master.gain.setValueAtTime(vol, Math.max(fi, end - fo)); master.gain.linearRampToValueAtTime(0, end); }
      return await off.startRendering();
    },

    /* energy-based onset detection -> beat times (seconds) */
    detectBeats(buffer) {
      const sr = buffer.sampleRate, hop = 512;
      const ch = buffer.numberOfChannels, n = buffer.length;
      const data = [];
      for (let c = 0; c < ch; c++) data.push(buffer.getChannelData(c));
      const frames = Math.floor(n / hop);
      const energy = new Float32Array(frames);
      for (let f = 0; f < frames; f++) {
        let e = 0; const s0 = f * hop;
        for (let i = s0; i < s0 + hop; i++) { let v = 0; for (let c = 0; c < ch; c++) v += data[c][i]; v /= ch; e += v * v; }
        energy[f] = Math.log1p(e * 1000 / hop);
      }
      const flux = new Float32Array(frames);
      for (let f = 1; f < frames; f++) flux[f] = Math.max(0, energy[f] - energy[f - 1]);
      /* smooth */
      const sm = new Float32Array(frames);
      for (let f = 0; f < frames; f++) sm[f] = (flux[Math.max(0, f - 1)] + flux[f] + flux[Math.min(frames - 1, f + 1)]) / 3;
      const win = Math.round(0.5 * sr / hop), minDist = Math.round(0.25 * sr / hop);
      const beats = []; let last = -minDist;
      for (let f = 2; f < frames - 2; f++) {
        if (sm[f] <= sm[f - 1] || sm[f] < sm[f + 1]) continue;
        let mean = 0, cnt = 0;
        for (let k = Math.max(0, f - win); k < Math.min(frames, f + win); k++) { mean += sm[k]; cnt++; }
        mean /= cnt;
        if (sm[f] > mean * 1.6 + 0.02 && f - last >= minDist) { beats.push(f * hop / sr); last = f; }
      }
      return beats;
    },

    /* ---- preview playback of a mixed buffer ---- */
    _src: null,
    play(buffer, offset) {
      this.stop();
      if (!buffer) return;
      const ctx = this.ctx;
      if (ctx.state === 'suspended') ctx.resume();
      const src = ctx.createBufferSource(); src.buffer = buffer; src.connect(ctx.destination);
      src.start(0, Math.max(0, Math.min(offset || 0, buffer.duration - 0.01)));
      this._src = src;
    },
    stop() { if (this._src) { try { this._src.stop(); } catch (e) { /* ignore */ } this._src.disconnect(); this._src = null; } },

    /* short test tone for demos/tests: returns AudioBuffer */
    makeTone(seconds, bpm) {
      const ctx = this.ctx; const n = Math.floor(seconds * SR); const b = ctx.createBuffer(2, n, SR);
      const beat = 60 / (bpm || 120);
      for (let c = 0; c < 2; c++) {
        const d = b.getChannelData(c);
        for (let i = 0; i < n; i++) {
          const t = i / SR; const ph = (t % beat) / beat;
          const env = Math.exp(-ph * 12);
          d[i] = 0.35 * env * Math.sin(2 * Math.PI * 110 * t) + 0.1 * Math.sin(2 * Math.PI * (c ? 440 : 330) * t) * (0.5 + 0.5 * Math.sin(t * 0.7));
        }
      }
      return b;
    },
  };
  RV.audio = audio;
})(typeof window !== 'undefined' ? window : globalThis);
