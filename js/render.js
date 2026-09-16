/* RuninqVic - Renderer: (project, timeline, t) -> canvas frame. Shared by preview and export. */
(function (root) {
  const RV = (root.RV = root.RV || {});

  function mkCanvas(w, h) {
    const c = document.createElement('canvas'); c.width = w; c.height = h; return c;
  }

  class Renderer {
    constructor(w, h) {
      this.canvas = mkCanvas(w, h);
      this.ctx = this.canvas.getContext('2d', { alpha: false });
      this.offA = mkCanvas(w, h); this.offB = mkCanvas(w, h);
      this.blurCache = new Map();
      this.cineCache = {};
      this.W = w; this.H = h;
    }
    setSize(w, h) {
      if (w === this.W && h === this.H) return;
      this.W = w; this.H = h;
      [this.canvas, this.offA, this.offB].forEach((c) => { c.width = w; c.height = h; });
      this.blurCache.clear();
    }
    invalidate() { this.blurCache.clear(); }

    /* main entry */
    draw(project, tl, t, assets) {
      const ctx = this.ctx, W = this.W, H = this.H;
      const loc = RV.locate(tl, t);
      if (!loc) { ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H); return; }
      if (loc.a) {
        const ca = this.offA.getContext('2d', { alpha: false }), cb = this.offB.getContext('2d', { alpha: false });
        this.drawItem(ca, loc.a, loc.ua, t, project, assets);
        this.drawItem(cb, loc.b, loc.ub, t, project, assets);
        const type = RV.resolveTransition(RV.transitionOf(project, loc.b.slide), loc.b.slide.id);
        RV.drawTransition(ctx, W, H, this.offA, this.offB, type, loc.p);
      } else {
        this.drawItem(ctx, loc.b, loc.ub, t, project, assets);
      }
    }

    drawItem(ctx, item, u, t, project, assets) {
      const s = item.slide;
      if (s.type === 'title') this.drawTitle(ctx, s, u, t, item.duration, project, assets);
      else this.drawPhoto(ctx, s, u, t, item.duration, project, assets);
    }

    /* ---- photo / text slide ---- */
    drawPhoto(ctx, s, u, t, dur, project, assets) {
      const W = this.W, H = this.H;
      const img = s.assetId && assets.images.get(s.assetId);
      const bgStyle = s.bgStyle != null ? s.bgStyle : project.bgStyle;
      const frame = RV.frameById(s.frame != null ? s.frame : project.frame);
      const cine = s.cinematic != null ? s.cinematic : project.cinematic;
      const rect = RV.frameRect(frame, W, H);
      const fit = s.type === 'text' ? 'fit' : project.fit;

      /* 1. background */
      if (bgStyle && bgStyle !== 'none') RV.drawBackground(ctx, W, H, bgStyle, project.bgColor);
      else if (img && project.blurFill && fit !== 'fill') ctx.drawImage(this.blurredBg(img, s, project), 0, 0);
      else { ctx.fillStyle = project.bgColor || '#000'; ctx.fillRect(0, 0, W, H); }

      /* 2. frame base */
      if (frame.under) { ctx.save(); frame.under(ctx, W, H, rect); ctx.restore(); }

      /* 3. image with Ken Burns */
      if (img && img.bitmap) {
        ctx.save();
        RV.frameClip(ctx, frame, rect, W, H);
        const rot = ((s.rotation || 0) % 360 + 360) % 360;
        const swap = rot === 90 || rot === 270;
        const iw = swap ? img.height : img.width, ih = swap ? img.width : img.height;
        let scale;
        if (fit === 'fill') scale = Math.max(rect.w / iw, rect.h / ih);
        else if (fit === 'original') scale = Math.min(1, rect.w / iw, rect.h / ih) * (W / 1920);
        else scale = Math.min(rect.w / iw, rect.h / ih);
        const dw = iw * scale, dh = ih * scale;
        let z = 1, px = 0, py = 0;
        if (project.kenBurns && s.kb) {
          const e = RV.easeInOut(u), k = project.kbIntensity == null ? 1 : project.kbIntensity;
          z = 1 + (RV.lerp(s.kb.z0, s.kb.z1, e) - 1) * k;
          const slackX = Math.max(0, (dw * z - rect.w) / 2), slackY = Math.max(0, (dh * z - rect.h) / 2);
          px = RV.lerp(s.kb.x0, s.kb.x1, e) * slackX * k;
          py = RV.lerp(s.kb.y0, s.kb.y1, e) * slackY * k;
        }
        ctx.translate(rect.x + rect.w / 2 + px, rect.y + rect.h / 2 + py);
        ctx.scale(z, z);
        ctx.rotate(rot * Math.PI / 180);
        const bw = img.width * scale, bh = img.height * scale;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(img.bitmap, -bw / 2, -bh / 2, bw, bh);
        ctx.restore();
      } else if (!img && s.type === 'photo') {
        ctx.fillStyle = '#333'; ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
        ctx.fillStyle = '#888'; ctx.font = Math.round(Math.min(W, H) * 0.04) + 'px "맑은 고딕", sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText('사진을 불러올 수 없습니다', W / 2, H / 2);
      }

      /* 4. frame overlay */
      if (frame.over) { ctx.save(); frame.over(ctx, W, H, rect); ctx.restore(); }

      /* 5. cinematic */
      RV.drawCinematic(ctx, W, H, cine, t, this.cineCache);

      /* 6. caption */
      if (s.caption && s.caption.text) this.drawCaption(ctx, s.caption, u, dur, rect);
    }

    blurredBg(img, s, project) {
      const W = this.W, H = this.H;
      const rot = ((s.rotation || 0) % 360 + 360) % 360;
      const key = s.assetId + '|' + rot + '|' + W + 'x' + H + '|' + project.blurAmount + '|' + project.blurDarken;
      let c = this.blurCache.get(key);
      if (c) return c;
      c = mkCanvas(W, H);
      const x = c.getContext('2d');
      const swap = rot === 90 || rot === 270;
      const iw = swap ? img.height : img.width, ih = swap ? img.width : img.height;
      const sc = Math.max(W / iw, H / ih) * 1.15;
      x.save();
      x.filter = 'blur(' + Math.round((project.blurAmount || 40) * (W / 1920)) + 'px)';
      x.translate(W / 2, H / 2); x.rotate(rot * Math.PI / 180);
      x.drawImage(img.bitmap, -img.width * sc / 2, -img.height * sc / 2, img.width * sc, img.height * sc);
      x.restore();
      x.fillStyle = 'rgba(0,0,0,' + (project.blurDarken == null ? 0.35 : project.blurDarken) + ')';
      x.fillRect(0, 0, W, H);
      if (this.blurCache.size > 14) this.blurCache.delete(this.blurCache.keys().next().value);
      this.blurCache.set(key, c);
      return c;
    }

    /* ---- opening / ending ---- */
    drawTitle(ctx, s, u, t, dur, project, assets) {
      const W = this.W, H = this.H, S = Math.min(W, H), sc = S / 1080;
      const src = s.src || {}, style = src.style || 'classic';
      const photos = project.slides.filter((p) => p.type === 'photo' && p.assetId);
      const ref = s.role === 'opening' ? photos[0] : photos[photos.length - 1];
      const img = ref && assets.images.get(ref.assetId);
      const tIn = Math.min(0.8, dur * 0.3), tOut = Math.min(0.6, dur * 0.25);
      const tl = u * dur;
      const alpha = Math.min(1, tl / tIn, (dur - tl) / tOut);

      if (style === 'minimal') { ctx.fillStyle = '#f7f7f5'; ctx.fillRect(0, 0, W, H); }
      else if (img && img.bitmap) {
        ctx.drawImage(this.blurredBg(img, ref, Object.assign({}, project, { blurDarken: 0.6 })), 0, 0);
      } else RV.drawBackground(ctx, W, H, 'night');

      if (style === 'cinematic') { ctx.fillStyle = '#000'; const bar = H * 0.12; ctx.fillRect(0, 0, W, bar); ctx.fillRect(0, H - bar, W, bar); }

      const title = src.title || '', sub = src.subtitle || '';
      const titleColor = style === 'minimal' ? '#222' : (style === 'cinematic' ? '#f1d27a' : '#fff');
      const subColor = style === 'minimal' ? '#666' : 'rgba(255,255,255,0.85)';
      const family = style === 'cinematic' ? '"바탕", "Georgia", serif' : '"맑은 고딕", "Segoe UI", sans-serif';
      ctx.save();
      ctx.globalAlpha = Math.max(0, alpha);
      ctx.translate(W / 2, H / 2);
      const grow = style === 'cinematic' ? 1 : 1.06 - 0.06 * RV.easeOut(Math.min(1, tl / Math.max(tIn, 0.01)));
      ctx.scale(grow, grow);
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      if (style !== 'minimal') { ctx.shadowColor = 'rgba(0,0,0,0.6)'; ctx.shadowBlur = 24 * sc; ctx.shadowOffsetY = 4 * sc; }
      const tsize = Math.round((title.length > 14 ? 72 : 96) * sc);
      ctx.font = (style === 'cinematic' ? '' : 'bold ') + tsize + 'px ' + family;
      if (style === 'cinematic') ctx.letterSpacing = Math.round(tsize * 0.25) + 'px';
      const lines = this.wrap(ctx, title, W * 0.85);
      const lh = tsize * 1.25; const total = lines.length * lh + (sub ? tsize * 0.6 + tsize * 0.5 : 0);
      let y = -total / 2 + lh / 2;
      ctx.fillStyle = titleColor;
      lines.forEach((ln) => { ctx.fillText(ln, 0, y); y += lh; });
      ctx.letterSpacing = '0px';
      if (style === 'minimal') { ctx.fillStyle = '#e8562a'; ctx.fillRect(-40 * sc, y - lh / 2 + 6 * sc, 80 * sc, 4 * sc); y += 20 * sc; }
      if (sub) {
        const ssize = Math.round(tsize * 0.42); ctx.font = ssize + 'px ' + family; ctx.fillStyle = subColor;
        const sl = this.wrap(ctx, sub, W * 0.8); y += ssize * 0.4;
        sl.forEach((ln) => { ctx.fillText(ln, 0, y); y += ssize * 1.4; });
      }
      ctx.restore();
      RV.drawCinematic(ctx, W, H, project.cinematic, t, this.cineCache);
    }

    wrap(ctx, text, maxW) {
      const out = [];
      for (const para of String(text).split(/\r?\n/)) {
        const words = para.split(' '); let line = '';
        for (const w of words) {
          const test = line ? line + ' ' + w : w;
          if (ctx.measureText(test).width <= maxW || !line) {
            if (ctx.measureText(test).width > maxW && !line) {
              /* long word: split by char */
              let cur = '';
              for (const ch of w) { if (ctx.measureText(cur + ch).width > maxW && cur) { out.push(cur); cur = ch; } else cur += ch; }
              line = cur;
            } else line = test;
          } else { out.push(line); line = w; }
        }
        out.push(line);
      }
      return out;
    }

    /* ---- captions ---- */
    drawCaption(ctx, cap, u, dur, rect) {
      const W = this.W, H = this.H, sc = Math.min(W, H) / 1080;
      const size = Math.round((cap.size || 48) * sc);
      const tl = u * dur;
      const effect = cap.effect || 'none';
      let alpha = 1, dy = 0, scale = 1, text = cap.text;
      const fIn = Math.min(0.6, dur * 0.25), fOut = Math.min(0.5, dur * 0.2);
      if (effect === 'fade' || effect === 'rise' || effect === 'zoom') {
        alpha = RV.clamp(Math.min(tl / fIn, (dur - tl) / fOut), 0, 1);
        if (effect === 'rise') dy = (1 - RV.easeOut(RV.clamp(tl / fIn, 0, 1))) * 60 * sc;
        if (effect === 'zoom') scale = 0.8 + 0.2 * RV.easeOut(RV.clamp(tl / fIn, 0, 1));
      } else if (effect === 'typewriter') {
        const n = Math.floor(RV.clamp(tl / Math.min(dur * 0.6, cap.text.length * 0.08), 0, 1) * cap.text.length);
        text = cap.text.slice(0, n);
        alpha = RV.clamp((dur - tl) / fOut, 0, 1);
        if (!text) return;
      }
      if (alpha <= 0) return;
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.font = (cap.italic ? 'italic ' : '') + (cap.bold ? 'bold ' : '') + size + 'px "' + (cap.font || '맑은 고딕') + '", "맑은 고딕", sans-serif';
      const lines = this.wrap(ctx, text, W * 0.88);
      const lh = size * 1.3, blockH = lines.length * lh;
      const pos = cap.pos || 'bc';
      const mX = W * 0.05, mY = H * 0.06;
      const col = pos[1], row = pos[0];
      let x, align;
      if (col === 'l') { x = mX + (cap.box ? size * 0.4 : 0); align = 'left'; } else if (col === 'r') { x = W - mX - (cap.box ? size * 0.4 : 0); align = 'right'; } else { x = W / 2; align = 'center'; }
      let y;
      if (row === 't') y = mY + lh / 2; else if (row === 'm') y = H / 2 - blockH / 2 + lh / 2; else y = H - mY - blockH + lh / 2;
      ctx.textAlign = align; ctx.textBaseline = 'middle';
      ctx.translate(x, y + dy); ctx.scale(scale, scale);
      if (cap.box) {
        ctx.fillStyle = 'rgba(0,0,0,0.55)';
        lines.forEach((ln, i) => {
          const w = ctx.measureText(ln).width + size * 0.8;
          const bx = align === 'left' ? -size * 0.4 : align === 'right' ? -w + size * 0.4 : -w / 2;
          ctx.fillRect(bx, i * lh - lh / 2 + size * 0.08, w, lh - size * 0.1);
        });
      }
      if (cap.shadow) { ctx.shadowColor = 'rgba(0,0,0,0.8)'; ctx.shadowBlur = 10 * sc; ctx.shadowOffsetX = 2 * sc; ctx.shadowOffsetY = 3 * sc; }
      lines.forEach((ln, i) => {
        if (cap.outline) { ctx.lineJoin = 'round'; ctx.lineWidth = Math.max(2, size * 0.1); ctx.strokeStyle = 'rgba(0,0,0,0.9)'; ctx.strokeText(ln, 0, i * lh); }
        ctx.fillStyle = cap.color || '#fff';
        ctx.fillText(ln, 0, i * lh);
      });
      ctx.restore();
    }
  }

  RV.Renderer = Renderer;
})(typeof window !== 'undefined' ? window : globalThis);
