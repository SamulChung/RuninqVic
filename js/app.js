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

  async function makeImageAsset(blob) {
    let bmp = await createImageBitmap(blob, { imageOrientation: 'from-image' });
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
    return { bitmap: v, video: v, url, width: v.videoWidth, height: v.videoHeight, duration: v.duration, thumb: c.toDataURL('image/jpeg', 0.8), audioBuffer };
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
    $('#welcome').style.display = (p.slides.length || p.opening.enabled || p.ending.enabled) && S.tl.items.length ? 'none' : '';
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
      await drawFrame(); highlightCurrent();
      if (S.playing) S.raf = requestAnimationFrame(loop);
    };
    S.raf = requestAnimationFrame(loop);
  }
  function stopPlayback(reset) {
    S.playing = false; cancelAnimationFrame(S.raf); RV.audio.stop(); pauseVideos(); $('#btnPlay').textContent = '▶';
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
      d.onclick = () => select(s.id, true);
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
  }
  function select(id, doSeek) {
    S.selectedId = id; markSelection(); syncSlideControls();
    const it = S.tl.byId[id];
    if (doSeek && it) seek(Math.min(it.end - 0.05, it.start + it.trIn + Math.min(0.7, it.duration * 0.3)));
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
      const src = +s.srcDuration || 0, inPt = Math.max(0, +s.in || 0), outPt = (s.out && s.out > inPt) ? Math.min(s.out, src) : src;
      ['#vInRange', '#vOutRange'].forEach((sel) => { $(sel).max = src.toFixed(1); });
      $('#vIn').max = src.toFixed(1); $('#vOut').max = src.toFixed(1);
      $('#vInRange').value = inPt.toFixed(1); $('#vOutRange').value = outPt.toFixed(1);
      $('#vIn').value = inPt.toFixed(1); $('#vOut').value = outPt.toFixed(1);
      $('#vSrcLen').textContent = '(원본 ' + RV.fmtTime(src, true) + ')';
      $('#vLen').textContent = '구간 ' + (outPt - inPt).toFixed(1) + '초';
      const sel = $('#vSel'); sel.style.left = (src ? inPt / src * 100 : 0) + '%'; sel.style.width = (src ? (outPt - inPt) / src * 100 : 100) + '%';
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
  let exportAbort = null, exportCaps = null;
  async function openExport() {
    if (!S.tl.items.length) { toast('먼저 사진을 추가하세요.', true); return; }
    stopPlayback(false);
    const p = S.project;
    $('#exName').value = p.export.name || p.name || '내 영상';
    $('#exRes').value = p.export.res; $('#exFps').value = String(p.export.fps); $('#exQuality').value = p.export.quality;
    $('#exPreset').value = 'pc';
    $('#exportForm').hidden = false; $('#exportProgress').hidden = true; $('#exportDone').hidden = true;
    $('#exStart').hidden = false; $('#exClose').hidden = true; $('#exCancel').hidden = false; $('#exStart').disabled = false;
    openModal('exportModal');
    refreshExportInfo();
    if (!exportCaps) exportCaps = await RV.exportCapabilities();
    refreshExportInfo();
  }
  function applyPreset(v) {
    const map = { pc: ['1080p', 30, 'high'], youtube: ['1080p', 30, 'high'], sns: ['720p', 30, 'medium'], '4k': ['2160p', 30, 'high'] };
    if (map[v]) { $('#exRes').value = map[v][0]; $('#exFps').value = String(map[v][1]); $('#exQuality').value = map[v][2]; }
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
    if (resetBitrate || !$('#exBitrate').value) $('#exBitrate').value = (RV.suggestBitrate(es.w, es.h, es.fps, es.quality) / 1e6).toFixed(0);
    const es2 = exportSettings();
    const mb = (es2.bitrate + 192000) * S.tl.total / 8 / 1048576;
    let codec = '코덱 확인 중…';
    if (exportCaps) codec = exportCaps.ok ? ('코덱: ' + exportCaps.video + (exportCaps.audio ? ' + ' + exportCaps.audio : ' (오디오 인코더 없음)') + ' → ' + exportCaps.container.toUpperCase()) : exportCaps.reason;
    $('#exInfo').innerHTML = '해상도 <b>' + es2.w + ' × ' + es2.h + '</b> · ' + es2.fps + ' fps · 길이 ' + RV.fmtTime(S.tl.total) + ' · 예상 용량 약 <b>' + (mb < 1 ? mb.toFixed(2) : mb.toFixed(0)) + ' MB</b><br>' + codec + (window.showSaveFilePicker ? '' : '<br>저장 위치를 물어볼 수 없는 브라우저라 다운로드 폴더에 저장됩니다.');
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
      if (r.blob) { a.href = URL.createObjectURL(r.blob); a.download = fname; a.hidden = false; a.textContent = fname + ' 다운로드 (' + (r.blob.size / 1048576).toFixed(1) + ' MB)'; $('#exDoneMsg').textContent = '동영상이 완성되었습니다! (' + secs + '초 소요)'; }
      else { a.hidden = true; $('#exDoneMsg').textContent = fname + ' 파일로 저장했습니다. (' + secs + '초 소요, ' + r.video + (r.audio ? ' + ' + r.audio : '') + ')'; }
      toast('동영상 만들기 완료');
    } catch (e) {
      console.error(e);
      $('#exportProgress').hidden = true; $('#exportForm').hidden = false; $('#exStart').hidden = false;
      if (e.name === 'AbortError') toast('동영상 만들기를 취소했습니다.'); else toast('오류: ' + (e.message || e), true);
    } finally { exportAbort = null; }
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
    $$('.tabs button').forEach((b) => (b.onclick = () => showTab(b.dataset.tab)));
    $$('[data-close]').forEach((b) => (b.onclick = () => closeModal(b.dataset.close)));
    on('#btnGoDetail', 'click', () => showTab('caption'));
    on('#btnHelp', 'click', () => openModal('helpModal'));

    /* files */
    on('#btnAddPhotos', 'click', () => $('#filePhotos').click()); on('#btnAddPhotos2', 'click', () => $('#filePhotos').click());
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
    ['#openingOn', '#openingTitle', '#openingSub', '#endingOn', '#endingTitle', '#endingSub', '#titleStyle', '#titleDuration'].forEach((s) => on(s, 'input', titleInputs));

    /* caption tab */
    on('#capText', 'input', (e) => { const s = selectedSlide(); if (!s) return; s.caption.text = e.target.value; update(); });
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
    const setTrim = (inPt, outPt, seekPreview) => {
      const s = selectedSlide(); if (!s || s.type !== 'video') return;
      const src = +s.srcDuration || 0;
      inPt = RV.clamp(+inPt || 0, 0, Math.max(0, src - 0.5));
      outPt = RV.clamp(+outPt || src, inPt + 0.5, src);
      s.in = Math.round(inPt * 10) / 10; s.out = outPt >= src - 0.05 ? 0 : Math.round(outPt * 10) / 10;
      update(); syncSlideControls();
      const it = S.tl.byId[s.id];
      if (it && seekPreview === 'in') seek(it.start + it.trIn + 0.01); else if (it && seekPreview === 'out') seek(Math.max(it.start, it.end - 0.05));
    };
    on('#vInRange', 'input', (e) => setTrim(e.target.value, $('#vOutRange').value, 'in'));
    on('#vOutRange', 'input', (e) => setTrim($('#vInRange').value, e.target.value, 'out'));
    on('#vIn', 'change', (e) => setTrim(e.target.value, $('#vOut').value, 'in'));
    on('#vOut', 'change', (e) => setTrim($('#vIn').value, e.target.value, 'out'));
    on('#vReset', 'click', () => { const s = selectedSlide(); if (s) setTrim(0, s.srcDuration, 'in'); });
    on('#vVolume', 'input', (e) => { const s = selectedSlide(); if (!s) return; s.volume = +e.target.value; $('#vVolumeVal').textContent = Math.round(s.volume * 100) + '%'; S.mixDirty = true; scheduleSave(); });
    on('#vMute', 'change', (e) => { const s = selectedSlide(); if (!s) return; s.muted = e.target.checked; S.mixDirty = true; scheduleSave(); });

    /* export modal */
    on('#exPreset', 'change', (e) => applyPreset(e.target.value));
    ['#exRes', '#exFps', '#exQuality'].forEach((s) => on(s, 'change', () => { $('#exPreset').value = 'custom'; refreshExportInfo(true); }));
    on('#exBitrate', 'change', () => refreshExportInfo(false));
    on('#exStart', 'click', startExport);
    on('#exCancel', 'click', () => { if (exportAbort) exportAbort.abort(); else closeModal('exportModal'); });
    on('#exClose', 'click', () => closeModal('exportModal'));

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
      else if (e.key === 'ArrowLeft') moveSelection(-1); else if (e.key === 'ArrowRight') moveSelection(1);
      else if (e.key === 'Delete' || e.key === 'Backspace') deleteSelected();
      else if (e.key === 'Home') seek(0); else if (e.key === 'End') seek(S.tl.total);
    });
  }

  /* ---------------- boot ---------------- */
  async function init() {
    buildTiles(); bind();
    S.project = RV.createProject();
    let saved = null;
    try { saved = await RV.store.loadProject(); } catch (e) { console.warn('IDB unavailable', e); }
    if (saved && saved.app === 'RuninqVic' && (saved.slides.length || saved.music.tracks.length)) {
      await setProject(saved, { skipSave: true });
      toast('이전 작업을 복원했습니다.');
    } else {
      syncAllControls(); update({ skipSave: true }); markSelection();
    }
  }
  window.addEventListener('DOMContentLoaded', init);

  /* debug/test hooks */
  RV.app = { S, addPhotos, addMusic, update, select, play, stopPlayback, seek, openExport, startExport, exportSettings, setProject, addTextSlide };
})();
