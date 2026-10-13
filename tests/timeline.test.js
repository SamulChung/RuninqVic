/* node tests/timeline.test.js */
const assert = require('assert');
require('../js/state.js');
require('../js/timeline.js');
const RV = globalThis.RV;

function proj(n, over) {
  const p = RV.createProject();
  p.opening.enabled = false; p.ending.enabled = false;
  for (let i = 0; i < n; i++) p.slides.push(RV.createSlide({ name: 'p' + i }));
  return Object.assign(p, over || {});
}

// 1. basic: 3 slides of 3s, crossfade 0.8 => total 9 - 1.6 = 7.4
{
  const tl = RV.computeTimeline(proj(3));
  assert.strictEqual(tl.items.length, 3);
  assert.ok(Math.abs(tl.total - 7.4) < 1e-9, 'total ' + tl.total);
  assert.strictEqual(tl.items[0].start, 0);
  assert.ok(Math.abs(tl.items[1].start - 2.2) < 1e-9);
  assert.ok(Math.abs(tl.items[1].trIn - 0.8) < 1e-9);
}
// 2. no transition
{
  const tl = RV.computeTimeline(proj(3, { transition: 'none' }));
  assert.strictEqual(tl.total, 9);
}
// 3. transition clamped to half of shortest
{
  const p = proj(2, { defaultDuration: 1, transitionDuration: 2 });
  const tl = RV.computeTimeline(p);
  assert.ok(Math.abs(tl.items[1].trIn - 0.5) < 1e-9);
}
// 4. opening/ending included
{
  const p = proj(2); p.opening.enabled = true; p.ending.enabled = true;
  const tl = RV.computeTimeline(p);
  assert.strictEqual(tl.items.length, 4);
  assert.strictEqual(tl.items[0].slide.role, 'opening');
  assert.strictEqual(tl.items[3].slide.role, 'ending');
}
// 5. fit to music
{
  const p = proj(5, { fitToMusic: true });
  const tl = RV.computeTimeline(p, { musicLength: 60 });
  assert.ok(Math.abs(tl.total - 60) < 0.01, 'fit total ' + tl.total);
}
// 6. beat sync produces total == music length and boundaries on beats
{
  const beats = []; for (let t = 0.5; t < 30; t += 0.5) beats.push(t);
  const p = proj(6, { beatSync: true, transition: 'none' });
  const tl = RV.computeTimeline(p, { musicLength: 30, beats });
  assert.ok(Math.abs(tl.total - 30) < 0.01, 'beat total ' + tl.total);
  for (let i = 1; i < tl.items.length; i++) {
    const s = tl.items[i].start;
    const near = beats.some((b) => Math.abs(b - s) < 1e-6);
    assert.ok(near, 'boundary ' + s + ' not on beat');
  }
}
// 7. locate: inside transition
{
  const tl = RV.computeTimeline(proj(3));
  const l = RV.locate(tl, 2.6); // slide1 starts 2.2, trIn .8 -> p = .5
  assert.strictEqual(l.b.index, 1); assert.strictEqual(l.a.index, 0);
  assert.ok(Math.abs(l.p - 0.5) < 1e-9);
  const l2 = RV.locate(tl, 4); assert.strictEqual(l2.a, null); assert.strictEqual(l2.b.index, 1);
  const l3 = RV.locate(tl, 100); assert.strictEqual(l3.b.index, 2);
}
// 8. per-slide duration override
{
  const p = proj(2, { transition: 'none' }); p.slides[0].duration = 5;
  assert.strictEqual(RV.computeTimeline(p).total, 8);
}
console.log('timeline tests passed');

