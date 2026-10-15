/* RuninqVic - mobile version (phones): step-by-step screens ① 사진 ② 음악 ③ 제목 ④ 완성.
   It runs on the same engine and the same controls as the PC version: the preview, the music and title blocks
   and the work panel (as the 꾸미기 sheet) are moved into the mobile screens, so every feature keeps working. */
(function () {
  const RV = (window.RV = window.RV || {});
  const root = document.documentElement;
  const $ = (s, el) => (el || document).querySelector(s);
  const $$ = (s, el) => Array.from((el || document).querySelectorAll(s));

  /* switch between the PC and the mobile version; the work is shared (same browser storage) */
  RV.switchUI = async function (mode) {
    try { localStorage.setItem('rv.ui', mode); } catch (e) { /* the ?ui= parameter still carries the choice */ }
    try { if (RV.app && RV.app.S && RV.app.S.project && RV.store) await RV.store.saveProject(RV.app.S.project); } catch (e) { /* ignore */ }
    location.replace(location.pathname + '?ui=' + mode);
  };
  if (!root.classList.contains('m-ui')) return;

  /* landscape = how the phone is held; with interactive-widget=resizes-content the keyboard shrinks the viewport,
     which would flip an (orientation: landscape) media query on an upright phone */
  const setLand = () => {
    const t = screen.orientation && screen.orientation.type;
    root.classList.toggle('m-land', t ? t.indexOf('landscape') === 0 : typeof window.orientation === 'number' ? Math.abs(window.orientation) === 90 : innerWidth > innerHeight);
  };
  setLand(); window.addEventListener('resize', setLand);
  if (screen.orientation && screen.orientation.addEventListener) screen.orientation.addEventListener('change', setLand);

  /* ---------- move the shared parts into the mobile screens (before the app starts) ---------- */
  const move = (node, slot) => { if (node && slot) slot.appendChild(node); };
  move($('#projName'), $('#mNameSlot'));
  move($('section.stage'), $('#mStage'));
  move($('#qsMusic'), $('#mMusicSlot'));
  move($('#qsDuration'), $('#mDurationSlot'));
  move($('#qsTitles'), $('#mTitlesSlot'));
  move($('aside.panel'), $('#mSheetBody'));
  const sw = $('#btnUiSwitch'); if (sw) sw.textContent = '🖥 PC 버전';

  const app = () => RV.app;
  const S = () => RV.app.S;
  const ready = () => !!(RV.app && RV.app.S && RV.app.S.project && RV.app.S.tl);
  const relayout = () => window.dispatchEvent(new Event('resize'));
  const toast = (m, e) => (app() && app().toast ? app().toast(m, e) : null);
  const hasWork = () => S().project.slides.length > 0 || RV.titleMedia(S().project).length > 0;
  const body = $('#mBody'), sheet = $('#mSheet'), menu = $('#mMenu'), scrim = $('#mScrim'), appEl = $('#mApp');

  /* ---------- history: the phone's Back button closes what is open, then walks back through the steps ----------
     Entries: one per step (the entry k-1 places above the first is step k), plus one on top while the menu, the sheet,
     a dialog or hand placement is open. */
  let ignorePop = 0, step = 1, unwinding = false;
  const isOverlay = (s) => !!(s && (s.sheet || s.modal || s.menu || s.place));
  const push = (extra, s) => { try { history.pushState(Object.assign({ rv: 1, step: s || step }, extra || {}), ''); } catch (e) { /* ignore */ } };
  const backSilently = (n) => { ignorePop++; history.go(-(n || 1)); };
  /* end hand placement and reuse its history entry for what opens next (avoids a back + push race) */
  function takeOverPlaceEntry(extra) {
    const onPlace = placePushed && !!(history.state && history.state.place);
    if (S().placing && app().setPlacing) app().setPlacing(false);
    placePushed = false;
    if (!onPlace) return false;
    try { history.replaceState(Object.assign({ rv: 1, step }, extra), ''); } catch (e) { /* ignore */ }
    return true;
  }
  const onPlainStepEntry = () => { const st = history.state; return !!(st && st.rv && st.step === step && !st.sheet && !st.modal && !st.menu && !st.place); };

  /* ---------- steps ---------- */
  const NEXT_LABEL = { 1: '다음: 음악 ›', 2: '다음: 제목 ›', 3: '다음: 완성 ›', 4: '🎬 영상 만들기' };
  function showStep(n) {
    step = n;
    $$('.m-page').forEach((p) => p.classList.toggle('on', +p.dataset.step === n));
    $$('#mSteps button').forEach((b) => b.classList.toggle('on', +b.dataset.step === n));
    $('#mNav').classList.toggle('first', n === 1);
    $('#mNext').textContent = NEXT_LABEL[n];
    body.scrollTop = 0; appEl.scrollTop = 0;
  }
  function go(n, fromHistory) {
    n = Math.max(1, Math.min(4, n));
    if (!ready()) return;
    /* going back walks over the existing entries, so Back afterwards keeps going back (popstate draws the step) */
    if (!fromHistory && n < step && onPlainStepEntry()) { history.go(n - step); return; }
    if (S().placing && app().setPlacing) { placePushed = false; app().setPlacing(false); }
    const from = step;
    showStep(n);
    if (!fromHistory && n > from) for (let k = from + 1; k <= n; k++) push(null, k);
    /* show what the step is about in the preview */
    const p = S().project;
    if (n === 3) { if (p.opening.enabled) app().selectTitle('opening', true); else if (p.ending.enabled) app().selectTitle('ending', true); }
    else if (n === 1) { if (!app().selectedSlide() && p.slides.length) app().select(p.slides[0].id, true); }
    else if (n === 4) app().seek(0);
    render();
  }
  function next() {
    if (step === 4) { make(); return; }
    if (step === 1 && !hasWork()) { toast('사진이나 동영상을 먼저 골라 주세요.', true); return; }
    go(step + 1);
  }
  $('#mNext').onclick = next;
  $('#mPrev').onclick = () => go(step - 1);
  $$('#mSteps button').forEach((b) => (b.onclick = () => go(+b.dataset.step)));

  /* ---------- step 1: photos ---------- */
  $('#mAddPhotos').onclick = () => $('#filePhotosOnly').click();
  $('#mAddVideos').onclick = () => $('#fileVideosOnly').click();
  $('#mAddText').onclick = () => {
    if (!ready()) return;
    app().addTextSlide();   /* inserted after the selected one and selected */
    openSheet('caption');
    const t = $('#capText'); if (t) { t.focus(); t.select(); }
  };
  $('#mSort').onchange = (e) => { if (e.target.value) app().sortSlides(e.target.value); e.target.value = ''; };

  let lastSel = null, lastIdx = -1;
  function renderGrid() {
    const p = S().project, tl = S().tl, sel = S().selectedId;
    const frag = document.createDocumentFragment();
    p.slides.forEach((s, i) => {
      const it = tl.byId[s.id], a = s.assetId && S().assets.images.get(s.assetId);
      const b = document.createElement('button');
      b.className = 'm-tile' + (s.id === sel ? ' sel' : ''); b.dataset.id = s.id;
      b.setAttribute('aria-label', (i + 1) + '번 ' + (s.type === 'video' ? '동영상' : s.type === 'text' ? '글자 화면' : '사진'));
      if (s.type !== 'text' && a && a.thumb) {
        const img = document.createElement('img'); img.src = a.thumb; img.alt = ''; img.decoding = 'async';
        if (s.rotation) img.style.transform = 'rotate(' + s.rotation + 'deg)';
        b.appendChild(img);
      } else {
        const d = document.createElement('div'); d.className = 'm-tt';
        d.textContent = s.type === 'text' ? ((s.caption && s.caption.text) || '텍스트') : '불러올 수 없음';
        b.appendChild(d);
      }
      b.insertAdjacentHTML('beforeend', '<span class="n">' + (i + 1) + '</span>' + (it ? '<span class="d">' + it.duration.toFixed(1) + '초</span>' : '') +
        (s.type === 'video' ? '<span class="v">▶</span>' + (a && a.thumbDark ? '<span class="vt">🎬</span>' : '') : '') + (s.caption && s.caption.text && s.type !== 'text' ? '<span class="c">자막</span>' : ''));
      b.onclick = () => app().select(s.id, true);
      frag.appendChild(b);
    });
    $('#mGrid').replaceChildren(frag);
    const vids = p.slides.filter((s) => s.type === 'video').length;
    $('#mPhotoCount').textContent = '사진 ' + (p.slides.length - vids) + '장' + (vids ? ' · 동영상 ' + vids + '개' : '') + ' · ' + RV.fmtTime(tl.total);
    $('#mEmpty').hidden = p.slides.length > 0;
    $('#mSort').hidden = p.slides.length < 2;
    const s = app().selectedSlide();
    $('#mSelBar').hidden = !s;
    if (s) {
      const i = p.slides.indexOf(s);
      $('#mSelBar [data-act=left]').disabled = i <= 0;
      $('#mSelBar [data-act=right]').disabled = i >= p.slides.length - 1;
      $('#mSelBar [data-act=rotate]').disabled = s.type === 'text';
      $('#mDecorLbl').textContent = s.type === 'video' ? '자르기' : '꾸미기'; $('#mDecorIco').textContent = s.type === 'video' ? '✂' : '✏';
      /* keep the selected photo in view, also while it is moved with ◀ ▶ */
      if ((sel !== lastSel || i !== lastIdx) && step === 1 && sheet.hidden) { const tile = $('#mGrid .m-tile.sel'); if (tile) tile.scrollIntoView({ block: 'nearest' }); }
      lastIdx = i;
    } else lastIdx = -1;
    lastSel = sel;
  }
  $('#mSelBar').onclick = (e) => {
    const b = e.target.closest('button'); if (!b || b.disabled) return;
    const act = b.dataset.act;
    if (act === 'left') app().moveSlide(-1);
    else if (act === 'right') app().moveSlide(1);
    else if (act === 'rotate') app().rotateSelected(90);
    else if (act === 'decor') openSheet('caption');
    else if (act === 'delete') { const s = app().selectedSlide(); if (s && confirm((s.type === 'video' ? '이 동영상을' : s.type === 'text' ? '이 글자 화면을' : '이 사진을') + ' 영상에서 뺄까요?')) app().deleteSelected(); }
  };

  /* ---------- step 4: finish ---------- */
  $('#mQuality').onchange = () => $$('#mQuality .m-q').forEach((l) => l.classList.toggle('on', l.querySelector('input').checked));
  function renderFinish() {
    const p = S().project, tl = S().tl;
    const vids = p.slides.filter((s) => s.type === 'video').length, photos = p.slides.length - vids;
    const ml = RV.audio.musicLength(p, S().assets);
    $('#mSummary').innerHTML = '<div><b>' + photos + (vids ? '+' + vids : '') + '</b><span>사진' + (vids ? '+동영상' : '') + '</span></div>' +
      '<div><b>' + p.music.tracks.length + '곡</b><span>음악 ' + RV.fmtTime(ml) + '</span></div>' +
      '<div><b>' + RV.fmtTime(tl.total) + '</b><span>영상 길이</span></div>';
    const notes = [];
    if (!hasWork()) notes.push('아직 사진이 없습니다. 1단계에서 사진을 골라 주세요.');
    if (!p.music.tracks.length) notes.push('음악 없이 만들어집니다. 2단계에서 음악을 넣을 수 있습니다.');
    $('#mNotes').innerHTML = notes.join('<br>');
    $('#mResend').hidden = !app().getLastExport();
  }
  async function make() {
    if (!S().tl.items.length || !hasWork()) { toast('사진을 먼저 골라 주세요.', true); go(1); return; }
    const q = $('#mQuality input:checked'), preset = q ? q.value : 'kakao';
    await app().openExport(preset);
    if (!$('#exportModal').classList.contains('open') || $('#exStart').disabled) return;   /* not supported on this phone: the dialog says why */
    app().startExport();
  }
  $('#mResend').onclick = () => app().openSendPanel();
  $('#mDecorAll').onclick = () => { app().select(null, false); openSheet('fx', '전체 꾸미기 (모든 화면)'); };

  /* ---------- 꾸미기 sheet: fills the space under the preview ---------- */
  let bodyScroll = 0, appScroll = 0;
  function openSheet(tab, title) {
    const p = S().project, s = app().selectedSlide();
    const wasOpen = !sheet.hidden;
    let replaced = false;
    if (!wasOpen) replaced = takeOverPlaceEntry({ sheet: 1 });
    else if (S().placing && app().setPlacing) { const onPlace = !!(history.state && history.state.place); placePushed = false; app().setPlacing(false); if (onPlace) backSilently(); }
    $('#mSheetTitle').textContent = title || (s ? (p.slides.indexOf(s) + 1) + '번 ' + (s.type === 'video' ? '동영상' : s.type === 'text' ? '글자 화면' : '사진') + ' 꾸미기' : '전체 꾸미기 (모든 화면)');
    if (!wasOpen) { bodyScroll = body.scrollTop; appScroll = appEl.scrollTop; }
    sheet.hidden = false; root.classList.add('m-sheet-open');
    if (!wasOpen) appEl.scrollTop = 0;
    app().showTab(tab || 'caption');
    if (!wasOpen && !replaced) push({ sheet: 1 });
    relayout();
  }
  function closeSheet(fromHistory) {
    if (sheet.hidden) return;
    const el = document.activeElement; if (el && sheet.contains(el)) el.blur();
    /* entries to drop: the sheet's, plus hand placement's when it was started inside the sheet */
    let n = 0;
    if (!fromHistory) { const st = history.state || {}; n = st.place ? 2 : st.sheet ? 1 : 0; }
    if (S().placing && app().setPlacing) { placePushed = false; app().setPlacing(false); }
    sheet.hidden = true; root.classList.remove('m-sheet-open');
    body.scrollTop = bodyScroll; appEl.scrollTop = appScroll;
    if (n) backSilently(n);
    relayout(); render();
  }
  $('#mSheetDone').onclick = () => closeSheet(false);

  /* ---------- menu ---------- */
  const closeMenu = (fromHistory) => {
    if (menu.hidden) return;
    menu.hidden = true; scrim.hidden = true;
    if (fromHistory !== true && history.state && history.state.menu) backSilently();
  };
  $('#mMenuBtn').onclick = () => {
    if (!menu.hidden) { closeMenu(); return; }
    const inst = $('#btnInstall'); $('#mMenu [data-m=install]').hidden = !inst || inst.hidden;
    menu.hidden = false; scrim.hidden = false;
    if (!takeOverPlaceEntry({ menu: 1 })) push({ menu: 1 });
  };
  scrim.onclick = () => closeMenu();
  menu.onclick = (e) => {
    const b = e.target.closest('button'); if (!b) return;
    const m = b.dataset.m, inMenu = !!(history.state && history.state.menu);
    menu.hidden = true; scrim.hidden = true;
    /* a dialog opened from the menu takes over the menu's history entry */
    const dialog = { help: 'helpModal', usage: 'usageModal' }[m];
    if (dialog && inMenu) { try { history.replaceState(Object.assign({}, history.state, { menu: 0, modal: dialog }), ''); } catch (err) { /* ignore */ } modalPushed = dialog; }
    /* run the action inside the tap (file pickers, new windows and install need it), then drop the menu entry */
    if (m === 'new') {
      const before = S().project; $('#btnNew').click();
      setTimeout(() => {
        if (S().project === before) return;
        if (!sheet.hidden) {
          const st = history.state || {}, d = st.place ? 2 : st.sheet ? 1 : 0;
          closeSheet(true);
          const k = 1 - step - d;
          if (k) { history.go(k); return; }   /* popstate on the first entry draws step 1 */
        }
        go(1);
      }, 600);
    }
    else if (m === 'open') $('#btnOpen').click();
    else if (m === 'save') $('#btnSave').click();
    else if (m === 'help') $('#btnHelp').click();
    else if (m === 'manual') window.open('manual.html', '_blank', 'noopener');
    else if (m === 'install') $('#btnInstall').click();
    else if (m === 'usage') $('#btnUsage').click();
    else if (m === 'pc') { RV.switchUI('pc'); return; }   /* switchUI drops every app entry itself */
    if (!dialog && inMenu) backSilently();
  };

  /* ---------- dialogs: Back closes an open dialog, but never one that is still working ---------- */
  let modalPushed = null;
  const exporting = () => $('#exportModal').classList.contains('open') && !$('#exportProgress').hidden;
  const composing = () => $('#musicGenModal').classList.contains('open') && !$('#mgProgress').hidden;
  const watchModals = new MutationObserver(() => {
    const open = $('.modal.open');
    if (open && !modalPushed) {
      modalPushed = open.id;
      const onMenu = !menu.hidden && !!(history.state && history.state.menu);
      if (!menu.hidden) { menu.hidden = true; scrim.hidden = true; }
      if (onMenu) { try { history.replaceState(Object.assign({}, history.state, { menu: 0, modal: open.id }), ''); } catch (e) { /* ignore */ } }
      else push({ modal: open.id });
    }
    else if (!open && modalPushed) { modalPushed = null; if (history.state && history.state.modal) backSilently(); }
    if (!open) schedule();   /* e.g. the finished video's "다시 보내기" button on step ④ */
  });
  $$('.modal').forEach((m) => watchModals.observe(m, { attributes: true, attributeFilter: ['class'] }));

  /* ---------- hand placement (✥) also gets an entry, so Back ends it ---------- */
  let placePushed = false;
  new MutationObserver(() => {
    const on = document.body.classList.contains('placing');
    if (on && !placePushed) { placePushed = true; push({ place: 1 }); }
    else if (!on && placePushed) { placePushed = false; if (history.state && history.state.place) backSilently(); }
  }).observe(document.body, { attributes: true, attributeFilter: ['class'] });

  window.addEventListener('popstate', (e) => {
    if (ignorePop) {
      ignorePop--;
      if (unwinding) { if (isOverlay(e.state)) { ignorePop++; history.back(); } else unwinding = false; }
      return;
    }
    const st = e.state || {};
    if (modalPushed) {
      if (exporting() || composing()) {
        push({ modal: modalPushed });
        toast(composing() ? '음악을 만드는 중입니다. 끝날 때까지 기다리거나 [중단]을 눌러 주세요.' : '영상을 만드는 중입니다. 끝날 때까지 기다리거나 [취소]를 눌러 주세요.');
        return;
      }
      modalPushed = null;
      const mga = $('#mgAudio'); if (mga && !mga.paused) mga.pause();
      $$('.modal.open').forEach((m) => m.classList.remove('open'));
      return;
    }
    if (!menu.hidden) { closeMenu(true); return; }
    if (placePushed && !st.place) { placePushed = false; if (app().setPlacing) app().setPlacing(false); return; }
    if (!sheet.hidden && !st.sheet) { closeSheet(true); return; }
    if (st.rv && st.step && st.step !== step) go(st.step, true);
  });

  /* ---------- typing in a step page: keep the field above the keyboard ---------- */
  const isText = (el) => !!el && (el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && /^(text|search|number)?$/i.test(el.getAttribute('type') || '')));
  body.addEventListener('focusin', (e) => {
    if (!isText(e.target)) return;
    if (!root.classList.contains('m-typing')) { root.classList.add('m-typing'); relayout(); }
    setTimeout(() => { if (document.activeElement === e.target) e.target.scrollIntoView({ block: 'center' }); }, 320);
  });
  body.addEventListener('focusout', () => {
    setTimeout(() => {
      const el = document.activeElement;
      if (!(isText(el) && body.contains(el)) && root.classList.contains('m-typing')) { root.classList.remove('m-typing'); relayout(); }
    }, 140);
  });
  if (window.visualViewport) {
    let low = 0;
    window.visualViewport.addEventListener('resize', () => {
      if (!root.classList.contains('m-typing')) { low = 0; return; }
      const h = window.visualViewport.height; low = low ? Math.min(low, h) : h;
      if (h > low + 150) { low = 0; const el = document.activeElement; if (el && body.contains(el)) el.blur(); }   /* keyboard closed with Back */
    });
  }

  /* ---------- keep the screens in step with the app ---------- */
  let raf = 0;
  function render() {
    if (!ready()) return;
    const p = S().project;
    renderGrid();
    if (step === 4) renderFinish();
    const done = { 1: p.slides.length > 0, 2: p.music.tracks.length > 0, 3: !!(p.opening.enabled && (p.opening.title || p.opening.media)) || !!(p.ending.enabled && (p.ending.title || p.ending.media)) };
    $$('#mSteps button').forEach((b) => b.classList.toggle('done', !!done[+b.dataset.step] && +b.dataset.step !== step));
  }
  function schedule() { if (raf) return; raf = requestAnimationFrame(() => { raf = 0; render(); }); }
  ['rv:update', 'rv:select', 'rv:sync'].forEach((ev) => document.addEventListener(ev, schedule));
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape') { if (!menu.hidden) closeMenu(); else if (!$('.modal.open')) closeSheet(false); } });

  /* ---------- start: keep the step after a reload, drop a stale entry of something that was open ---------- */
  const st0 = history.state;
  if (st0 && st0.rv) {
    showStep(Math.max(1, Math.min(4, st0.step || 1)));
    if (isOverlay(st0)) { unwinding = true; ignorePop++; history.back(); }
  } else {
    showStep(1);
    try { history.replaceState({ rv: 1, step: 1 }, ''); } catch (e) { /* ignore */ }
  }
  const baseSwitch = RV.switchUI;
  RV.switchUI = async function (mode) {
    try { localStorage.setItem('rv.ui', mode); } catch (e) { /* ignore */ }
    const st = history.state || {};
    /* app entries above the first: one per step after ①, the sheet's, placement's, a dialog's and the menu's */
    const d = st.rv ? (st.step || 1) - 1 + (sheet.hidden ? 0 : 1) + (placePushed ? 1 : 0) + (st.modal ? 1 : 0) + (st.menu ? 1 : 0) : 0;
    if (d > 0) await new Promise((res) => {
      const t = setTimeout(res, 700);
      window.addEventListener('popstate', () => { clearTimeout(t); res(); }, { once: true });
      ignorePop++; history.go(-d);
    });
    return baseSwitch(mode);   /* saves, then location.replace() replaces the first entry */
  };
  RV.mobile = { go, openSheet, closeSheet, step: () => step };
})();
