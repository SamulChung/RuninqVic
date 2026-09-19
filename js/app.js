/* RuninqVic - application UI */
(function () {
  const RV = window.RV;
  const $ = (s, el) => (el || document).querySelector(s);
  const $$ = (s, el) => Array.from((el || document).querySelectorAll(s));

  const S = {
    project: null,
    assets: { images: new Map(), audio: new Map() },
    tl: { items: [], total: 0, seq: [], byId: {} },
    selectedId: null,
    selectedTrack: null,
    time: 0,
    playing: false,
    mix: null, mixDirty: true, mixBuilding: null,
    beats: [],
    renderer: null,
    raf: 0, playStartCtx: 0, playStartT: 0, playPerf: 0,
    saveTimer: 0,
    restoring: false,
  };
  const MAX_EDGE = 4096;

  /* ---------------- helpers ---------------- */
  function toast(msg, isErr) {
    const box = $('#toast'); const d = document.createElement('div'); d.textContent = msg; if (isErr) d.className = 'err';
    box.appendChild(d); setTimeout(() => d.remove(), isErr ? 5000 : 2600);
  }
  function selectedSlide() { return S.project.slides.find((s) => s.id === S.selectedId) || null; }
  function selectedIndex() { return S.project.slides.findIndex((s) => s.id === S.selectedId); }
  function fillSelect(sel, items, val) {
    sel.innerHTML = '';
    items.forEach((it) => { const o = document.createElement('option'); o.value = it.value; o.textContent = it.label; sel.appendChild(o); });
    if (val != null) sel.value = val;
  }

  /* ---------------- project lifecycle ---------------- */
  async function setProject(p, opts) {
    S.project = p; S.selectedId = null; S.time = 0; stopPlayback();
    S.mixDirty = true; S.mix = null; S.beats = [];
    for (const id of Array.from(S.assets.images.keys())) releaseAsset(id);
    S.assets.audio.clear();
    if (S.renderer) S.renderer.invalidate();
    S.restoring = true;
    /* load assets from IDB */
    for (const s of p.slides) {
      if (!s.assetId || S.assets.images.has(s.assetId)) continue;
      const rec = await RV.store.getAsset(s.assetId).catch(() => null);
      if (rec && rec.blob) {
        try { S.assets.images.set(s.assetId, (rec.kind === 'video' || s.type === 'video') ? await makeVideoAsset(rec.blob) : await makeImageAsset(rec.blob)); }
        catch (e) { console.warn(e); }
      }
    }
    for (const t of p.music.tracks) {
      if (!t.assetId || S.assets.audio.has(t.assetId)) continue;
      const rec = await RV.store.getAsset(t.assetId).catch(() => null);
      if (rec && rec.blob) { try { const buffer = await RV.audio.decode(rec.blob); S.assets.audio.set(t.assetId, { buffer, beats: RV.audio.detectBeats(buffer) }); } catch (e) { console.warn(e); } }
    }
    S.restoring = false;
    syncAllControls();
    update({ skipSave: !!(opts && opts.skipSave) });
    if (p.slides.length) select(p.slides[0].id, true);
  }

  const isMobile = () => window.matchMedia('(max-width: 900px), (pointer: coarse) and (max-width: 1100px)').matches;

  async function makeImageAsset(blob) {
    let bmp;
    try { bmp = await createImageBitmap(blob, { imageOrientation: 'from-image' }); }
    catch (e) { bmp = await createImageBitmap(blob); } /* older Safari: no orientation option */
    if (Math.max(bmp.width, bmp.height) > MAX_EDGE) {
      const k = MAX_EDGE / Math.max(bmp.width, bmp.height);
      const small = await createImageBitmap(bmp, { resizeWidth: Math.round(bmp.width * k), resizeHeight: Math.round(bmp.height * k), resizeQuality: 'high' });
      bmp.close(); bmp = small;
    }
    /* thumbnail */
    const tw = 220, th = Math.round(tw * bmp.height / bmp.width) || 1;
    const c = document.createElement('canvas'); c.width = tw; c.height = th;
    c.getContext('2d').drawImage(bmp, 0, 0, tw, th);
    return { bitmap: bmp, width: bmp.width, height: bmp.height, thumb: c.toDataURL('image/jpeg', 0.8) };
  }

  /* video asset: <video> element for frames + decoded audio for the mix + thumbnail */
  async function makeVideoAsset(blob) {
    const url = URL.createObjectURL(blob);
    const v = document.createElement('video');
    v.muted = true; v.playsInline = true; v.preload = 'auto'; v.src = url;
    await new Promise((res, rej) => {
      v.onloadedmetadata = () => res();
      v.onerror = () => rej(new Error('이 동영상 형식은 브라우저에서 재생할 수 없습니다.'));
      setTimeout(() => rej(new Error('동영상을 여는 데 시간이 너무 오래 걸립니다.')), 30000);
    });
    if (!v.videoWidth) throw new Error('영상 트랙이 없는 파일입니다.');
    await RV.seekVideo(v, Math.min(0.5, v.duration / 2));
    const tw = 220, th = Math.round(tw * v.videoHeight / v.videoWidth) || 1;
    const c = document.createElement('canvas'); c.width = tw; c.height = th;
    c.getContext('2d').drawImage(v, 0, 0, tw, th);
    let audioBuffer = null;
    try { audioBuffer = await RV.audio.ctx.decodeAudioData(await blob.arrayBuffer()); } catch (e) { audioBuffer = null; }
    const asset = { bitmap: v, video: v, url, width: v.videoWidth, height: v.videoHeight, duration: v.duration, thumb: c.toDataURL('image/jpeg', 0.8), audioBuffer, strip: null };
    makeFilmstrip(asset).then(() => { const s = selectedSlide(); if (s && S.assets.images.get(s.assetId) === asset) syncSlideControls(); });
    return asset;
  }
  /* filmstrip for the trimmer: N frames across the clip, rendered from a private <video> clone */
  async function makeFilmstrip(asset) {
    const N = 14, fw = 96, fh = 54;
    const v = document.createElement('video'); v.muted = true; v.playsInline = true; v.preload = 'auto'; v.src = asset.url;
    await new Promise((res) => { v.onloadedmetadata = () => res(); v.onerror = () => res(); setTimeout(res, 15000); });
    if (!v.videoWidth) return;
    const c = document.createElement('canvas'); c.width = fw * N; c.height = fh; const x = c.getContext('2d');
    const sc = Math.max(fw / v.videoWidth, fh / v.videoHeight), dw = v.videoWidth * sc, dh = v.videoHeight * sc;
    for (let i = 0; i < N; i++) {
      await RV.seekVideo(v, Math.min(asset.duration - 0.05, (i + 0.5) / N * asset.duration));
      x.drawImage(v, i * fw + (fw - dw) / 2, (fh - dh) / 2, dw, dh);
    }
    try { v.removeAttribute('src'); v.load(); } catch (e) { /* ignore */ }
    asset.strip = c.toDataURL('image/jpeg', 0.7);
  }
  function releaseAsset(id) {
    const a = S.assets.images.get(id);
    if (a && a.url) { try { a.video.pause(); a.video.removeAttribute('src'); a.video.load(); } catch (e) { /* ignore */ } URL.revokeObjectURL(a.url); }
    if (a && a.bitmap && a.bitmap.close) { try { a.bitmap.close(); } catch (e) { /* ignore */ } }
    S.assets.images.delete(id);
  }
  const isVideoFile = (f) => /^video\//.test(f.type) || /\.(mp4|m4v|webm|mov|mkv|ogv)$/i.test(f.name);
  const isImageFile = (f) => /^image\//.test(f.type) || /\.(jpe?g|png|webp|gif|bmp|heic|heif|avif)$/i.test(f.name);

  function scheduleSave() {
    clearTimeout(S.saveTimer);
    S.saveTimer = setTimeout(() => RV.store.saveProject(S.project).catch((e) => console.warn('autosave', e)), 700);
  }

  /* recompute timeline + refresh views */
  function update(o) {
    o = o || {};
    const musicLength = RV.audio.musicLength(S.project, S.assets);
    S.beats = collectBeats();
    S.tl = RV.computeTimeline(S.project, { musicLength, beats: S.beats });
    if (S.time > S.tl.total) S.time = Math.max(0, S.tl.total - 0.001);
    if (!o.keepMix) S.mixDirty = true;
    renderTimelineStrip();
    refreshInfo();
    drawFrame();
    if (!o.skipSave && !S.restoring) scheduleSave();
  }

  function collectBeats() {
    const out = []; let off = -(S.project.music.trimStart || 0);
    for (const t of S.project.music.tracks) {
      const a = S.assets.audio.get(t.assetId); if (!a) continue;
      for (const b of a.beats) { const tb = b + off; if (tb > 0) out.push(tb); }
      off += a.buffer.duration;
    }
    return out;
  }

  function refreshInfo() {
    const p = S.project;
    $('#slideCount').textContent = p.slides.length;
    $('#tlTotal').textContent = RV.fmtTime(S.tl.total);
    $('#tcTotal').textContent = RV.fmtTime(S.tl.total, true);
    const ml = RV.audio.musicLength(p, S.assets);
    $('#musicTotal').textContent = '(' + RV.fmtTime(ml) + ')';
    $('#musicTotal2').textContent = '총 ' + RV.fmtTime(ml);
    $('#tlEmpty').style.display = p.slides.length ? 'none' : '';
    $('#welcome').style.display = p.slides.length ? 'none' : ''; /* show the start screen until the first photo/video is added */
    const info = $('#durationInfo');
    if (!p.slides.length) info.textContent = '사진과 음악을 넣어 멋진 영상을 만들어보세요.';
    else {
      const photoItems = S.tl.items.filter((it) => it.slide.type !== 'title');
      const avg = photoItems.length ? photoItems.reduce((a, it) => a + it.duration, 0) / photoItems.length : 0;
      const nv = p.slides.filter((x) => x.type === 'video').length;
      let s = (nv ? '화면 ' + p.slides.length + '개 (동영상 ' + nv + '개)' : '사진 ' + p.slides.length + '장') + ' · 영상 길이 ' + RV.fmtTime(S.tl.total);
      if (p.beatSync && S.beats.length) s += ' · 비트 ' + S.beats.length + '개에 맞춤';
      else if (p.fitToMusic && ml > 0) s += ' · 장당 평균 ' + avg.toFixed(1) + '초';
      if (ml > 0 && !p.fitToMusic && !p.beatSync) s += (ml < S.tl.total ? (p.music.loop ? ' · 음악이 짧아 반복됩니다' : ' · 음악이 ' + RV.fmtTime(ml) + '에 끝납니다') : ' · 음악이 영상 끝에서 페이드아웃됩니다');
      if (isMobile() && p.slides.length > 60) s += ' · 폰에서는 60장 이하를 권장합니다';
      info.textContent = s;
    }
    const bi = $('#beatInfo');
    if (S.beats.length > 1) {
      const gaps = []; for (let i = 1; i < S.beats.length; i++) gaps.push(S.beats[i] - S.beats[i - 1]);
      gaps.sort((a, b) => a - b); const med = gaps[Math.floor(gaps.length / 2)];
      bi.textContent = '감지된 비트 ' + S.beats.length + '개 · 약 ' + Math.round(60 / med) + ' BPM';
    } else bi.textContent = '음악을 넣으면 비트를 자동으로 분석합니다.';
    $('#beatSync').disabled = ml <= 0; $('#fitToMusic').disabled = ml <= 0;
  }

  /* ---------------- preview / player ---------------- */
  function sizePreview() {
    const wrap = $('#previewWrap'), cv = $('#preview');
    const a = RV.ASPECTS[S.project.aspect];
    const maxW = wrap.clientWidth - 28, maxH = wrap.clientHeight - 28;
    let w = maxW, h = w * a.h / a.w;
    if (h > maxH) { h = maxH; w = h * a.w / a.h; }
    cv.style.width = Math.floor(w) + 'px'; cv.style.height = Math.floor(h) + 'px';
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const short = Math.min(1080, Math.round(Math.min(w, h) * dpr));
    const sz = RV.canvasSize(S.project.aspect, Math.max(240, short));
    if (!S.renderer) S.renderer = new RV.Renderer(sz.w, sz.h); else S.renderer.setSize(sz.w, sz.h);
    cv.width = sz.w; cv.height = sz.h;
  }
  let drawSeq = 0;
  async function drawFrame() {
    const seq = ++drawSeq;
    if (!S.renderer) sizePreview();
    const cv = $('#preview'), ctx = cv.getContext('2d');
    if (!S.tl.items.length) { ctx.fillStyle = '#000'; ctx.fillRect(0, 0, cv.width, cv.height); }
    else {
      if (hasVideo()) { await S.renderer.prepare(S.project, S.tl, S.time, S.assets, S.playing); if (seq !== drawSeq) return; }
      S.renderer.draw(S.project, S.tl, S.time, S.assets); ctx.drawImage(S.renderer.canvas, 0, 0);
    }
    $('#tcCur').textContent = RV.fmtTime(S.time, true);
    const sc = $('#scrub'); if (!sc.matches(':active')) sc.value = S.tl.total ? Math.round(S.time / S.tl.total * 1000) : 0;
    updateTrimPlayhead();
  }
  function hasVideo() { return S.project.slides.some((s) => s.type === 'video'); }
  function pauseVideos() { for (const a of S.assets.images.values()) if (a.video && !a.video.paused) a.video.pause(); }
  async function ensureMix() {
    if (!S.mixDirty && S.mix !== undefined) return S.mix;
    if (S.mixBuilding) return S.mixBuilding;
    S.mixBuilding = RV.audio.buildMix(S.project, S.assets, S.tl.total, S.tl).then((b) => { S.mix = b; S.mixDirty = false; S.mixBuilding = null; return b; }).catch((e) => { console.warn(e); S.mixBuilding = null; S.mix = null; S.mixDirty = false; return null; });
    return S.mixBuilding;
  }
  async function play() {
    if (!S.tl.items.length) return;
    if (S.time >= S.tl.total - 0.02) S.time = 0;
    S.playing = true; $('#btnPlay').textContent = '⏸';
    const mix = await ensureMix();
    if (!S.playing) return;
    RV.audio.play(mix, S.time);
    S.playStartCtx = RV.audio.ctx.currentTime; S.playStartT = S.time; S.playPerf = performance.now();
    cancelAnimationFrame(S.raf);
    const loop = async () => {
      if (!S.playing) return;
      const el = mix ? RV.audio.ctx.currentTime - S.playStartCtx : (performance.now() - S.playPerf) / 1000;
      S.time = S.playStartT + el;
      if (S.time >= S.tl.total) { S.time = S.tl.total; stopPlayback(false); await drawFrame(); return; }
      if (S.stopAt != null && S.time >= S.stopAt) { S.time = S.stopAt - 0.02; S.stopAt = null; stopPlayback(false); await drawFrame(); return; }
      await drawFrame(); highlightCurrent();
      if (S.playing) S.raf = requestAnimationFrame(loop);
    };
    S.raf = requestAnimationFrame(loop);
  }
  function stopPlayback(reset) {
    S.playing = false; S.stopAt = null; cancelAnimationFrame(S.raf); RV.audio.stop(); pauseVideos(); $('#btnPlay').textContent = '▶';
    if (reset) { S.time = 0; drawFrame(); }
  }
  function togglePlay() { if (S.playing) stopPlayback(false); else play(); }
  function seek(t) { const was = S.playing; if (was) stopPlayback(false); S.time = RV.clamp(t, 0, S.tl.total); drawFrame(); if (was) play(); }
  function highlightCurrent() {
    const loc = RV.locate(S.tl, S.time); if (!loc) return;
    const id = loc.b.slide.id;
    if (id !== S.selectedId && !id.startsWith('__')) { S.selectedId = id; markSelection(); syncSlideControls(); }
  }

  /* ---------------- adding assets ---------------- */
  async function addPhotos(files) {
    const list = Array.from(files).filter((f) => isImageFile(f) || isVideoFile(f));
    if (!list.length) { toast('사진 또는 동영상 파일이 없습니다.', true); return; }
    list.sort((a, b) => a.name.localeCompare(b.name, 'ko', { numeric: true }));
    let ok = 0, fail = 0, firstId = null, vids = 0;
    toast('파일 ' + list.length + '개 불러오는 중…');
    for (const f of list) {
      try {
        const video = isVideoFile(f) && !isImageFile(f);
        if (video) toast('동영상 분석 중: ' + f.name);
        const asset = video ? await makeVideoAsset(f) : await makeImageAsset(f);
        const id = RV.uid(video ? 'vid' : 'img');
        await RV.store.putAsset(id, { blob: f, name: f.name, kind: video ? 'video' : 'image' });
        S.assets.images.set(id, asset);
        const slide = RV.createSlide(video
          ? { type: 'video', name: f.name, assetId: id, width: asset.width, height: asset.height, srcDuration: asset.duration, in: 0, out: 0, volume: 1, muted: false, mtime: f.lastModified || 0 }
          : { name: f.name, assetId: id, width: asset.width, height: asset.height, mtime: f.lastModified || 0 });
        slide.caption = Object.assign(RV.defaultCaption(), JSON.parse(JSON.stringify(S.project.captionDefaults)), { text: '' });
        const idx = selectedIndex();
        if (idx >= 0) S.project.slides.splice(idx + 1 + ok, 0, slide); else S.project.slides.push(slide);
        if (!firstId) firstId = slide.id;
        ok++; if (video) vids++;
      } catch (e) { console.warn('media load failed', f.name, e); fail++; toast(f.name + ': ' + (e.message || '열 수 없습니다'), true); }
    }
    update();
    if (firstId) select(firstId, true);
    toast((ok - vids) + '장 사진' + (vids ? ' · 동영상 ' + vids + '개' : '') + ' 추가' + (fail ? ' · ' + fail + '개 실패' : ''), !!fail && !ok);
    if (vids) toast('동영상 구간은 자막 탭에서 잘라 쓸 수 있습니다.');
  }
  function addTextSlide() {
    const slide = RV.createSlide({ type: 'text', name: '텍스트 화면', bgStyle: 'night' });
    slide.caption = Object.assign(RV.defaultCaption(), { text: '여기에 내용을 입력하세요', pos: 'mc', size: 64, effect: 'rise' });
    const idx = selectedIndex();
    if (idx >= 0) S.project.slides.splice(idx + 1, 0, slide); else S.project.slides.push(slide);
    update(); select(slide.id, true); showTab('caption'); $('#capText').focus(); $('#capText').select();
  }
  async function addMusic(files) {
    const list = Array.from(files).filter((f) => /^audio\//.test(f.type) || /\.(mp3|m4a|aac|wav|ogg|oga|flac|opus|weba)$/i.test(f.name));
    if (!list.length) { toast('음악 파일이 없습니다.', true); return; }
    for (const f of list) {
      try {
        toast('음악 분석 중: ' + f.name);
        const buffer = await RV.audio.decode(f);
        const id = RV.uid('aud');
        await RV.store.putAsset(id, { blob: f, name: f.name, kind: 'audio' });
        S.assets.audio.set(id, { buffer, beats: RV.audio.detectBeats(buffer) });
        S.project.music.tracks.push({ id: RV.uid('tr'), assetId: id, name: f.name, duration: buffer.duration, volume: 1 });
      } catch (e) { console.warn(e); toast(f.name + ' 을(를) 열 수 없습니다.', true); }
    }
    renderMusicLists(); update();
    if (S.project.slides.length && !S.project.fitToMusic && !S.project.beatSync) toast('팁: "음악 재생시간에 균등하게 맞춤"을 켜면 음악 길이에 맞춰집니다.');
  }
  function removeTrack(trackId) {
    const m = S.project.music; const i = m.tracks.findIndex((t) => t.id === trackId); if (i < 0) return;
    const [t] = m.tracks.splice(i, 1);
    if (!m.tracks.some((x) => x.assetId === t.assetId)) { S.assets.audio.delete(t.assetId); RV.store.deleteAsset(t.assetId).catch(() => {}); }
    S.selectedTrack = null; renderMusicLists(); update();
  }
  function renderMusicLists() {
    const m = S.project.music;
    const ul = $('#musicList'), ul2 = $('#musicList2');
    ul.innerHTML = ''; ul2.innerHTML = '';
    if (!m.tracks.length) { ul.innerHTML = '<li class="empty">여기에 음악을 넣어보세요. (MP3 · M4A · WAV · OGG)</li>'; ul2.innerHTML = '<li class="empty">음악이 없습니다.</li>'; return; }
    m.tracks.forEach((t, i) => {
      const li = document.createElement('li'); li.className = t.id === S.selectedTrack ? 'sel' : '';
      li.innerHTML = '<span class="muted">' + (i + 1) + '</span><span class="n"></span><span class="d">' + RV.fmtTime(t.duration) + '</span>';
      li.querySelector('.n').textContent = t.name;
      li.onclick = () => { S.selectedTrack = t.id; renderMusicLists(); };
      ul.appendChild(li);
      const li2 = document.createElement('li');
      li2.innerHTML = '<span class="muted">' + (i + 1) + '</span><span class="n"></span><span class="d">' + RV.fmtTime(t.duration) + '</span>' +
        '<input type="range" min="0" max="1.5" step="0.05" value="' + (t.volume == null ? 1 : t.volume) + '" title="곡 볼륨">' +
        '<button class="mini" title="위로">▲</button><button class="mini" title="아래로">▼</button><button class="mini" title="제거">✕</button>';
      li2.querySelector('.n').textContent = t.name;
      const [up, down, del] = li2.querySelectorAll('button');
      li2.querySelector('input').oninput = (e) => { t.volume = +e.target.value; S.mixDirty = true; scheduleSave(); };
      up.onclick = () => { if (i > 0) { m.tracks.splice(i - 1, 0, m.tracks.splice(i, 1)[0]); renderMusicLists(); update(); } };
      down.onclick = () => { if (i < m.tracks.length - 1) { m.tracks.splice(i + 1, 0, m.tracks.splice(i, 1)[0]); renderMusicLists(); update(); } };
      del.onclick = () => removeTrack(t.id);
      ul2.appendChild(li2);
    });
  }

  /* ---------------- timeline strip ---------------- */
  function renderTimelineStrip() {
    const strip = $('#tlStrip');
    $$('.tl-item', strip).forEach((n) => n.remove());
    const p = S.project;
    const mk = (cls, inner) => { const d = document.createElement('div'); d.className = 'tl-item ' + cls; d.innerHTML = inner; return d; };
    if (p.opening.enabled) {
      const it = S.tl.byId.__opening;
      const d = mk('title-card', '<div class="thumb"></div><div class="meta"><span class="idx">오프닝</span><span class="nm"></span><span class="dur">' + it.duration.toFixed(1) + 's</span></div>');
      d.querySelector('.thumb').textContent = p.opening.title || '(제목 없음)';
      d.onclick = () => { S.selectedId = null; markSelection(); seek(it.start + 0.9); showTab('quick'); };
      strip.appendChild(d);
    }
    p.slides.forEach((s, i) => {
      const it = S.tl.byId[s.id];
      const img = s.assetId && S.assets.images.get(s.assetId);
      let thumb;
      if (s.type === 'text') thumb = '<div class="thumb text-card"></div>';
      else if (img) thumb = '<img class="thumb" draggable="false" src="' + img.thumb + '">';
      else thumb = '<div class="thumb text-card">불러올 수 없음</div>';
      const badges = (s.type === 'video' ? '<span class="cap-dot vid">▶ 동영상' + (s.caption.text ? ' · 자막' : '') + '</span>' : (s.caption.text ? '<span class="cap-dot">자막</span>' : '')) + (s.rotation ? '<span class="rot">' + s.rotation + '°</span>' : '');
      const d = mk(s.id === S.selectedId ? 'sel' : '', thumb + '<div class="meta"><span class="idx">' + (i + 1) + '</span><span class="nm"></span><span class="dur">' + it.duration.toFixed(1) + 's</span></div>' + badges);
      d.dataset.id = s.id; d.draggable = true;
      d.querySelector('.nm').textContent = s.name;
      if (s.type === 'text') d.querySelector('.thumb').textContent = s.caption.text || '텍스트';
      d.onclick = () => { select(s.id, true); if (s.type === 'video' && $('.tabs button.active').dataset.tab === 'quick') showTab('caption'); };
      d.ondragstart = (e) => { e.dataTransfer.setData('text/rv-slide', s.id); e.dataTransfer.effectAllowed = 'move'; };
      d.ondragover = (e) => { if (e.dataTransfer.types.includes('text/rv-slide')) { e.preventDefault(); d.classList.add('dragover'); } };
      d.ondragleave = () => d.classList.remove('dragover');
      d.ondrop = (e) => {
        d.classList.remove('dragover'); const src = e.dataTransfer.getData('text/rv-slide'); if (!src || src === s.id) return;
        e.preventDefault(); e.stopPropagation();
        const from = p.slides.findIndex((x) => x.id === src); const [mv] = p.slides.splice(from, 1);
        const to = p.slides.findIndex((x) => x.id === s.id); p.slides.splice(to, 0, mv);
        update(); select(mv.id, false);
      };
      strip.appendChild(d);
    });
    if (p.ending.enabled) {
      const it = S.tl.byId.__ending;
      const d = mk('title-card', '<div class="thumb"></div><div class="meta"><span class="idx">엔딩</span><span class="nm"></span><span class="dur">' + it.duration.toFixed(1) + 's</span></div>');
      d.querySelector('.thumb').textContent = p.ending.title || '(제목 없음)';
      d.onclick = () => { S.selectedId = null; markSelection(); seek(it.start + 0.9); showTab('quick'); };
      strip.appendChild(d);
    }
  }
  function markSelection() {
    $$('.tl-item').forEach((n) => n.classList.toggle('sel', !!S.selectedId && n.dataset.id === S.selectedId));
    const sel = $('.tl-item.sel'); if (sel) sel.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    const has = !!selectedSlide();
    ['#btnDelete', '#btnRotL', '#btnRotR'].forEach((id) => ($(id).disabled = !has));
    const i = selectedIndex();
    $('#btnMoveL').disabled = i <= 0; $('#btnMoveR').disabled = i < 0 || i >= S.project.slides.length - 1;
  }
  function select(id, doSeek) {
    S.selectedId = id; markSelection(); syncSlideControls();
    const it = S.tl.byId[id];
    if (doSeek && it) seek(Math.min(it.end - 0.05, it.start + it.trIn + Math.min(0.7, it.duration * 0.3)));
  }
  /* move the selected slide one step (touch-friendly alternative to drag & drop) */
  function moveSlide(dir) {
    const p = S.project, i = selectedIndex(); if (i < 0) return;
    const j = i + dir; if (j < 0 || j >= p.slides.length) return;
    [p.slides[i], p.slides[j]] = [p.slides[j], p.slides[i]];
    update(); select(p.slides[j].id, false);
  }
  function moveSelection(dir) {
    const p = S.project; if (!p.slides.length) return;
    let i = selectedIndex(); i = i < 0 ? 0 : RV.clamp(i + dir, 0, p.slides.length - 1);
    select(p.slides[i].id, true);
  }
  function deleteSelected() {
    const i = selectedIndex(); if (i < 0) return;
    const [s] = S.project.slides.splice(i, 1);
    if (s.assetId && !S.project.slides.some((x) => x.assetId === s.assetId)) { releaseAsset(s.assetId); RV.store.deleteAsset(s.assetId).catch(() => {}); }
    S.selectedId = null; update();
    if (S.project.slides.length) select(S.project.slides[Math.min(i, S.project.slides.length - 1)].id, true); else markSelection();
  }
  function rotateSelected(deg) { const s = selectedSlide(); if (!s || (s.type !== 'photo' && s.type !== 'video')) return; s.rotation = ((s.rotation || 0) + deg + 360) % 360; S.renderer.invalidate(); update(); }
  function sortSlides(mode) {
    const p = S.project;
    if (mode === 'name') p.slides.sort((a, b) => a.name.localeCompare(b.name, 'ko', { numeric: true }));
    else if (mode === 'date') p.slides.sort((a, b) => (a.mtime || 0) - (b.mtime || 0));
    else if (mode === 'reverse') p.slides.reverse();
    else if (mode === 'shuffle') { for (let i = p.slides.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [p.slides[i], p.slides[j]] = [p.slides[j], p.slides[i]]; } }
    update();
  }

  /* ---------------- controls sync ---------------- */
  function syncAllControls() {
    const p = S.project;
    $('#projName').value = p.name;
    $('#aspect').value = p.aspect; $('#fit').value = p.fit;
    $('#kenBurns').checked = p.kenBurns; $('#blurFill').checked = p.blurFill;
    $('#defaultDuration').value = p.defaultDuration; $('#fitToMusic').checked = p.fitToMusic; $('#beatSync').checked = p.beatSync;
    $('#openingOn').checked = p.opening.enabled; $('#openingTitle').value = p.opening.title; $('#openingSub').value = p.opening.subtitle || '';
    $('#endingOn').checked = p.ending.enabled; $('#endingTitle').value = p.ending.title; $('#endingSub').value = p.ending.subtitle || '';
    $('#titleStyle').value = p.opening.style || 'classic'; $('#titleDuration').value = p.opening.duration;
    $('#bgColor').value = p.bgColor; $('#blurAmount').value = p.blurAmount; $('#blurDarken').value = p.blurDarken;
    $('#trDuration').value = p.transitionDuration; $('#trDurationVal').textContent = p.transitionDuration.toFixed(1) + '초';
    $('#kbIntensity').value = p.kbIntensity == null ? 1 : p.kbIntensity;
    $('#musicVolume').value = p.music.volume; $('#musicVolumeVal').textContent = Math.round(p.music.volume * 100) + '%';
    $('#fadeIn').value = p.music.fadeIn; $('#fadeOut').value = p.music.fadeOut; $('#trimStart').value = p.music.trimStart || 0; $('#musicLoop').checked = p.music.loop;
    $('#duckVideo').checked = p.music.duckVideo !== false; $('#duckLevel').value = p.music.duckLevel == null ? 0.25 : p.music.duckLevel; $('#duckLevelVal').textContent = Math.round((p.music.duckLevel == null ? 0.25 : p.music.duckLevel) * 100) + '%';
    renderMusicLists(); sizePreview(); syncSlideControls();
  }
  function syncSlideControls() {
    const p = S.project, s = selectedSlide();
    const cap = s ? s.caption : p.captionDefaults;
    $('#capFont').value = cap.font; $('#capSize').value = String(cap.size); $('#capColor').value = cap.color;
    $('#capBold').classList.toggle('on', !!cap.bold); $('#capItalic').classList.toggle('on', !!cap.italic); $('#capShadow').classList.toggle('on', !!cap.shadow); $('#capOutline').classList.toggle('on', !!cap.outline); $('#capBox').classList.toggle('on', !!cap.box);
    $('#capText').value = s ? cap.text : ''; $('#capText').disabled = !s; $('#capText').placeholder = s ? '이 화면에 넣을 자막을 입력하세요. 줄바꿈도 됩니다.' : '타임라인에서 화면을 먼저 선택하세요.';
    $$('#posGrid button').forEach((b) => b.classList.toggle('on', b.dataset.pos === cap.pos));
    $$('#capEffects button').forEach((b) => b.classList.toggle('on', b.dataset.fx === cap.effect));
    $('#slideDuration').value = s && s.duration != null ? s.duration : ''; $('#slideDuration').disabled = !s || p.fitToMusic || p.beatSync;
    const isVid = !!(s && s.type === 'video');
    $('#durationRow').hidden = isVid; $('#videoBox').hidden = !isVid;
    if (isVid) {
      renderTrimmer(s);
      $('#vVolume').value = s.volume == null ? 1 : s.volume; $('#vVolumeVal').textContent = Math.round((s.volume == null ? 1 : s.volume) * 100) + '%';
      $('#vMute').checked = !!s.muted;
    }
    const eff = (key) => (s && s[key] != null ? s[key] : p[key]);
    const mark = (grid, val, isOverride) => $$('.tile', $(grid)).forEach((t) => { t.classList.toggle('on', t.dataset.id === val); t.classList.toggle('override', isOverride && t.dataset.id === val); });
    mark('#bgGrid', eff('bgStyle'), !!(s && s.bgStyle != null));
    mark('#frameGrid', eff('frame'), !!(s && s.frame != null));
    mark('#trGrid', eff('transition'), !!(s && s.transition != null));
    mark('#cineGrid', eff('cinematic'), !!(s && s.cinematic != null));
  }

  /* ---------------- video trimmer ---------------- */
  function clipRange(s) {
    const src = +s.srcDuration || 0, inPt = Math.max(0, +s.in || 0);
    const outPt = (s.out && s.out > inPt) ? Math.min(s.out, src) : src;
    return { src, inPt, outPt };
  }
  function renderTrimmer(s) {
    const { src, inPt, outPt } = clipRange(s);
    const a = S.assets.images.get(s.assetId);
    const strip = $('#vStrip');
    if (a && a.strip) { strip.style.backgroundImage = 'url(' + a.strip + ')'; strip.classList.remove('loading'); }
    else { strip.style.backgroundImage = ''; strip.classList.add('loading'); }
    const pl = src ? inPt / src * 100 : 0, pr = src ? outPt / src * 100 : 100;
    $('#vDimL').style.width = pl + '%'; $('#vDimR').style.width = (100 - pr) + '%';
    $('#vSelBox').style.left = pl + '%'; $('#vSelBox').style.width = (pr - pl) + '%';
    $('#vHandleL').style.left = pl + '%'; $('#vHandleR').style.left = pr + '%';
    $('#vLblIn').textContent = inPt.toFixed(1) + 's'; $('#vLblOut').textContent = outPt.toFixed(1) + 's';
    $('#vIn').value = inPt.toFixed(1); $('#vOut').value = outPt.toFixed(1); $('#vLenIn').value = (outPt - inPt).toFixed(1);
    $('#vIn').max = src.toFixed(1); $('#vOut').max = src.toFixed(1); $('#vLenIn').max = (src - inPt).toFixed(1);
    $('#vSrcLen').textContent = '(원본 ' + RV.fmtTime(src, true) + ' · 선택 ' + (outPt - inPt).toFixed(1) + '초)';
    updateTrimPlayhead(s);
  }
  /* white line on the filmstrip = where the preview currently is inside this clip */
  function updateTrimPlayhead(s) {
    s = s || selectedSlide(); const ph = $('#vPlayhead');
    if (!s || s.type !== 'video' || $('#videoBox').hidden) { if (ph) ph.style.display = 'none'; return; }
    const it = S.tl.byId[s.id]; const { src, inPt } = clipRange(s);
    if (!it || S.time < it.start || S.time > it.end || !src) { ph.style.display = 'none'; return; }
    const ct = inPt + (S.time - it.start);
    ph.style.display = 'block'; ph.style.left = RV.clamp(ct / src * 100, 0, 100) + '%';
  }
  /* current preview position expressed in clip time, or null when the preview is elsewhere */
  function currentClipTime(s) {
    const it = S.tl.byId[s.id]; if (!it) return null;
    if (S.time < it.start - 0.001 || S.time > it.end + 0.001) return null;
    return clipRange(s).inPt + (S.time - it.start);
  }
  /* set in/out; light=true while dragging (no strip rebuild / autosave), preview follows the moved edge */
  function setTrim(inPt, outPt, which, light) {
    const s = selectedSlide(); if (!s || s.type !== 'video') return;
    const src = +s.srcDuration || 0;
    inPt = RV.clamp(+inPt || 0, 0, Math.max(0, src - 0.5));
    outPt = RV.clamp(+outPt || src, inPt + 0.5, src);
    s.in = Math.round(inPt * 10) / 10; s.out = outPt >= src - 0.05 ? 0 : Math.round(outPt * 10) / 10;
    if (S.playing) stopPlayback(false);
    /* preview time for an edge: 'in' = first fully visible frame, 'out' = last frame before the next transition starts */
    const edgeTime = (it) => {
      if (which !== 'out') return it.start + it.trIn + 0.01;
      const next = S.tl.items[it.index + 1];
      return Math.max(it.start + it.trIn, it.end - (next ? next.trIn : 0) - 0.05);
    };
    if (light) {
      S.tl = RV.computeTimeline(S.project, { musicLength: RV.audio.musicLength(S.project, S.assets), beats: S.beats });
      const it = S.tl.byId[s.id];
      if (it) S.time = edgeTime(it);
      S.mixDirty = true; drawFrame(); renderTrimmer(s);
      return;
    }
    update(); syncSlideControls();
    const it = S.tl.byId[s.id];
    if (it && (which === 'in' || which === 'out')) seek(edgeTime(it));
  }
  function bindTrimmer() {
    const box = $('#trimmer');
    const posToTime = (clientX) => { const r = box.getBoundingClientRect(); const s = selectedSlide(); const src = s ? +s.srcDuration || 0 : 0; return RV.clamp((clientX - r.left) / r.width, 0, 1) * src; };
    const drag = (handle, which) => {
      let active = false, raf = 0, lastX = 0;
      handle.addEventListener('pointerdown', (e) => { active = true; handle.setPointerCapture(e.pointerId); handle.classList.add('drag'); e.preventDefault(); });
      handle.addEventListener('pointermove', (e) => {
        if (!active) return; lastX = e.clientX;
        if (raf) return;
        raf = requestAnimationFrame(() => { raf = 0; const s = selectedSlide(); if (!s) return; const { inPt, outPt } = clipRange(s); const t = posToTime(lastX); if (which === 'in') setTrim(t, outPt, 'in', true); else setTrim(inPt, t, 'out', true); });
      });
      const end = () => { if (!active) return; active = false; handle.classList.remove('drag'); const s = selectedSlide(); if (s) { const { inPt, outPt } = clipRange(s); setTrim(inPt, outPt, which, false); } };
      handle.addEventListener('pointerup', end); handle.addEventListener('pointercancel', end);
      handle.addEventListener('keydown', (e) => { const s = selectedSlide(); if (!s) return; const { inPt, outPt } = clipRange(s); const d = e.key === 'ArrowLeft' ? -0.1 : e.key === 'ArrowRight' ? 0.1 : 0; if (!d) return; e.preventDefault(); if (which === 'in') setTrim(inPt + d, outPt, 'in'); else setTrim(inPt, outPt + d, 'out'); });
    };
    drag($('#vHandleL'), 'in'); drag($('#vHandleR'), 'out');
    /* click on the strip (not on a handle) = move the nearer handle there */
    $('#vStrip').addEventListener('pointerdown', (e) => { const s = selectedSlide(); if (!s) return; const { inPt, outPt } = clipRange(s); const t = posToTime(e.clientX); if (Math.abs(t - inPt) <= Math.abs(t - outPt)) setTrim(t, outPt, 'in'); else setTrim(inPt, t, 'out'); });
    const nudge = (which, d) => { const s = selectedSlide(); if (!s) return; const { inPt, outPt } = clipRange(s); if (which === 'in') setTrim(inPt + d, outPt, 'in'); else setTrim(inPt, outPt + d, 'out'); };
    $('#vInMinus').onclick = () => nudge('in', -0.5); $('#vInPlus').onclick = () => nudge('in', 0.5);
    $('#vOutMinus').onclick = () => nudge('out', -0.5); $('#vOutPlus').onclick = () => nudge('out', 0.5);
    $('#vIn').onchange = (e) => { const s = selectedSlide(); if (s) setTrim(e.target.value, clipRange(s).outPt, 'in'); };
    $('#vOut').onchange = (e) => { const s = selectedSlide(); if (s) setTrim(clipRange(s).inPt, e.target.value, 'out'); };
    $('#vLenIn').onchange = (e) => { const s = selectedSlide(); if (!s) return; const { inPt } = clipRange(s); setTrim(inPt, inPt + (+e.target.value || 0.5), 'out'); };
    $$('#videoBox .quick [data-len]').forEach((b) => (b.onclick = () => { const s = selectedSlide(); if (!s) return; const { inPt, src } = clipRange(s); const len = +b.dataset.len; const start = inPt + len <= src ? inPt : Math.max(0, src - len); setTrim(start, start + len, 'out'); }));
    $('#vReset').onclick = () => { const s = selectedSlide(); if (s) setTrim(0, s.srcDuration, 'in'); };
    const setFromPreview = (which) => {
      const s = selectedSlide(); if (!s || s.type !== 'video') return;
      const ct = currentClipTime(s);
      if (ct == null) { toast('미리보기를 이 동영상 화면 안의 장면에 맞춘 뒤 눌러주세요.', true); return; }
      const { inPt, outPt } = clipRange(s);
      if (which === 'in') { if (ct >= outPt - 0.5) { toast('시작 지점은 끝보다 0.5초 이상 앞이어야 합니다.', true); return; } setTrim(ct, outPt, 'in'); toast('시작 지점: ' + ct.toFixed(1) + '초'); }
      else { if (ct <= inPt + 0.5) { toast('끝 지점은 시작보다 0.5초 이상 뒤여야 합니다.', true); return; } setTrim(inPt, ct, 'out'); toast('끝 지점: ' + ct.toFixed(1) + '초'); }
    };
    $('#vSetIn').onclick = () => setFromPreview('in'); $('#vSetOut').onclick = () => setFromPreview('out');
    $('#vPlaySeg').onclick = () => { const s = selectedSlide(); if (!s) return; const it = S.tl.byId[s.id]; if (!it) return; S.time = it.start + it.trIn; S.stopAt = it.end; play(); };
    RV.app.setFromPreview = setFromPreview;
  }

  /* ---------------- tiles ---------------- */
  function buildTiles() {
    /* backgrounds */
    const bgGrid = $('#bgGrid');
    RV.BACKGROUNDS.forEach((b) => {
      const t = document.createElement('button'); t.className = 'tile'; t.dataset.id = b.id;
      if (b.id === 'none') t.innerHTML = '<div class="ico" title="사진 여백에 블러 또는 단색을 씁니다">∅</div>';
      else { const c = document.createElement('canvas'); c.width = 96; c.height = 54; RV.drawBackground(c.getContext('2d'), 96, 54, b.id, $('#bgColor').value); t.appendChild(c); }
      t.insertAdjacentHTML('beforeend', '<div class="lbl">' + b.label + '</div>');
      t.onclick = () => applyDesign('bgStyle', b.id);
      bgGrid.appendChild(t);
    });
    /* frames */
    const frGrid = $('#frameGrid');
    RV.FRAMES.forEach((f) => {
      const t = document.createElement('button'); t.className = 'tile'; t.dataset.id = f.id;
      const c = document.createElement('canvas'); c.width = 192; c.height = 108; const x = c.getContext('2d');
      x.fillStyle = '#000'; x.fillRect(0, 0, 192, 108);
      const rect = RV.frameRect(f, 192, 108);
      if (f.under) { x.save(); f.under(x, 192, 108, rect); x.restore(); }
      x.save(); RV.frameClip(x, f, rect, 192, 108);
      const g = x.createLinearGradient(0, 0, 192, 108); g.addColorStop(0, '#6aa9ff'); g.addColorStop(1, '#ff9a5f'); x.fillStyle = g; x.fillRect(rect.x, rect.y, rect.w, rect.h); x.restore();
      if (f.over) { x.save(); f.over(x, 192, 108, rect); x.restore(); }
      t.appendChild(c); t.insertAdjacentHTML('beforeend', '<div class="lbl">' + f.label + '</div>');
      t.onclick = () => applyDesign('frame', f.id);
      frGrid.appendChild(t);
    });
    /* transitions */
    const icons = { none: '▭', crossfade: '◐', fadeblack: '◼', fadewhite: '◻', slideleft: '←', slideright: '→', slideup: '↑', slidedown: '↓', wipe: '◧', zoom: '⤢', circle: '◯', blinds: '☰', random: '🎲' };
    const trGrid = $('#trGrid');
    RV.TRANSITIONS.forEach((tr) => {
      const t = document.createElement('button'); t.className = 'tile'; t.dataset.id = tr.id;
      t.innerHTML = '<div class="ico">' + icons[tr.id] + '</div><div class="lbl">' + tr.label + '</div>';
      t.onclick = () => applyDesign('transition', tr.id);
      trGrid.appendChild(t);
    });
    /* cinematics */
    const cnGrid = $('#cineGrid');
    RV.CINEMATICS.forEach((cn) => {
      const t = document.createElement('button'); t.className = 'tile'; t.dataset.id = cn.id;
      if (cn.id === 'none') t.innerHTML = '<div class="ico">∅</div>';
      else { const c = document.createElement('canvas'); c.width = 192; c.height = 108; const x = c.getContext('2d'); x.fillStyle = '#2a2d36'; x.fillRect(0, 0, 192, 108); RV.drawCinematic(x, 192, 108, cn.id, 1.3, {}); t.appendChild(c); }
      t.insertAdjacentHTML('beforeend', '<div class="lbl">' + cn.label + '</div>');
      t.onclick = () => applyDesign('cinematic', cn.id);
      cnGrid.appendChild(t);
    });
    /* caption positions & effects */
    const posGrid = $('#posGrid');
    const posGlyph = { tl: '◤', tc: '▲', tr: '◥', ml: '◀', mc: '●', mr: '▶', bl: '◣', bc: '▼', br: '◢' };
    ['tl', 'tc', 'tr', 'ml', 'mc', 'mr', 'bl', 'bc', 'br'].forEach((pos) => {
      const b = document.createElement('button'); b.dataset.pos = pos; b.textContent = posGlyph[pos]; b.title = { t: '위', m: '가운데', b: '아래' }[pos[0]] + ' ' + { l: '왼쪽', c: '중앙', r: '오른쪽' }[pos[1]];
      b.onclick = () => setCaption('pos', pos); posGrid.appendChild(b);
    });
    const fxl = $('#capEffects');
    RV.CAPTION_EFFECTS.forEach((fx) => { const b = document.createElement('button'); b.dataset.fx = fx.id; b.textContent = fx.label; b.onclick = () => setCaption('effect', fx.id); fxl.appendChild(b); });
    fillSelect($('#capFont'), RV.FONTS.map((f) => ({ value: f, label: f })));
    fillSelect($('#capSize'), [24, 28, 32, 36, 40, 48, 56, 64, 72, 84, 96, 120].map((n) => ({ value: n, label: n })));
    fillSelect($('#aspect'), Object.keys(RV.ASPECTS).map((k) => ({ value: k, label: RV.ASPECTS[k].label })));
    fillSelect($('#titleStyle'), RV.TITLE_STYLES.map((t) => ({ value: t.id, label: t.label })));
    fillSelect($('#exRes'), Object.keys(RV.RESOLUTIONS).map((k) => ({ value: k, label: RV.RESOLUTIONS[k].label })));
  }
  function applyDesign(key, val) {
    const s = selectedSlide();
    if (s) s[key] = val; else S.project[key] = val;
    if (key === 'bgStyle' && val === 'custom') { $('#bgColor').focus(); }
    update(); syncSlideControls();
  }
  function applyAll(key) {
    const s = selectedSlide();
    const val = s && s[key] != null ? s[key] : S.project[key];
    S.project[key] = val; S.project.slides.forEach((x) => (x[key] = null));
    update(); syncSlideControls(); toast('모든 화면에 적용했습니다.');
  }
  function setCaption(key, val) {
    const s = selectedSlide();
    const target = s ? s.caption : S.project.captionDefaults;
    target[key] = val;
    if (!s) toast('선택된 화면이 없어 기본 자막 스타일로 저장했습니다.');
    update(); syncSlideControls();
  }

  /* ---------------- tabs / modals ---------------- */
  function showTab(name) {
    $$('.tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
    $$('.tab-page').forEach((p) => p.classList.toggle('active', p.dataset.page === name));
  }
  function openModal(id) { $('#' + id).classList.add('open'); }
  function closeModal(id) { $('#' + id).classList.remove('open'); }

  /* ---------------- export ---------------- */
  let exportAbort = null, exportCaps = null, lastExport = null; /* lastExport: { file, url, savedToDisk } */
  const platform = (() => { const ua = navigator.userAgent || ''; const ios = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1); const android = /Android/i.test(ua); return { ios, android, mobile: ios || android || isMobile() }; })();
  const KAKAO_LIMIT_MB = 300;
  /* Chrome-based phone browsers refuse navigator.share() above 50 MB in total (the call fails with "Permission denied") */
  const SHARE_LIMIT_MB = 50, SHARE_TARGET_MB = 44;
  const inApp = (() => { const ua = navigator.userAgent || ''; if (/KAKAOTALK/i.test(ua)) return 'kakaotalk'; return /NAVER\(inapp|Instagram|FBAN|FBAV|FB_IAB|Line\/|DaumApps|everytimeApp|; wv\)/i.test(ua) ? 'other' : ''; })();
  const shareTooBig = (file) => !platform.ios && platform.mobile && file.size > SHARE_LIMIT_MB * 1048576;
  function openInBrowser() {
    const url = location.href.split('#')[0];
    if (inApp === 'kakaotalk') location.href = 'kakaotalk://web/openExternal?url=' + encodeURIComponent(url);
    else if (platform.android) location.href = 'intent://' + url.replace(/^https?:\/\//, '') + '#Intent;scheme=https;action=android.intent.action.VIEW;category=android.intent.category.BROWSABLE;end';
    else toast('화면의 메뉴(⋯ 또는 공유 아이콘)에서 "Safari로 열기"를 눌러 주세요.', true);
  }
  function showInAppNotice() {
    if (!inApp || !platform.mobile) return;
    $('#inAppMsg').innerHTML = (inApp === 'kakaotalk' ? '지금은 <b>카카오톡 안에서 열린 화면</b>입니다. ' : '지금은 <b>앱 안에서 열린 화면</b>입니다. ') + '이 화면에서는 완성한 영상을 <b>저장하거나 카카오톡으로 보내는 기능이 막혀</b> 있습니다. 크롬이나 삼성 인터넷' + (platform.ios ? '(아이폰은 Safari)' : '') + '으로 열어서 만들어 주세요.';
    if (platform.ios && inApp !== 'kakaotalk') $('#inAppOpen').textContent = '여는 방법 보기';
    openModal('inAppModal');
  }
  /* how to send the finished video, per device */
  function sendHintHtml(file, canShare) {
    const mb = file.size / 1048576;
    const warn = mb > KAKAO_LIMIT_MB ? '<div class="warn">이 파일은 ' + mb.toFixed(0) + ' MB입니다. 카카오톡은 한 번에 약 ' + KAKAO_LIMIT_MB + ' MB까지만 보낼 수 있으니, 크기를 720p로 낮추거나 품질을 "중"으로 바꿔 다시 만들어 보세요.</div>' : '';
    if (platform.ios) return warn + '<ol><li><b>카카오톡 등으로 보내기</b>를 누르고 <b>카카오톡</b>을 고른 뒤 채팅방(또는 나와의 채팅)을 선택하세요. 메시지·메일·AirDrop도 같은 창에서 고를 수 있습니다.</li><li>사진 앱에 보관하려면 같은 창에서 <b>비디오 저장</b>을 누르세요.</li></ol>';
    if (platform.android) return warn + (mb > SHARE_LIMIT_MB ? '' : '<ol><li><b>카카오톡 등으로 보내기</b>를 누르고 <b>카카오톡</b>을 고른 뒤 채팅방(또는 나와의 채팅)을 선택하세요. 밴드·메시지·메일·드라이브도 같은 창에서 고를 수 있습니다.</li><li>갤러리에 보관하려면 같은 창에서 <b>갤러리</b>(또는 Google 포토)를 고르세요.</li></ol>');
    return warn + '<ol><li><b>카카오톡 PC</b>: 채팅방을 연 뒤 위의 <b>파일 아이콘을 채팅창으로 끌어다 놓으세요</b>. 잘 안 되면 채팅창의 파일 전송(📎)에서 저장한 파일을 고르면 됩니다.</li>' +
      (canShare ? '<li><b>공유 창으로 보내기</b>는 Windows 공유 창을 엽니다. 메일, 근거리 공유, 휴대폰과 연결 등으로 보낼 수 있습니다.</li>' : '') +
      '<li>휴대폰 카카오톡으로 보내려면 "나와의 채팅"에 올려 두면 폰에서 바로 받을 수 있습니다.</li></ol>';
  }
  function setLastExport(file, savedToDisk) {
    if (lastExport && lastExport.url) URL.revokeObjectURL(lastExport.url);
    lastExport = { file, url: URL.createObjectURL(file), savedToDisk: !!savedToDisk };
    $('#btnSend').hidden = false;
  }
  function renderSendPanel() {
    if (!lastExport) { $('#exSendBox').hidden = true; return; }
    const f = lastExport.file;
    let can = false; try { can = !!(navigator.canShare && navigator.canShare({ files: [f] })); } catch (e) { can = false; }
    $('#exSendBox').hidden = false;
    $('#exShare').hidden = !can;
    $('#exShare').textContent = platform.mobile ? '💬 카카오톡 등으로 보내기' : '📤 공유 창으로 보내기';
    const chip = $('#exDragFile'); chip.hidden = platform.mobile; chip.href = lastExport.url; chip.download = f.name; $('#exDragName').textContent = f.name;
    $('#exSendHint').innerHTML = sendHintHtml(f, can);
    $('#exSendAlt').hidden = true;
    if (platform.mobile && inApp) {
      $('#exSendAlt').innerHTML = '<b>' + (inApp === 'kakaotalk' ? '카카오톡 안에서 열린 화면' : '앱 안에서 열린 화면') + '에서는 영상을 저장하거나 보낼 수 없습니다.</b><br>크롬이나 삼성 인터넷으로 열어서 다시 만들어 주세요.<div class="alt-btns" style="margin-top:8px"><button id="exOpenBrowser" class="primary">크롬 · 삼성 인터넷으로 열기</button></div>';
      $('#exSendAlt').hidden = false; $('#exOpenBrowser').onclick = openInBrowser;
    } else if (can && shareTooBig(f)) showSendAlt('이 영상은 ' + (f.size / 1048576).toFixed(0) + ' MB입니다. 휴대폰 브라우저의 보내기 창은 ' + SHARE_LIMIT_MB + ' MB까지만 받을 수 있습니다.');
  }
  /* what to do instead when the share sheet cannot take the file */
  function showSendAlt(why) {
    if (!lastExport) return;
    const mb = lastExport.file.size / 1048576, box = $('#exSendAlt');
    box.innerHTML = '<b>' + why + '</b><ol>' +
      '<li><b>' + escHtml(lastExport.file.name) + ' 다운로드</b>를 눌러 휴대폰에 저장한 뒤, 카카오톡 채팅방의 <b>＋ › 파일</b>(또는 앨범)에서 그 영상을 골라 보내세요. 이 방법은 ' + KAKAO_LIMIT_MB + ' MB까지 보낼 수 있습니다.</li>' +
      (mb > SHARE_TARGET_MB ? '<li>또는 <b>카카오톡 전송용</b>으로 다시 만들면 50 MB 이하로 줄어들어 [카카오톡 등으로 보내기]가 바로 됩니다.</li>' : '') + '</ol>' +
      '<div class="alt-btns">' + (mb > SHARE_TARGET_MB ? '<button id="exRemakeKakao" class="primary">카카오톡 전송용으로 다시 만들기</button>' : '') + '</div>';
    box.hidden = false;
    const dl = $('#exDownload'); dl.href = lastExport.url; dl.download = lastExport.file.name; dl.textContent = lastExport.file.name + ' 다운로드 (' + mb.toFixed(1) + ' MB)'; dl.hidden = false;
    const rb = $('#exRemakeKakao'); if (rb) rb.onclick = () => { box.hidden = true; openExport('kakao'); };
  }
  async function shareLastExport() {
    if (!lastExport) return;
    const f = lastExport.file;
    if (shareTooBig(f)) { showSendAlt('이 영상은 ' + (f.size / 1048576).toFixed(0) + ' MB입니다. 휴대폰 브라우저의 보내기 창은 ' + SHARE_LIMIT_MB + ' MB까지만 받을 수 있습니다.'); return; }
    try { await navigator.share({ files: [f], title: f.name.replace(/\.[^.]+$/, '') }); }
    catch (e) {
      if (e.name === 'AbortError') return;
      console.warn('share failed', e);
      showSendAlt('보내기 창을 열지 못했습니다 (' + escHtml(e.name || '오류') + ').');
    }
  }
  /* reopen the done view for the last finished video (top-bar 보내기 button) */
  function openSendPanel() {
    if (!lastExport) return;
    stopPlayback(false);
    $('#exportForm').hidden = true; $('#exportProgress').hidden = true; $('#exportDone').hidden = false;
    $('#exStart').hidden = true; $('#exCancel').hidden = true; $('#exClose').hidden = false;
    const f = lastExport.file;
    $('#exDoneMsg').textContent = f.name + ' · ' + (f.size / 1048576).toFixed(1) + ' MB';
    const a = $('#exDownload'); a.href = lastExport.url; a.download = f.name; a.hidden = lastExport.savedToDisk; a.textContent = f.name + ' 다운로드';
    $('#exSaveHint').hidden = lastExport.savedToDisk; if (!lastExport.savedToDisk) $('#exSaveHint').innerHTML = saveHintHtml('video');
    renderSendPanel(); openModal('exportModal');
  }

  /* tell phone users where a downloaded/shared file ends up */
  function saveHintHtml(kind) {
    const what = kind === 'video' ? '영상' : kind === 'project' ? '프로젝트 파일' : '음악 파일';
    if (platform.ios) return '<b>아이폰·아이패드에서 ' + what + ' 저장 위치</b><ol>' +
      (kind === 'video' ? '<li><b>카카오톡 등으로 보내기</b> → <b>비디오 저장</b>을 누르면 사진 앱(최근 항목)에 저장됩니다.</li>' : '<li><b>공유</b>를 누르면 카카오톡·메시지·파일 앱으로 보낼 수 있습니다.</li>') +
      '<li><b>파일 다운로드</b>를 누르면 <b>파일</b> 앱 › 다운로드 폴더(설정에 따라 iCloud Drive 또는 나의 iPhone)에 저장됩니다. Safari 주소창 오른쪽 ↓ 아이콘에서도 바로 열 수 있습니다.</li></ol>';
    if (platform.android) return '<b>안드로이드에서 ' + what + ' 저장 위치</b><ol>' +
      (kind === 'video' ? '<li><b>카카오톡 등으로 보내기</b> → <b>갤러리</b>(또는 Google 포토)를 고르면 갤러리에 저장됩니다.</li>' : '<li><b>공유</b>를 누르면 카카오톡·드라이브·내 파일로 보낼 수 있습니다.</li>') +
      '<li><b>파일 다운로드</b>를 누르면 휴대폰의 <b>다운로드</b> 폴더에 저장됩니다. <b>내 파일</b> 앱 › 다운로드, 또는 Chrome 메뉴(⋮) › 다운로드에서 찾을 수 있습니다.</li></ol>';
    return '<b>파일 다운로드</b>를 누르면 브라우저의 다운로드 폴더에 저장됩니다. Chrome·Edge 오른쪽 위 ↓ 아이콘에서 확인할 수 있습니다.';
  }
  async function openExport(preset) {
    if (!S.tl.items.length) { toast('먼저 사진을 추가하세요.', true); return; }
    stopPlayback(false);
    const p = S.project;
    $('#exName').value = p.export.name || p.name || '내 영상';
    $('#exRes').value = p.export.res; $('#exFps').value = String(p.export.fps); $('#exQuality').value = p.export.quality;
    $('#exPreset').value = 'pc';
    if (isMobile() && !p.export.name) { $('#exPreset').value = 'sns'; $('#exRes').value = '720p'; $('#exFps').value = '30'; $('#exQuality').value = 'medium'; }
    if (typeof preset === 'string') $('#exPreset').value = preset;
    $('#exSendBox').hidden = true; $('#exSaveHint').hidden = true;
    $('#exportForm').hidden = false; $('#exportProgress').hidden = true; $('#exportDone').hidden = true;
    $('#exStart').hidden = false; $('#exClose').hidden = true; $('#exCancel').hidden = false; $('#exStart').disabled = false;
    openModal('exportModal');
    if (typeof preset === 'string') applyPreset(preset); else refreshExportInfo();
    if (!exportCaps) exportCaps = await RV.exportCapabilities();
    refreshExportInfo();
  }
  function applyPreset(v) {
    const map = { pc: ['1080p', 30, 'high'], youtube: ['1080p', 30, 'high'], sns: ['720p', 30, 'medium'], '4k': ['2160p', 30, 'high'] };
    if (map[v]) { $('#exRes').value = map[v][0]; $('#exFps').value = String(map[v][1]); $('#exQuality').value = map[v][2]; }
    if (v === 'kakao') {
      /* fit the whole file into the share limit: (target size / length) minus the audio track and container overhead */
      const budget = SHARE_TARGET_MB * 8 * 1048576 / Math.max(1, S.tl.total) - 192000 - 24000;
      const res = budget >= 1.0e6 ? '720p' : '480p';
      $('#exRes').value = res; $('#exFps').value = '30'; $('#exQuality').value = 'medium';
      const sz = RV.canvasSize(S.project.aspect, RV.RESOLUTIONS[res].short);
      const bps = RV.clamp(budget, 0.3e6, RV.suggestBitrate(sz.w, sz.h, 30, 'medium'));
      refreshExportInfo(true); $('#exBitrate').value = (Math.floor(bps / 1e5) / 10).toFixed(1); refreshExportInfo(false);
      return;
    }
    refreshExportInfo(true);
  }
  function exportSettings() {
    const res = $('#exRes').value, fps = +$('#exFps').value, quality = $('#exQuality').value;
    const sz = RV.canvasSize(S.project.aspect, RV.RESOLUTIONS[res].short);
    const bitrate = Math.round((+$('#exBitrate').value || 0) * 1e6) || RV.suggestBitrate(sz.w, sz.h, fps, quality);
    return { res, fps, quality, w: sz.w, h: sz.h, bitrate };
  }
  function refreshExportInfo(resetBitrate) {
    const es = exportSettings();
    if (resetBitrate || !$('#exBitrate').value) $('#exBitrate').value = String(Math.max(0.3, Math.round(RV.suggestBitrate(es.w, es.h, es.fps, es.quality) / 1e5) / 10));
    const es2 = exportSettings();
    const mb = (es2.bitrate + 192000) * S.tl.total / 8 / 1048576;
    let codec = '코덱 확인 중…';
    if (exportCaps) codec = exportCaps.ok ? ('코덱: ' + exportCaps.video + (exportCaps.audio ? ' + ' + exportCaps.audio : ' (오디오 인코더 없음)') + ' → ' + exportCaps.container.toUpperCase()) : exportCaps.reason;
    $('#exInfo').innerHTML = '해상도 <b>' + es2.w + ' × ' + es2.h + '</b> · ' + es2.fps + ' fps · 길이 ' + RV.fmtTime(S.tl.total) + ' · 예상 용량 약 <b>' + (mb < 1 ? mb.toFixed(2) : mb.toFixed(0)) + ' MB</b><br>' + codec + (window.showSaveFilePicker ? '' : '<br>저장 위치를 물어볼 수 없는 브라우저라 다운로드 폴더에 저장됩니다.');
    if ($('#exPreset').value === 'kakao' && mb > SHARE_LIMIT_MB) $('#exInfo').innerHTML += '<br><span style="color:#ffb86b">영상이 길어서 50 MB 이하로 줄일 수 없습니다. 만든 뒤 [다운로드]로 저장하고 카카오톡 채팅방의 ＋ › 파일에서 보내 주세요.</span>';
    if (exportCaps && !exportCaps.ok) $('#exStart').disabled = true;
  }
  async function startExport() {
    const es = exportSettings(); const p = S.project;
    p.export = { res: es.res, fps: es.fps, quality: es.quality, bitrate: 0, name: $('#exName').value.trim() || p.name }; scheduleSave();
    const ext = exportCaps && exportCaps.container === 'webm' ? 'webm' : 'mp4';
    const fname = (p.export.name || '내 영상').replace(/[\\/:*?"<>|]/g, '_') + '.' + ext;
    let handle = null;
    if (window.showSaveFilePicker) {
      try { handle = await window.showSaveFilePicker({ suggestedName: fname, types: [{ description: ext === 'mp4' ? 'MP4 동영상' : 'WebM 동영상', accept: ext === 'mp4' ? { 'video/mp4': ['.mp4'] } : { 'video/webm': ['.webm'] } }] }); }
      catch (e) { if (e.name === 'AbortError') return; console.warn(e); }
    }
    $('#exportForm').hidden = true; $('#exportProgress').hidden = false; $('#exStart').hidden = true;
    const pc = $('#exPreview'); pc.width = 320; pc.height = Math.round(320 * es.h / es.w);
    exportAbort = new AbortController();
    const t0 = performance.now();
    try {
      const r = await RV.exportVideo(p, S.tl, {
        width: es.w, height: es.h, fps: es.fps, bitrate: es.bitrate, fileHandle: handle, assets: S.assets, signal: exportAbort.signal, previewCanvas: pc,
        onProgress: (frac, info) => {
          $('#exBar').style.width = (frac * 100).toFixed(1) + '%';
          $('#exStatus').innerHTML = '<b>' + (frac * 100).toFixed(0) + '%</b> · ' + info.frame + ' / ' + info.frames + ' 프레임 · ' + info.fps.toFixed(0) + ' fps · 남은 시간 약 ' + RV.fmtTime(info.eta) + '<br>' + info.video + (info.audio ? ' + ' + info.audio : '') + ' · ' + es.w + '×' + es.h;
        },
      });
      const secs = ((performance.now() - t0) / 1000).toFixed(0);
      $('#exportProgress').hidden = true; $('#exportDone').hidden = false; $('#exCancel').hidden = true; $('#exClose').hidden = false;
      const a = $('#exDownload');
      let outFile = null;
      if (r.blob) {
        outFile = new File([r.blob], fname, { type: r.mime });
        $('#exDoneMsg').textContent = '동영상이 완성되었습니다! (' + secs + '초 소요)';
      } else {
        try { outFile = await handle.getFile(); } catch (e) { outFile = null; }
        $('#exDoneMsg').textContent = fname + ' 파일로 저장했습니다. (' + secs + '초 소요, ' + r.video + (r.audio ? ' + ' + r.audio : '') + ')';
      }
      if (outFile) setLastExport(outFile, !r.blob);
      if (r.blob && lastExport) {
        a.href = lastExport.url; a.download = fname; a.hidden = false; a.textContent = fname + ' 다운로드 (' + (r.blob.size / 1048576).toFixed(1) + ' MB)';
        $('#exSaveHint').innerHTML = saveHintHtml('video'); $('#exSaveHint').hidden = false;
      } else { a.hidden = true; $('#exSaveHint').hidden = true; }
      renderSendPanel();
      toast('동영상 만들기 완료');
    } catch (e) {
      console.error(e);
      $('#exportProgress').hidden = true; $('#exportForm').hidden = false; $('#exStart').hidden = false;
      if (e.name === 'AbortError') toast('동영상 만들기를 취소했습니다.'); else toast('오류: ' + (e.message || e), true);
    } finally { exportAbort = null; }
  }

  /* ---------------- AI music generation ---------------- */
  let mgAbort = null, mgResult = null, mgUrl = null;
  const SAMPLE_LYRICS = '[verse]\n파란 하늘 아래 우리 웃음이 번져\n손을 꼭 잡고 걷던 그 길 위에서\n작은 순간들이 모여 하루가 되고\n그 하루가 모여 우리가 되었지\n\n[chorus]\n함께라서 더 빛나는 시간\n사진 속에 남은 우리의 노래\n언제라도 꺼내 볼 수 있게\n오늘을 여기 담아둘게\n\n[verse]\n바람에 실려 온 웃음소리처럼\n따뜻한 기억이 마음에 남아\n\n[chorus]\n함께라서 더 빛나는 시간\n사진 속에 남은 우리의 노래';
  function mgShow(view) {
    $('#mgForm').hidden = view !== 'form'; $('#mgProgress').hidden = view !== 'progress'; $('#mgResult').hidden = view !== 'result';
    $('#mgStart').hidden = view !== 'form'; $('#mgAdd').hidden = view !== 'result'; $('#mgRetry').hidden = view !== 'result'; $('#mgDownload').hidden = view !== 'result';
    $('#mgCancel').textContent = view === 'progress' ? '중단' : (view === 'result' ? '닫기' : '취소');
  }
  async function mgSyncProvider(prefillKey) {
    const id = $('#mgProvider').value, prov = RV.musicgen.providers[id]; if (!prov) return;
    const info = await RV.musicgen.probeServer();
    const serverKey = !!(info.ok && info.providers && info.providers[id]);
    $('#mgProviderNote').textContent = prov.note || '';
    const needsCode = serverKey && !!info.needsCode && !prov.noKey;
    $('#mgCodeRow').hidden = !needsCode;
    if (needsCode && !$('#mgCode').value) $('#mgCode').value = localStorage.getItem('rv.lecture.code') || '';
    /* own-key row: hidden for built-in songs and when the site key works without a code */
    $('#mgKeyRow').hidden = !!prov.noKey || (serverKey && !needsCode);
    const keyLabel = $('#mgKeyRow label.wide'); if (keyLabel && keyLabel.firstChild) keyLabel.firstChild.textContent = needsCode ? '또는 내 API 키 ' : 'API 키 ';
    $('.mg-grid').hidden = !!prov.builtin; /* style/lyrics inputs only matter for AI composition */
    $('#mgStart').textContent = prov.builtin ? '🎵 이 곡 듣고 넣기' : '✨ 만들기';
    $('#mgHint').textContent = prov.builtin ? '기본으로 들어 있는 곡입니다. [이 곡 듣고 넣기]를 누르면 미리 들어보고 배경음악으로 넣을 수 있습니다. 키나 요금이 필요 없습니다.'
      : needsCode ? '강의 코드를 넣으면 강사가 등록한 키로 작곡합니다(한 곡 최대 ' + Math.round((info.maxSongSeconds || 120) / 60 * 10) / 10 + '분). 코드가 없으면 아래에 내 ElevenLabs API 키를 넣어 쓸 수 있습니다.'
      : serverKey ? '이 사이트에 등록된 작곡 서비스 키를 사용합니다. 별도 키가 필요 없습니다. 한 곡은 최대 ' + Math.round((info.maxSongSeconds || 120) / 60 * 10) / 10 + '분입니다.'
      : '키는 이 PC의 브라우저 안에만 저장되며 작곡 요청에만 사용됩니다. 곡 하나에 보통 30초~2분이 걸리고, 서비스 요금이 발생할 수 있습니다.';
    if (prefillKey !== false) $('#mgKey').value = RV.musicgen.getKey(id) || '';
    $('#mgKeyLink').href = prov.keyUrl || '#'; $('#mgKeyLink').hidden = !prov.keyUrl;
  }
  async function openMusicGen() {
    stopPlayback(false);
    const sel = $('#mgProvider');
    if (!sel.options.length) {
      const groups = { ai: document.createElement('optgroup'), builtin: document.createElement('optgroup') };
      groups.ai.label = 'AI 작곡 (API 키 필요)'; groups.builtin.label = '기본 제공 음악 (바로 사용)';
      RV.musicgen.providerIds().forEach((id) => { const pv = RV.musicgen.providers[id]; const o = document.createElement('option'); o.value = id; o.textContent = pv.label; (groups[pv.group] || groups.ai).appendChild(o); });
      sel.appendChild(groups.ai); sel.appendChild(groups.builtin);
      const saved = localStorage.getItem('rv.musicgen.provider');
      sel.value = saved && RV.musicgen.providers[saved] ? saved : 'elevenlabs';
      const chips = $('#mgChips');
      RV.musicgen.STYLE_CHIPS.forEach((c) => { const b = document.createElement('button'); b.textContent = c; b.onclick = () => { const ta = $('#mgStyle'); const cur = ta.value.trim(); if (cur.includes(c)) { ta.value = cur.replace(c, '').replace(/,\s*,/g, ',').replace(/^[,\s]+|[,\s]+$/g, ''); b.classList.remove('on'); } else { ta.value = cur ? cur + ', ' + c : c; b.classList.add('on'); } }; chips.appendChild(b); });
    }
    mgShow('form'); $('#mgStatus').textContent = '작곡 중…';
    if ($('#mgLength').value === 'fit' && !S.tl.total) $('#mgLength').value = '120';
    await mgSyncProvider();
    openModal('musicGenModal');
    if (!$('.mg-grid').hidden) $('#mgStyle').focus();
  }
  async function startMusicGen() {
    const provider = $('#mgProvider').value, style = $('#mgStyle').value.trim(), lyrics = $('#mgLyrics').value.trim(), vocal = $('#mgVocal').value;
    const prov = RV.musicgen.providers[provider] || {};
    if (!prov.builtin && !style && !lyrics) { toast('분위기·스타일이나 가사를 적어 주세요.', true); $('#mgStyle').focus(); return; }
    let lengthSec = $('#mgLength').value === 'fit' ? Math.round(S.tl.total) : +$('#mgLength').value;
    lengthSec = RV.clamp(lengthSec || 120, 10, 300);
    const key = $('#mgKeyRow').hidden ? '' : $('#mgKey').value.trim();
    const accessCode = $('#mgCodeRow').hidden ? '' : $('#mgCode').value.trim();
    if (accessCode) localStorage.setItem('rv.lecture.code', accessCode);
    if (!$('#mgKeyRow').hidden) RV.musicgen.setKey(provider, key, $('#mgKeySave').checked);
    localStorage.setItem('rv.musicgen.provider', provider);
    mgAbort = new AbortController(); mgShow('progress');
    const t0 = performance.now();
    const tick = setInterval(() => { const s = Math.round((performance.now() - t0) / 1000); const base = $('#mgStatus').dataset.base || '작곡 중…'; $('#mgStatus').textContent = base + ' (' + s + '초 경과)'; }, 1000);
    try {
      const res = await RV.musicgen.generate({ provider, style, lyrics, vocal, lengthSec, key, accessCode, signal: mgAbort.signal, onStatus: (m) => { $('#mgStatus').dataset.base = m; $('#mgStatus').textContent = m; } });
      mgResult = res; if (mgUrl) URL.revokeObjectURL(mgUrl); mgUrl = URL.createObjectURL(res.blob);
      $('#mgAudio').src = mgUrl;
      const title = (style ? style.split(/[,，·]/)[0].trim().slice(0, 24) : '새 곡') + (lyrics && vocal !== 'none' ? '' : ' (연주곡)');
      $('#mgTitle').value = prov.builtin ? prov.title : 'AI 작곡 - ' + title;
      $('#mgResultInfo').textContent = (prov.builtin ? '기본 제공 음악 · ' : RV.musicgen.providers[provider].label + ' · ' + res.meta.seconds + '초 만에 완성 · ') + (res.blob.size / 1048576).toFixed(1) + ' MB. 들어보고 마음에 들면 배경음악으로 넣으세요.' + (res.meta.madeLyrics ? '\n\nAI가 지은 가사:\n' + res.meta.madeLyrics : '');
      $('#mgResultInfo').style.whiteSpace = 'pre-wrap';
      const dl = $('#mgDownload'); dl.href = mgUrl; dl.download = $('#mgTitle').value + '.' + res.ext; dl.title = platform.mobile ? (platform.ios ? '파일 앱 › 다운로드 폴더에 저장' : '다운로드 폴더에 저장') : '';
      mgShow('result'); $('#mgAudio').play().catch(() => {});
    } catch (e) {
      console.error(e); mgShow('form');
      if (e.name === 'AbortError') toast('작곡을 중단했습니다.');
      else {
        toast('작곡 실패: ' + (e.message || e), true);
        await mgSyncProvider(false);
        if (e.reason === 'bad_code' && !$('#mgCodeRow').hidden) { localStorage.removeItem('rv.lecture.code'); $('#mgCode').focus(); $('#mgCode').select(); }
      }
    } finally { clearInterval(tick); mgAbort = null; }
  }
  async function addGeneratedMusic() {
    if (!mgResult) return;
    const name = ($('#mgTitle').value.trim() || 'AI 작곡') + '.' + mgResult.ext;
    $('#mgAudio').pause();
    const file = new File([mgResult.blob], name, { type: mgResult.mime });
    closeModal('musicGenModal');
    await addMusic([file]);
    const tr = S.project.music.tracks[S.project.music.tracks.length - 1];
    if (tr && tr.name === name) { tr.generated = mgResult.meta; scheduleSave(); }
    if (!S.project.fitToMusic && !S.project.beatSync && S.project.slides.length) toast('팁: 3번의 "음악 재생시간에 균등하게 맞춤"을 켜면 새 곡 길이에 맞춰집니다.');
  }

  /* ---------------- operator usage view ---------------- */
  let usageSeq = 0;
  const escHtml = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  function fmtN(n) { return (n == null || isNaN(n)) ? '-' : Math.round(n).toLocaleString('ko-KR'); }
  function renderUsage(u) {
    const sub = u.subscription, days = (u.days || []).slice(-14);
    const today = days.length ? days[days.length - 1] : null;
    const total14 = days.reduce((a, d) => a + d.credits, 0), req14 = days.reduce((a, d) => a + d.requests, 0);
    const maxC = Math.max(1, ...days.map((d) => d.credits));
    let html = '<div class="us-cards">';
    if (sub) {
      const pct = sub.limit ? Math.min(100, sub.used / sub.limit * 100) : 0;
      html += '<div class="us-card"><div class="k">이번 달 사용 크레딧</div><div class="v">' + fmtN(sub.used) + '</div><div class="us-meter"><i style="width:' + pct.toFixed(1) + '%"></i></div><div class="s">한도 ' + fmtN(sub.limit) + ' 중 ' + pct.toFixed(1) + '%</div></div>';
      html += '<div class="us-card"><div class="k">남은 크레딧</div><div class="v">' + fmtN(sub.remaining) + '</div><div class="s">' + (sub.resetUnix ? new Date(sub.resetUnix * 1000).toLocaleDateString('ko-KR') + ' 초기화' : '') + (sub.tier ? ' · ' + escHtml(sub.tier) : '') + '</div></div>';
    }
    html += '<div class="us-card"><div class="k">오늘 사용</div><div class="v">' + fmtN(today ? today.credits : 0) + '</div><div class="s">요청 ' + fmtN(today ? today.requests : 0) + '회</div></div>';
    html += '<div class="us-card"><div class="k">최근 14일</div><div class="v">' + fmtN(total14) + '</div><div class="s">요청 ' + fmtN(req14) + '회</div></div></div>';
    if (days.length) {
      html += '<table class="us-table"><thead><tr><th>날짜</th><th>크레딧</th><th>요청</th><th></th></tr></thead><tbody>' +
        days.slice().reverse().map((d) => '<tr><td>' + new Date(d.t).toLocaleDateString('ko-KR', { month: 'numeric', day: 'numeric', weekday: 'short' }) + '</td><td>' + fmtN(d.credits) + '</td><td>' + fmtN(d.requests) + '</td><td class="bar"><span class="b" style="width:' + (d.credits / maxC * 100).toFixed(1) + '%"></span></td></tr>').join('') + '</tbody></table>';
      const prod = Object.entries(u.byProduct || {}).filter(([, v]) => v > 0).map(([k, v]) => escHtml(k) + ' ' + fmtN(v)).join(' · ');
      if (prod) html += '<div class="hint">기능별(14일): ' + prod + '</div>';
    }
    if (u.errors && u.errors.length) html += '<div class="us-err">' + u.errors.map((e) => '⚠ ' + escHtml(e)).join('<br>') + '</div>';
    html += '<div class="hint">숫자는 ElevenLabs 계정 전체 기준입니다. 강의 전용 키만의 사용량은 ElevenLabs 사이트의 Usage 화면에서 키별로 볼 수 있습니다. 음악 1분은 요금제에 따라 정해진 크레딧이 차감됩니다.</div>';
    $('#usBody').innerHTML = html;
    $('#usStamp').textContent = new Date().toLocaleTimeString('ko-KR') + ' 기준';
  }
  async function loadUsage() {
    const code = $('#usAdmin').value.trim();
    if (!code) { toast('관리자 코드를 입력해 주세요.', true); return; }
    $('#usBody').innerHTML = '<div class="mg-wait"><div class="spinner"></div><div class="ex-status">ElevenLabs에서 사용량을 불러오는 중…</div></div>';
    const seq = ++usageSeq; $('#usLoad').disabled = true;
    try { const u = await RV.musicgen.usage(code); if (seq !== usageSeq) return; localStorage.setItem('rv.admin.code', code); renderUsage(u); }
    catch (e) { if (seq !== usageSeq) return; localStorage.removeItem('rv.admin.code'); $('#usBody').innerHTML = '<div class="us-err">⚠ ' + escHtml(e.message || e) + '</div>'; }
    finally { if (seq === usageSeq) $('#usLoad').disabled = false; }
  }
  function openUsage() {
    closeModal('helpModal');
    $('#usAdmin').value = localStorage.getItem('rv.admin.code') || '';
    openModal('usageModal');
    if ($('#usAdmin').value) loadUsage(); else $('#usAdmin').focus();
  }

  /* ---------------- project file ---------------- */
  async function saveProjectFile() {
    toast('프로젝트 파일 만드는 중…');
    const blob = await RV.serializeProject(S.project, S.assets);
    const fname = (S.project.name || '내 영상').replace(/[\\/:*?"<>|]/g, '_') + '.rvproj';
    if (window.showSaveFilePicker) {
      try { const h = await window.showSaveFilePicker({ suggestedName: fname, types: [{ description: 'RuninqVic 프로젝트', accept: { 'application/json': ['.rvproj'] } }] }); const w = await h.createWritable(); await w.write(blob); await w.close(); toast('프로젝트를 저장했습니다.'); return; }
      catch (e) { if (e.name === 'AbortError') return; }
    }
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = fname; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    toast(platform.ios ? '파일 앱 › 다운로드 폴더에 ' + fname + ' 을(를) 저장했습니다.' : '다운로드 폴더에 ' + fname + ' 을(를) 저장했습니다.');
  }
  async function openProjectFile(file) {
    try {
      toast('프로젝트 여는 중…');
      const { project, assets } = await RV.parseProjectFile(file);
      await RV.store.clearAll();
      for (const a of assets) await RV.store.putAsset(a.id, { blob: a.blob, name: a.name, kind: a.kind });
      await setProject(project);
      toast('프로젝트를 열었습니다.');
    } catch (e) { console.error(e); toast('프로젝트를 열 수 없습니다: ' + e.message, true); }
  }
  async function newProject() {
    if (S.project.slides.length && !confirm('현재 작업을 지우고 새로 시작할까요?')) return;
    await RV.store.clearAll();
    await setProject(RV.createProject());
  }

  /* ---------------- events ---------------- */
  function bind() {
    const p = () => S.project;
    const on = (sel, ev, fn) => $(sel).addEventListener(ev, fn);
    /* Text fields: keep the model in step with every keystroke (cheap), refresh the views after a short pause.
       While an IME composition is open (Korean on a phone keyboard) nothing heavy runs at all. */
    let typingTimer = 0, composing = false;
    const refreshSoon = (ms) => { clearTimeout(typingTimer); typingTimer = setTimeout(() => { if (composing) return; update(); }, ms); };
    const bindTyping = (sel, apply) => {
      const el = $(sel);
      el.addEventListener('compositionstart', () => { composing = true; clearTimeout(typingTimer); });
      el.addEventListener('compositionend', (e) => { composing = false; apply(e); refreshSoon(150); });
      el.addEventListener('input', (e) => { apply(e); if (!(composing || e.isComposing)) refreshSoon(250); });
      const flush = (e) => { composing = false; clearTimeout(typingTimer); apply(e); update(); };
      el.addEventListener('change', flush); el.addEventListener('blur', flush);
    };
    /* Phones: while a text field in the work panel has the keyboard, give the panel the room (hide the timeline and the
       transport, shrink the preview) and keep the field in view. */
    const phoneLayout = window.matchMedia('(max-width: 900px), (pointer: coarse) and (max-width: 1100px)');
    const isTextField = (el) => !!el && (el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && /^(text|search|url|email|password|number)?$/i.test(el.getAttribute('type') || '')));
    const setTypingMode = (onNow) => { if (document.body.classList.contains('typing') === onNow) return; document.body.classList.toggle('typing', onNow); sizePreview(); drawFrame(); };
    $('.panel').addEventListener('focusin', (e) => {
      if (!phoneLayout.matches || !isTextField(e.target)) return;
      setTypingMode(true);
      setTimeout(() => { if (document.activeElement === e.target) e.target.scrollIntoView({ block: 'center' }); }, 350);
    });
    $('.panel').addEventListener('focusout', () => { setTimeout(() => { if (!isTextField(document.activeElement)) setTypingMode(false); }, 120); });
    $$('.tabs button').forEach((b) => (b.onclick = () => showTab(b.dataset.tab)));
    $$('[data-close]').forEach((b) => (b.onclick = () => closeModal(b.dataset.close)));
    on('#btnGoDetail', 'click', () => showTab('caption'));
    on('#btnHelp', 'click', () => openModal('helpModal'));

    /* files */
    on('#btnAddPhotos', 'click', () => $('#filePhotos').click()); on('#btnAddPhotos2', 'click', () => $('#filePhotos').click());
    on('#btnAddPhotosOnly', 'click', () => $('#filePhotosOnly').click()); on('#btnAddVideosOnly', 'click', () => $('#fileVideosOnly').click());
    on('#filePhotosOnly', 'change', (e) => { addPhotos(e.target.files); e.target.value = ''; });
    on('#fileVideosOnly', 'change', (e) => { addPhotos(e.target.files); e.target.value = ''; });
    on('#btnAddMusic', 'click', () => $('#fileMusic').click()); on('#btnAddMusic2', 'click', () => $('#fileMusic').click());
    on('#filePhotos', 'change', (e) => { addPhotos(e.target.files); e.target.value = ''; });
    on('#fileMusic', 'change', (e) => { addMusic(e.target.files); e.target.value = ''; });
    on('#fileProj', 'change', (e) => { if (e.target.files[0]) openProjectFile(e.target.files[0]); e.target.value = ''; });
    on('#btnRemoveMusic', 'click', () => { const m = p().music; const id = S.selectedTrack || (m.tracks.length ? m.tracks[m.tracks.length - 1].id : null); if (id) removeTrack(id); });
    on('#btnAddText', 'click', addTextSlide);
    on('#btnDelete', 'click', deleteSelected);
    on('#btnClear', 'click', () => { if (!p().slides.length) return; if (!confirm('모든 화면을 삭제할까요?')) return; stopPlayback(false); p().slides.forEach((s) => { if (s.assetId) { RV.store.deleteAsset(s.assetId).catch(() => {}); releaseAsset(s.assetId); } }); p().slides = []; S.selectedId = null; update(); markSelection(); });
    on('#sortSel', 'change', (e) => { if (e.target.value) sortSlides(e.target.value); e.target.value = ''; });
    on('#btnRotL', 'click', () => rotateSelected(-90)); on('#btnRotR', 'click', () => rotateSelected(90));
    on('#btnNew', 'click', newProject); on('#btnOpen', 'click', () => $('#fileProj').click()); on('#btnSave', 'click', saveProjectFile);
    on('#btnExport', 'click', openExport);
    on('#projName', 'change', (e) => { p().name = e.target.value.trim() || '내 영상'; scheduleSave(); });

    /* drag & drop anywhere */
    let dragDepth = 0;
    window.addEventListener('dragenter', (e) => { if (e.dataTransfer.types.includes('Files')) { dragDepth++; document.body.classList.add('dragging'); } });
    window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; document.body.classList.remove('dragging'); } });
    window.addEventListener('dragover', (e) => { if (e.dataTransfer.types.includes('Files')) e.preventDefault(); });
    window.addEventListener('drop', (e) => {
      dragDepth = 0; document.body.classList.remove('dragging');
      if (!e.dataTransfer.files.length) return; e.preventDefault();
      const files = Array.from(e.dataTransfer.files);
      const proj = files.find((f) => /\.rvproj$/i.test(f.name)); if (proj) { openProjectFile(proj); return; }
      const imgs = files.filter((f) => isImageFile(f) || isVideoFile(f)), auds = files.filter((f) => /^audio\//.test(f.type) || /\.(mp3|m4a|wav|ogg|flac)$/i.test(f.name));
      if (imgs.length) addPhotos(imgs); if (auds.length) addMusic(auds);
      if (!imgs.length && !auds.length) toast('사진, 동영상 또는 음악 파일을 놓아주세요.', true);
    });

    /* player */
    on('#btnPlay', 'click', togglePlay); on('#btnStop', 'click', () => stopPlayback(true)); on('#preview', 'click', togglePlay);
    on('#scrub', 'input', (e) => seek(+e.target.value / 1000 * S.tl.total));
    window.addEventListener('resize', () => { sizePreview(); drawFrame(); });

    /* stage options */
    on('#aspect', 'change', (e) => { p().aspect = e.target.value; sizePreview(); S.renderer.invalidate(); update(); });
    on('#fit', 'change', (e) => { p().fit = e.target.value; update(); });
    on('#kenBurns', 'change', (e) => { p().kenBurns = e.target.checked; update(); });
    on('#blurFill', 'change', (e) => { p().blurFill = e.target.checked; update(); });

    /* quick tab */
    on('#defaultDuration', 'change', (e) => { p().defaultDuration = RV.clamp(+e.target.value || 3, 0.5, 60); e.target.value = p().defaultDuration; update(); });
    on('#fitToMusic', 'change', (e) => { p().fitToMusic = e.target.checked; if (e.target.checked) { p().beatSync = false; $('#beatSync').checked = false; } update(); syncSlideControls(); });
    on('#beatSync', 'change', (e) => { p().beatSync = e.target.checked; if (e.target.checked) { p().fitToMusic = false; $('#fitToMusic').checked = false; } update(); syncSlideControls(); });
    const titleInputs = () => { const o = p().opening, en = p().ending; o.enabled = $('#openingOn').checked; o.title = $('#openingTitle').value; o.subtitle = $('#openingSub').value; en.enabled = $('#endingOn').checked; en.title = $('#endingTitle').value; en.subtitle = $('#endingSub').value; o.style = en.style = $('#titleStyle').value; o.duration = en.duration = RV.clamp(+$('#titleDuration').value || 3, 1, 15); update(); };
    const titleModel = () => { const o = p().opening, en = p().ending; o.title = $('#openingTitle').value; o.subtitle = $('#openingSub').value; en.title = $('#endingTitle').value; en.subtitle = $('#endingSub').value; };
    ['#openingOn', '#endingOn', '#titleStyle', '#titleDuration'].forEach((s) => on(s, 'input', titleInputs));
    ['#openingTitle', '#openingSub', '#endingTitle', '#endingSub'].forEach((s) => bindTyping(s, titleModel));
    /* show the card being edited, so the text appears in the preview as it is typed */
    const showCard = (key) => () => { const it = S.tl.byId[key]; if (it && !S.playing) seek(it.start + Math.min(0.9, it.duration / 2)); };
    ['#openingTitle', '#openingSub'].forEach((s) => on(s, 'focus', showCard('__opening'))); ['#endingTitle', '#endingSub'].forEach((s) => on(s, 'focus', showCard('__ending')));

    /* caption tab */
    bindTyping('#capText', (e) => { const s = selectedSlide(); if (s) s.caption.text = e.target.value; });
    on('#capFont', 'change', (e) => setCaption('font', e.target.value)); on('#capSize', 'change', (e) => setCaption('size', +e.target.value)); on('#capColor', 'input', (e) => setCaption('color', e.target.value));
    [['#capBold', 'bold'], ['#capItalic', 'italic'], ['#capShadow', 'shadow'], ['#capOutline', 'outline'], ['#capBox', 'box']].forEach(([sel, key]) => on(sel, 'click', () => { const s = selectedSlide(); const c = s ? s.caption : p().captionDefaults; setCaption(key, !c[key]); }));
    on('#capApplyAll', 'click', () => { const s = selectedSlide(); const src = s ? s.caption : p().captionDefaults; const keys = ['font', 'size', 'color', 'bold', 'italic', 'shadow', 'outline', 'box', 'pos', 'effect']; keys.forEach((k) => (p().captionDefaults[k] = src[k])); p().slides.forEach((x) => keys.forEach((k) => (x.caption[k] = src[k]))); update(); toast('자막 스타일을 모든 화면에 적용했습니다.'); });
    on('#slideDuration', 'change', (e) => { const s = selectedSlide(); if (!s) return; const v = parseFloat(e.target.value); s.duration = isFinite(v) && v > 0 ? RV.clamp(v, 0.5, 120) : null; update(); syncSlideControls(); });
    on('#slideDurationReset', 'click', () => { const s = selectedSlide(); if (s) { s.duration = null; update(); syncSlideControls(); } });
    ['#prevSlide', '#prevSlide2', '#prevSlide3'].forEach((s) => on(s, 'click', () => moveSelection(-1)));
    ['#nextSlide', '#nextSlide2', '#nextSlide3'].forEach((s) => on(s, 'click', () => moveSelection(1)));

    /* design tab */
    on('#bgColor', 'input', (e) => { p().bgColor = e.target.value; const s = selectedSlide(); if (s) s.bgStyle = 'custom'; else p().bgStyle = 'custom'; const tile = $('#bgGrid .tile[data-id=custom] canvas'); if (tile) RV.drawBackground(tile.getContext('2d'), 96, 54, 'custom', e.target.value); update(); syncSlideControls(); });
    on('#blurAmount', 'input', (e) => { p().blurAmount = +e.target.value; S.renderer.invalidate(); update(); });
    on('#blurDarken', 'input', (e) => { p().blurDarken = +e.target.value; S.renderer.invalidate(); update(); });
    on('#bgApplyAll', 'click', () => applyAll('bgStyle')); on('#frameApplyAll', 'click', () => applyAll('frame'));
    on('#trApplyAll', 'click', () => applyAll('transition')); on('#cineApplyAll', 'click', () => applyAll('cinematic'));
    on('#trDuration', 'input', (e) => { p().transitionDuration = +e.target.value; $('#trDurationVal').textContent = p().transitionDuration.toFixed(1) + '초'; update(); });
    on('#kbIntensity', 'input', (e) => { p().kbIntensity = +e.target.value; update(); });

    /* music tab */
    on('#musicVolume', 'input', (e) => { p().music.volume = +e.target.value; $('#musicVolumeVal').textContent = Math.round(p().music.volume * 100) + '%'; S.mixDirty = true; scheduleSave(); });
    on('#fadeIn', 'change', (e) => { p().music.fadeIn = Math.max(0, +e.target.value || 0); S.mixDirty = true; scheduleSave(); });
    on('#fadeOut', 'change', (e) => { p().music.fadeOut = Math.max(0, +e.target.value || 0); S.mixDirty = true; scheduleSave(); });
    on('#trimStart', 'change', (e) => { p().music.trimStart = Math.max(0, +e.target.value || 0); update(); });
    on('#musicLoop', 'change', (e) => { p().music.loop = e.target.checked; update(); });
    on('#duckVideo', 'change', (e) => { p().music.duckVideo = e.target.checked; S.mixDirty = true; scheduleSave(); });
    on('#duckLevel', 'input', (e) => { p().music.duckLevel = +e.target.value; $('#duckLevelVal').textContent = Math.round(p().music.duckLevel * 100) + '%'; S.mixDirty = true; scheduleSave(); });

    /* video trim */
    bindTrimmer();
    on('#vVolume', 'input', (e) => { const s = selectedSlide(); if (!s) return; s.volume = +e.target.value; $('#vVolumeVal').textContent = Math.round(s.volume * 100) + '%'; S.mixDirty = true; scheduleSave(); });
    on('#vMute', 'change', (e) => { const s = selectedSlide(); if (!s) return; s.muted = e.target.checked; S.mixDirty = true; scheduleSave(); });

    /* export modal */
    on('#exPreset', 'change', (e) => applyPreset(e.target.value));
    ['#exRes', '#exFps', '#exQuality'].forEach((s) => on(s, 'change', () => { $('#exPreset').value = 'custom'; refreshExportInfo(true); }));
    on('#exBitrate', 'change', () => refreshExportInfo(false));
    on('#exStart', 'click', startExport);
    on('#exShare', 'click', shareLastExport);
    on('#inAppOpen', 'click', openInBrowser);
    on('#btnSend', 'click', openSendPanel);
    on('#exDragFile', 'dragstart', (e) => { if (!lastExport) return; const f = lastExport.file; e.dataTransfer.effectAllowed = 'copy'; try { e.dataTransfer.setData('DownloadURL', (f.type || 'video/mp4') + ':' + f.name + ':' + lastExport.url); } catch (err) { /* ignore */ } });
    on('#btnMoveL', 'click', () => moveSlide(-1)); on('#btnMoveR', 'click', () => moveSlide(1));
    on('#btnStageOpts', 'click', (e) => { const onNow = document.body.classList.toggle('show-opts'); e.currentTarget.classList.toggle('on', onNow); sizePreview(); drawFrame(); });

    /* operator usage */
    on('#btnUsage', 'click', openUsage); on('#usLoad', 'click', loadUsage);
    /* bookmarkable shortcut for the operator: https://.../#usage */
    const usageByHash = () => { if (location.hash === '#usage') openUsage(); };
    window.addEventListener('hashchange', usageByHash); setTimeout(usageByHash, 0);
    on('#usAdmin', 'keydown', (e) => { if (e.key === 'Enter') loadUsage(); });

    /* AI music */
    on('#btnGenMusic', 'click', openMusicGen); on('#btnGenMusic2', 'click', openMusicGen);
    on('#mgStart', 'click', startMusicGen);
    on('#mgAdd', 'click', addGeneratedMusic);
    on('#mgRetry', 'click', () => { $('#mgAudio').pause(); mgShow('form'); });
    on('#mgCancel', 'click', () => { if (mgAbort) { mgAbort.abort(); return; } $('#mgAudio').pause(); closeModal('musicGenModal'); });
    on('#mgProvider', 'change', mgSyncProvider);
    on('#mgLyrics', 'input', (e) => { $('#mgLyricsCount').textContent = e.target.value.length + '자'; });
    on('#mgLyricsHelp', 'click', () => { $('#mgLyrics').value = SAMPLE_LYRICS; $('#mgLyricsCount').textContent = SAMPLE_LYRICS.length + '자'; if (!$('#mgStyle').value.trim()) $('#mgStyle').value = '따뜻한 어쿠스틱 기타와 피아노, 잔잔하고 감성적인 발라드'; });

    /* PWA install prompt */
    let installEvt = null;
    window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installEvt = e; $('#btnInstall').hidden = false; });
    on('#btnInstall', 'click', async () => { if (!installEvt) return; installEvt.prompt(); await installEvt.userChoice.catch(() => {}); installEvt = null; $('#btnInstall').hidden = true; });
    window.addEventListener('appinstalled', () => { $('#btnInstall').hidden = true; toast('홈 화면에 추가되었습니다.'); });
    on('#exCancel', 'click', () => { if (exportAbort) exportAbort.abort(); else closeModal('exportModal'); });
    on('#exClose', 'click', () => closeModal('exportModal'));
    on('#exDownload', 'click', () => { if (platform.mobile) toast(platform.ios ? '파일 앱 › 다운로드 폴더에 저장됩니다.' : '다운로드 폴더에 저장됩니다. (내 파일 앱 › 다운로드)'); });

    /* keyboard */
    window.addEventListener('keydown', (e) => {
      const tag = (e.target.tagName || '').toLowerCase();
      const typing = tag === 'input' || tag === 'textarea' || tag === 'select';
      if (e.ctrlKey && !e.altKey) {
        const k = e.key.toLowerCase();
        if (k === 's') { e.preventDefault(); saveProjectFile(); } else if (k === 'o') { e.preventDefault(); $('#fileProj').click(); } else if (k === 'e') { e.preventDefault(); openExport(); } else if (k === 'n') { e.preventDefault(); newProject(); }
        return;
      }
      if (e.key === 'F1') { e.preventDefault(); openModal('helpModal'); return; }
      if (e.key === 'Escape') { $$('.modal.open').forEach((m) => { if (m.id !== 'exportModal' || !exportAbort) m.classList.remove('open'); }); return; }
      if (typing) return;
      if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
      else if ((e.key === 'i' || e.key === 'I') && selectedSlide() && selectedSlide().type === 'video') RV.app.setFromPreview('in');
      else if ((e.key === 'o' || e.key === 'O') && selectedSlide() && selectedSlide().type === 'video') RV.app.setFromPreview('out');
      else if (e.key === 'ArrowLeft') moveSelection(-1); else if (e.key === 'ArrowRight') moveSelection(1);
      else if (e.key === 'Delete' || e.key === 'Backspace') deleteSelected();
      else if (e.key === 'Home') seek(0); else if (e.key === 'End') seek(S.tl.total);
    });
  }

  /* ---------------- boot ---------------- */
  async function init() {
    buildTiles(); bind();
    if ('serviceWorker' in navigator && /^https?:/.test(location.protocol)) {
      navigator.serviceWorker.register('sw.js').then((reg) => {
        reg.addEventListener('updatefound', () => {
          const w = reg.installing; if (!w) return;
          w.addEventListener('statechange', () => { if (w.state === 'installed' && navigator.serviceWorker.controller) toast('새 버전이 준비되었습니다. 새로고침하면 적용됩니다.'); });
        });
      }).catch(() => {});
    }
    S.project = RV.createProject();
    let saved = null;
    try { saved = await RV.store.loadProject(); } catch (e) { console.warn('IDB unavailable', e); }
    if (saved && saved.app === 'RuninqVic' && (saved.slides.length || saved.music.tracks.length)) {
      await setProject(saved, { skipSave: true });
      toast('이전 작업을 복원했습니다.');
    } else {
      syncAllControls(); update({ skipSave: true }); markSelection();
    }
    showInAppNotice();
  }
  window.addEventListener('DOMContentLoaded', init);

  /* debug/test hooks */
  RV.app = { S, addPhotos, addMusic, update, select, play, stopPlayback, seek, openExport, startExport, exportSettings, setProject, addTextSlide, platform, saveHintHtml, sendHintHtml, openSendPanel, getLastExport: () => lastExport, renderUsage, shareLastExport, renderSendPanel, setLastExport, openInBrowser, inApp: () => inApp };
})();