// 9. video clip: duration = out - in, not rescaled by fit-to-music
{
  const p = proj(3, { fitToMusic: true, transition: 'none' });
  p.slides[1].type = 'video'; p.slides[1].srcDuration = 20; p.slides[1].in = 2; p.slides[1].out = 8;
  const tl = RV.computeTimeline(p, { musicLength: 30 });
  assert.strictEqual(tl.items[1].duration, 6);
  assert.ok(Math.abs(tl.total - 30) < 0.01, 'video fit total ' + tl.total);
  assert.ok(Math.abs(tl.items[0].duration - 12) < 0.01, 'photos share the rest: ' + tl.items[0].duration);
}
// 10. video with out=0 uses source end; beat sync keeps clip length
{
  const beats = []; for (let t = 0.5; t < 40; t += 0.5) beats.push(t);
  const p = proj(3, { beatSync: true, transition: 'none' });
  p.slides[0].type = 'video'; p.slides[0].srcDuration = 10; p.slides[0].in = 0; p.slides[0].out = 0;
  const tl = RV.computeTimeline(p, { musicLength: 40, beats });
  assert.strictEqual(tl.items[0].duration, 10);
  assert.ok(Math.abs(tl.total - 40) < 0.01, 'beat total ' + tl.total);
  assert.ok(Math.abs(tl.items[1].start - 10) < 1e-9, 'video boundary at clip end');
}
console.log('video timeline tests passed');

// 11. a video on the opening/ending: the card lasts the clip length and is not rescaled
{
  const p = proj(2, { fitToMusic: true, transition: 'none' });
  p.opening.enabled = true; p.ending.enabled = true; p.opening.duration = 3; p.ending.duration = 3;
  p.opening.media = { id: '__opening', type: 'video', assetId: 'v1', srcDuration: 30, in: 4, out: 12, volume: 1, muted: false, fit: 'cover' };
  p.ending.media = { id: '__ending', type: 'photo', assetId: 'i1', fit: 'logo' };
  const tl = RV.computeTimeline(p, { musicLength: 40 });
  assert.strictEqual(tl.items[0].slide.id, '__opening');
  assert.strictEqual(tl.items[0].duration, 8, 'opening = clip length');
  assert.strictEqual(RV.videoOf(tl.items[0].slide), p.opening.media);
  assert.strictEqual(RV.videoOf(tl.items[3].slide), null, 'a photo on the ending is not a video');
  assert.ok(Math.abs(tl.total - 40) < 0.01, 'fit total ' + tl.total);
  assert.deepStrictEqual(RV.titleMedia(p).map((m) => m.assetId), ['v1', 'i1']);
  // without an asset id the media is ignored
  p.opening.media.assetId = ''; assert.strictEqual(RV.computeTimeline(p, { musicLength: 40 }).items[0].slide.media, null);
}
console.log('title media timeline tests passed');
// 12. beat sync keeps a trailing clip (ending video) at its trimmed length
{
  const beats = []; for (let t = 0.5; t < 60; t += 0.5) beats.push(t);
  for (const [n, L] of [[10, 44], [10, 60], [30, 40], [45, 40]]) {
    const p = proj(n, { beatSync: true, transition: 'none' });
    p.ending.enabled = true; p.ending.media = { id: '__ending', type: 'video', assetId: 'v', srcDuration: 60, in: 0, out: 12 };
    const tl = RV.computeTimeline(p, { musicLength: L, beats });
    assert.strictEqual(tl.items[tl.items.length - 1].duration, 12, n + ' photos / ' + L + ' s: ending ' + tl.items[tl.items.length - 1].duration);
  }
}
// 13. text window: long ending video shows its words at the end, opening at the start
{
  const mk = (role) => ({ role, src: { duration: 3 }, media: { type: 'video' } });
  assert.deepStrictEqual(RV.titleTextWindow(mk('opening'), 10), [0, 3]);
  assert.deepStrictEqual(RV.titleTextWindow(mk('ending'), 10), [7, 10]);
  assert.deepStrictEqual(RV.titleTextWindow(mk('ending'), 3.2), [0, 3.2]);
  assert.deepStrictEqual(RV.titleTextWindow({ role: 'opening', src: { duration: 3 }, media: { type: 'photo' } }, 3), [0, 3]);
}
console.log('title media review tests passed');
