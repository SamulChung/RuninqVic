/* node tests/proxy.test.js - pure helpers of api/music.js */
const assert = require('assert');
const { clampSongLength, safeEqual, rateLimited, tooManyBadTries, serverKey, BAD_TRIES_10MIN } = require('../api/music.js')._internals;
const total = (txt, key) => JSON.parse(txt).composition_plan[key].reduce((a, c) => a + c.duration_ms, 0);

// prompt mode: music_length_ms clamped; missing or string lengths are pinned to the cap
assert.strictEqual(JSON.parse(clampSongLength(JSON.stringify({ prompt: 'x', music_length_ms: 300000 }), 120)).music_length_ms, 120000);
assert.strictEqual(JSON.parse(clampSongLength(JSON.stringify({ prompt: 'x', music_length_ms: 60000 }), 120)).music_length_ms, 60000);
assert.strictEqual(JSON.parse(clampSongLength(JSON.stringify({ prompt: 'x' }), 120)).music_length_ms, 120000);
assert.strictEqual(JSON.parse(clampSongLength(JSON.stringify({ prompt: 'x', music_length_ms: '600000' }), 120)).music_length_ms, 120000);
// plan mode: scaled to the cap, never below 3s per part
const plan = { composition_plan: { chunks: [{ duration_ms: 90000 }, { duration_ms: 90000 }, { duration_ms: 60000 }] } };
const out = JSON.parse(clampSongLength(JSON.stringify(plan), 120)).composition_plan.chunks.map((c) => c.duration_ms);
assert.ok(out.reduce((a, b) => a + b, 0) <= 120000, 'scaled total ' + out); assert.ok(out.every((d) => d >= 3000));
assert.strictEqual(JSON.parse(clampSongLength(JSON.stringify({ composition_plan: { sections: [{ duration_ms: 200000 }] } }), 120)).composition_plan.sections[0].duration_ms, 120000);
// regression: many minimum-length parts plus a few long ones must still fit the cap (the 3s floor used to push totals ~70% over)
for (const cap of [30, 120, 300]) {
  const n = Math.floor(cap / 3); const parts = Array.from({ length: n }, (_, i) => ({ duration_ms: i < 5 ? 120000 : 3000 }));
  const txt = clampSongLength(JSON.stringify({ composition_plan: { sections: parts } }), cap);
  assert.ok(txt && total(txt, 'sections') <= cap * 1000, 'cap ' + cap + ' total ' + (txt && total(txt, 'sections')));
  assert.ok(JSON.parse(txt).composition_plan.sections.every((c) => c.duration_ms >= 3000));
}
// a body carrying both lists keeps only one, so the cap cannot be doubled; extra-cost options are dropped
const both = JSON.parse(clampSongLength(JSON.stringify({ store_for_inpainting: true, finetune_id: 'x', composition_plan: { chunks: [{ duration_ms: 120000 }], sections: [{ duration_ms: 120000 }] } }), 120));
assert.ok(both.composition_plan.chunks && !both.composition_plan.sections); assert.ok(!('store_for_inpainting' in both) && !('finetune_id' in both));
// anything that is not a JSON object is rejected
assert.strictEqual(clampSongLength('not json', 120), null); assert.strictEqual(clampSongLength('[1]', 120), null);
assert.strictEqual(clampSongLength(JSON.stringify({ composition_plan: { chunks: 'x' } }), 120), null);
// codes
assert.ok(safeEqual('수업2026', '수업2026')); assert.ok(!safeEqual('수업2026', '수업2027')); assert.ok(!safeEqual('', 'x'));
assert.ok(safeEqual('수업2026'.normalize('NFD'), '수업2026'.normalize('NFC')), 'NFC/NFD');
// key sanitising: wrapped keys work, unusable values read as "not registered" (so they can never reach an error message)
process.env.ELEVENLABS_API_KEY = 'sk_abcdefghijklmnop\n qrstuvwxyz012345  '; assert.strictEqual(serverKey(), 'sk_abcdefghijklmnopqrstuvwxyz012345');
process.env.ELEVENLABS_API_KEY = 'sk_한글이섞인키abcdefghijklmnop'; assert.strictEqual(serverKey(), '');
process.env.ELEVENLABS_API_KEY = ''; assert.strictEqual(serverKey(), '');
// open mode (no lecture code): 6 songs per IP per 10 minutes
let blocked = 0; for (let i = 0; i < 8; i++) if (rateLimited('1.2.3.4')) blocked++;
assert.strictEqual(blocked, 2); assert.ok(!rateLimited('5.6.7.8'));
// wrong-code throttle: generous enough for a classroom sharing one IP, then blocked; other IPs unaffected
for (let i = 0; i < BAD_TRIES_10MIN; i++) { assert.ok(!tooManyBadTries('9.9.9.9', false)); tooManyBadTries('9.9.9.9', true); }
assert.ok(!tooManyBadTries('9.9.9.9', false)); tooManyBadTries('9.9.9.9', true);
assert.ok(tooManyBadTries('9.9.9.9', false)); assert.ok(!tooManyBadTries('8.8.8.8', false));
console.log('proxy tests passed');
