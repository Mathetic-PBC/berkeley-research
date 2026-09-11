const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const script = fs.readFileSync(path.join(__dirname, '../fellowship/fellowship.js'), 'utf8');

function page({ blocked = false, reduced = false } = {}) {
  const video = new EventTarget();
  Object.assign(video, {
    paused: true, autoplay: true, muted: false, attempts: 0,
    play() {
      this.attempts++;
      if (blocked) return Promise.reject(new DOMException('Autoplay requires a gesture', 'NotAllowedError'));
      this.paused = false;
      return Promise.resolve();
    },
    pause() { this.paused = true; },
    load() { this.paused = true; },
  });
  const motion = Object.assign(new EventTarget(), { matches: reduced });
  const portrait = Object.assign(new EventTarget(), { matches: true });
  const document = Object.assign(new EventTarget(), { hidden: false, getElementById: () => video });
  const window = Object.assign(new EventTarget(), {
    matchMedia: query => query.includes('reduced-motion') ? motion : portrait,
  });
  vm.runInNewContext(script, { window, document });
  return {
    video, document, window, motion,
    gesture(type) {
      blocked = false;
      document.dispatchEvent(new Event(type));
    },
  };
}

for (const gesture of ['touchend', 'pointerup', 'keydown']) {
  test(`a ${gesture} starts the video after the browser rejects autoplay`, async () => {
    const p = page({ blocked: true });
    await Promise.resolve();
    assert.equal(p.video.paused, true);
    p.gesture(gesture);
    assert.equal(p.video.paused, false);
    const attempts = p.video.attempts;
    p.gesture(gesture);
    assert.equal(p.video.attempts, attempts, 'interactions must not restart an already playing video');
  });
}

test('returning from the back-forward cache resumes a browser-paused video', () => {
  const p = page();
  assert.equal(p.video.paused, false);
  p.video.paused = true;
  p.window.dispatchEvent(new Event('pageshow'));
  assert.equal(p.video.paused, false);
});

test('recovery events still respect reduced motion and hidden tabs', () => {
  const p = page({ reduced: true });
  p.gesture('touchend');
  p.video.dispatchEvent(new Event('canplay'));
  p.window.dispatchEvent(new Event('pageshow'));
  assert.equal(p.video.attempts, 0);
  assert.equal(p.video.autoplay, false);
  p.motion.matches = false;
  p.document.hidden = true;
  p.motion.dispatchEvent(new Event('change'));
  p.gesture('pointerup');
  assert.equal(p.video.attempts, 0);
});
