/* RuninqVic - export via WebCodecs (H.264/AAC -> MP4, fallback VP9/Opus -> WebM) */
(function (root) {
  const RV = (root.RV = root.RV || {});
  const SR = 48000;

  function avcLevel(w, h, fps) {
    const px = w * h;
    if (px <= 1280 * 720) return fps > 30 ? '20' : '1f';
    if (px <= 1920 * 1080) return fps > 30 ? '2a' : '28';
    if (px <= 2560 * 1440) return '32';
    return fps > 30 ? '34' : '33';
  }

  async function pickVideo(w, h, fps, bitrate) {
    if (typeof VideoEncoder === 'undefined') return null;
    const lv = avcLevel(w, h, fps);
    const cands = ['avc1.6400' + lv, 'avc1.4d00' + lv, 'avc1.42e0' + lv, 'avc1.640033'];
    for (const hw of ['prefer-hardware', 'no-preference']) {
      for (const codec of cands) {
        const cfg = { codec, width: w, height: h, framerate: fps, bitrate, avc: { format: 'avc' }, hardwareAcceleration: hw, latencyMode: 'quality' };
        try { const r = await VideoEncoder.isConfigSupported(cfg); if (r.supported) return { cfg, container: 'mp4', name: 'H.264' }; } catch (e) { /* next */ }
      }
    }
    for (const codec of ['vp09.00.10.08', 'vp8']) {
      const cfg = { codec, width: w, height: h, framerate: fps, bitrate, latencyMode: 'quality' };
      try { const r = await VideoEncoder.isConfigSupported(cfg); if (r.supported) return { cfg, container: 'webm', name: codec.startsWith('vp09') ? 'VP9' : 'VP8' }; } catch (e) { /* next */ }
    }
    return null;
  }

  async function pickAudio(container) {
    if (typeof AudioEncoder === 'undefined') return null;
    const cands = container === 'mp4' ? ['mp4a.40.2', 'opus'] : ['opus'];
    for (const codec of cands) {
      const cfg = { codec, sampleRate: SR, numberOfChannels: 2, bitrate: 192000 };
      try { const r = await AudioEncoder.isConfigSupported(cfg); if (r.supported) return { cfg, name: codec === 'opus' ? 'Opus' : 'AAC' }; } catch (e) { /* next */ }
    }
    return null;
  }

  RV.exportCapabilities = async function () {
    const v = await pickVideo(1920, 1080, 30, 12e6);
    if (!v) return { ok: false, reason: 'WebCodecs 비디오 인코더를 사용할 수 없습니다. 최신 Edge 또는 Chrome에서 실행해 주세요.' };
    const a = await pickAudio(v.container);
    return { ok: true, video: v.name, audio: a ? a.name : null, container: v.container };
  };

  RV.suggestBitrate = function (w, h, fps, quality) {
    const base = { low: 0.045, medium: 0.08, high: 0.14 }[quality] || 0.1; /* bits per pixel per frame */
    return Math.round(w * h * fps * base);
  };

  /*
   * opts: { width, height, fps, bitrate, fileHandle?, onProgress(frac, info), signal, assets, previewCanvas? }
   * returns { blob?, written?, ext, mime, video, audio }
   */
  /* Export works on private <video> clones so it never fights the preview over seeks. */
  async function cloneVideoAssets(assets) {
    const images = new Map(); const clones = [];
    for (const [id, a] of assets.images) {
      if (!a.video || !a.url) { images.set(id, a); continue; }
      const v = document.createElement('video'); v.muted = true; v.preload = 'auto'; v.playsInline = true; v.src = a.url;
      await new Promise((res) => { v.onloadedmetadata = () => res(); v.onerror = () => res(); setTimeout(res, 15000); });
      clones.push(v);
      images.set(id, Object.assign({}, a, { bitmap: v, video: v }));
    }
    return { assets: { images, audio: assets.audio }, dispose: () => clones.forEach((v) => { try { v.pause(); v.removeAttribute('src'); v.load(); } catch (e) { /* ignore */ } }) };
  }

  RV.exportVideo = async function (project, tl, opts) {
    const { width: W, height: H, fps } = opts;
    const cloned = await cloneVideoAssets(opts.assets);
    try { return await exportWith(project, tl, Object.assign({}, opts, { assets: cloned.assets })); }
    finally { cloned.dispose(); }
  };

  async function exportWith(project, tl, opts) {
    const { width: W, height: H, fps } = opts;
    const bitrate = opts.bitrate || RV.suggestBitrate(W, H, fps, project.export.quality);
    const v = await pickVideo(W, H, fps, bitrate);
    if (!v) throw new Error('이 브라우저에서는 비디오 인코딩을 지원하지 않습니다.');
    const a = await pickAudio(v.container);
    const mixed = await RV.audio.buildMix(project, opts.assets, tl.total, tl);
    const useAudio = !!(a && mixed);
    const isMp4 = v.container === 'mp4';
    const ext = isMp4 ? 'mp4' : 'webm', mime = isMp4 ? 'video/mp4' : 'video/webm';

    /* muxer & target */
    const M = isMp4 ? Mp4Muxer : WebMMuxer;
    let writable = null, target;
    if (opts.fileHandle) { writable = await opts.fileHandle.createWritable(); target = new M.FileSystemWritableFileStreamTarget(writable); }
    else target = new M.ArrayBufferTarget();
    const muxOpts = {
      target,
      video: isMp4 ? { codec: 'avc', width: W, height: H, frameRate: fps } : { codec: v.cfg.codec.startsWith('vp09') ? 'V_VP9' : 'V_VP8', width: W, height: H, frameRate: fps },
      firstTimestampBehavior: 'offset',
    };
    if (useAudio) muxOpts.audio = isMp4 ? { codec: a.cfg.codec === 'opus' ? 'opus' : 'aac', numberOfChannels: 2, sampleRate: SR } : { codec: 'A_OPUS', numberOfChannels: 2, sampleRate: SR };
    if (isMp4) muxOpts.fastStart = writable ? false : 'in-memory';
    const muxer = new M.Muxer(muxOpts);

    let encError = null;
    const signal = opts.signal;
    const checkAbort = () => { if (signal && signal.aborted) throw new DOMException('취소됨', 'AbortError'); if (encError) throw encError; };

    try {
      /* ---- audio ---- */
      if (useAudio) {
        const aenc = new AudioEncoder({ output: (chunk, meta) => muxer.addAudioChunk(chunk, meta), error: (e) => (encError = e) });
        aenc.configure(a.cfg);
        const L = mixed.getChannelData(0), R = mixed.getChannelData(1), n = mixed.length, CH = 4096;
        for (let i = 0; i < n; i += CH) {
          const len = Math.min(CH, n - i);
          const data = new Float32Array(len * 2);
          data.set(L.subarray(i, i + len), 0); data.set(R.subarray(i, i + len), len);
          const ad = new AudioData({ format: 'f32-planar', sampleRate: SR, numberOfFrames: len, numberOfChannels: 2, timestamp: Math.round(i / SR * 1e6), data });
          aenc.encode(ad); ad.close();
          if (aenc.encodeQueueSize > 16) await new Promise((r) => setTimeout(r, 0));
          checkAbort();
        }
        await aenc.flush(); aenc.close();
      }

      /* ---- video ---- */
      const venc = new VideoEncoder({ output: (chunk, meta) => muxer.addVideoChunk(chunk, meta), error: (e) => (encError = e) });
      venc.configure(v.cfg);
      const renderer = new RV.Renderer(W, H);
      const nFrames = Math.max(1, Math.ceil(tl.total * fps));
      const t0 = performance.now();
      const gop = fps * 2;
      for (let i = 0; i < nFrames; i++) {
        checkAbort();
        const t = i / fps;
        await renderer.prepare(project, tl, t, opts.assets, 'export');
        renderer.draw(project, tl, t, opts.assets);
        const frame = new VideoFrame(renderer.canvas, { timestamp: Math.round(i * 1e6 / fps), duration: Math.round(1e6 / fps) });
        venc.encode(frame, { keyFrame: i % gop === 0 });
        frame.close();
        while (venc.encodeQueueSize > 4) { await new Promise((r) => setTimeout(r, 2)); checkAbort(); }
        if (i % 5 === 0) {
          const el = (performance.now() - t0) / 1000, frac = (i + 1) / nFrames;
          if (opts.onProgress) opts.onProgress(frac, { frame: i + 1, frames: nFrames, elapsed: el, eta: el / frac - el, fps: (i + 1) / el, video: v.name, audio: useAudio ? a.name : null });
          if (opts.previewCanvas && i % 10 === 0) { const pc = opts.previewCanvas; pc.getContext('2d').drawImage(renderer.canvas, 0, 0, pc.width, pc.height); }
          await new Promise((r) => setTimeout(r, 0));
        }
      }
      await venc.flush(); venc.close();
      checkAbort();
      muxer.finalize();
      if (writable) { await writable.close(); return { written: true, ext, mime, video: v.name, audio: useAudio ? a.name : null }; }
      const blob = new Blob([target.buffer], { type: mime });
      return { blob, ext, mime, video: v.name, audio: useAudio ? a.name : null };
    } catch (e) {
      if (writable) { try { await writable.abort(); } catch (e2) { /* ignore */ } }
      throw e;
    }
  };
})(typeof window !== 'undefined' ? window : globalThis);
