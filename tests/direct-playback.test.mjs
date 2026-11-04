import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test } from 'node:test';

const root = process.env.IMMICH_SOURCE ? resolve(process.env.IMMICH_SOURCE) : fileURLToPath(new URL('../overlays/', import.meta.url));
const { monitorDirectPlayback } = await import(pathToFileURL(resolve(root, 'web/src/lib/utils/direct-playback.ts')));

function setup(t, paused = false) {
  let now = 0;
  let serial = 0;
  const timers = new Map();
  t.mock.method(performance, 'now', () => now);
  t.mock.method(globalThis, 'setInterval', (callback) => { timers.set(++serial, callback); return serial; });
  t.mock.method(globalThis, 'clearInterval', (id) => timers.delete(id));
  const video = Object.assign(new EventTarget(), {
    paused, ended: false, seeking: false, currentTime: 0, duration: 120, readyState: 4, playbackRate: 1,
    ranges: [[0, 10]],
    get buffered() { return this.ranges; },
  });
  Object.defineProperty(video, 'buffered', {
    get: () => ({ length: video.ranges.length, start: (i) => video.ranges[i][0], end: (i) => video.ranges[i][1] }),
  });
  let fallbacks = 0;
  const cleanup = monitorDirectPlayback(video, () => fallbacks++);
  t.after(cleanup);
  return {
    video, timers, cleanup,
    fallbackCount: () => fallbacks,
    event(name) { video.dispatchEvent(new Event(name)); },
    tick(position = video.currentTime) {
      video.currentTime = position;
      now += 1000;
      for (const sample of [...timers.values()]) sample();
    },
  };
}

test('direct monitor survives ready/playing and stops on pause, resumes once and cleans up', (t) => {
  const h = setup(t, true);
  assert.equal(h.timers.size, 0);
  h.video.paused = false;
  h.event('play');
  h.event('canplay');
  h.event('playing');
  assert.equal(h.timers.size, 1);
  h.video.paused = true;
  h.event('pause');
  assert.equal(h.timers.size, 0);
  h.event('playing');
  assert.equal(h.timers.size, 0, 'a stale playing event cannot restart a paused monitor');
  h.video.paused = false;
  h.event('play');
  h.event('playing');
  assert.equal(h.timers.size, 1);
  h.cleanup();
  h.event('play');
  assert.equal(h.timers.size, 0);
});

test('healthy direct playback has no fallback or duplicate timer', (t) => {
  const h = setup(t);
  for (let i = 0; i < 20; i++) {
    h.video.ranges = [[0, i + 10]];
    h.tick(i);
    h.event('playing');
  }
  assert.equal(h.fallbackCount(), 0);
  assert.equal(h.timers.size, 1);
});

test('a consistently draining short buffer falls back once before starvation', (t) => {
  const h = setup(t);
  h.tick(0);
  h.video.ranges = [[0, 3.5]];
  h.tick(1);
  assert.equal(h.fallbackCount(), 0);
  h.tick(2);
  assert.equal(h.fallbackCount(), 1);
  assert.equal(h.timers.size, 0);
  h.event('play');
  h.tick(3);
  assert.equal(h.fallbackCount(), 1);
});

test('one slow download, seeking and the final buffered seconds do not trigger fallback', (t) => {
  const h = setup(t);
  h.tick(0);
  h.video.ranges = [[0, 3]];
  h.tick(1);
  h.video.ranges = [[0, 10]];
  h.tick(2);
  h.video.seeking = true;
  h.event('seeking');
  h.video.readyState = 1;
  for (let i = 0; i < 6; i++) h.tick(50);
  h.video.seeking = false;
  h.video.ranges = [[50, 120]];
  for (let i = 0; i < 6; i++) h.tick(118);
  assert.equal(h.fallbackCount(), 0);
});

test('a sustained unbuffered stall falls back after four seconds, not on waiting alone', (t) => {
  const h = setup(t);
  h.video.ranges = [[30, 40]];
  h.video.readyState = 2;
  h.event('waiting');
  for (let i = 0; i < 4; i++) h.tick();
  assert.equal(h.fallbackCount(), 0);
  h.tick();
  assert.equal(h.fallbackCount(), 1);
});

test('paused and ended direct videos release the timer without fallback', (t) => {
  const h = setup(t);
  h.video.readyState = 1;
  h.tick();
  h.video.paused = true;
  h.event('pause');
  for (let i = 0; i < 10; i++) h.tick();
  h.video.paused = false;
  h.event('play');
  h.video.ended = true;
  h.event('ended');
  assert.equal(h.timers.size, 0);
  assert.equal(h.fallbackCount(), 0);
});
