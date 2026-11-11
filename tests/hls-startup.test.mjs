import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { adaptiveHlsConfig, attachAdaptivePlayback } from '../overlays/web/src/lib/utils/adaptive-playback.ts';

// Actual pinned Immich hls.js controllers, with a memory-only master loader.
globalThis.self = globalThis;
globalThis.location = { href: 'https://cloud.test/' };
globalThis.MediaSource = { isTypeSupported: () => true };
globalThis.window = new EventTarget();
globalThis.document = Object.assign(new EventTarget(), { hidden: false });
const Hls = createRequire(import.meta.url)('hls.js');

async function startup(bandwidth, { legacy = false, afterStart, mixedCodecs = false } = {}) {
  const requests = [];
  const master = '#EXTM3U\n' + [400_000, 800_000, 2_000_000, 4_000_000, 8_000_000].map((bps, i) =>
    `#EXT-X-STREAM-INF:BANDWIDTH=${bps},RESOLUTION=${[854, 1280, 1920, 2560, 3840][i]}x${[480, 720, 1080, 1440, 2160][i]},CODECS="${mixedCodecs && i === 4 ? 'hvc1.2.4.L153.B0' : 'avc1.640028'}"\n${i}.m3u8${i === 4 ? '?original=1' : ''}\n`).join('');
  class Loader {
    constructor() { this.stats = { aborted: false, loaded: 0, total: 0, retry: 0,
      loading: { start: 1, first: 2, end: 3 }, parsing: { start: 0, end: 0 }, buffering: { start: 0, first: 0, end: 0 } }; }
    load(context, _config, callbacks) {
      requests.push(context.url);
      if (context.type === 'manifest') queueMicrotask(() => callbacks.onSuccess({ url: context.url, data: master }, this.stats, context, {}));
    }
    abort() { this.stats.aborted = true; }
    destroy() {}
  }
  const hls = new Hls({ ...(legacy ? {} : adaptiveHlsConfig), loader: Loader, enableWorker: false, autoStartLoad: false });
  const video = Object.assign(new EventTarget(), { paused: false, ended: false, seeking: false, currentTime: 0,
    buffered: { length: 1, start: () => 0, end: () => 12 }, videoWidth: 0, videoHeight: 0 });
  let cleanup = () => {};
  try {
    hls.on(Hls.Events.MANIFEST_PARSED, () => {
      if (!legacy) cleanup = attachAdaptivePlayback(hls, video, 'https://cloud.test/main.m3u8', bandwidth);
      else { hls.bandwidthEstimate = bandwidth; hls.startLevel = -1; }
      hls.startLoad();
    });
    hls.loadSource('https://cloud.test/main.m3u8');
    await new Promise((resolve) => setTimeout(resolve, 20));
    const extra = await afterStart?.(hls, video);
    return { requests, bitrateTest: hls.streamController.bitrateTest, auto: hls.autoLevelEnabled, extra };
  } finally { cleanup(); hls.destroy(); }
}

test('negative control: default startup still cold-starts the lowest bandwidth test on a fast link', async () => {
  const result = await startup(90_000_000, { legacy: true });
  assert.equal(result.requests.at(-1), 'https://cloud.test/0.m3u8');
  assert.equal(result.bitrateTest, true);
});
test('fast measured Auto starts Original directly without starting the low-quality test encoder', async () => {
  const result = await startup(90_000_000);
  assert.equal(result.requests.at(-1), 'https://cloud.test/4.m3u8?original=1');
  assert.equal(result.bitrateTest, false);
  assert.equal(result.auto, true);
  assert.equal(result.requests.includes('https://cloud.test/0.m3u8'), false);
});
test('slow or unavailable measurements start conservatively while leaving native Auto enabled', async () => {
  for (const bandwidth of [0, 500_000]) {
    const result = await startup(bandwidth);
    assert.equal(result.requests.at(-1), 'https://cloud.test/0.m3u8');
    assert.equal(result.auto, true);
  }
});
test('fast Auto starts a supported Main10 Original instead of the preferred H.264 codec tier', async () => {
  const result = await startup(90_000_000, { mixedCodecs: true });
  assert.equal(result.requests.at(-1), 'https://cloud.test/4.m3u8?original=1');
  assert.equal(result.auto, true);
});
test('a Main10 Original is not forced on a connection that only affords H.264', async () => {
  const result = await startup(4_000_000, { mixedCodecs: true });
  assert.equal(result.requests.at(-1), 'https://cloud.test/2.m3u8');
  assert.equal(result.auto, true);
});
test('a middle-speed connection starts an affordable resolution instead of forcing Original', async () => {
  const result = await startup(4_000_000);
  assert.equal(result.requests.at(-1), 'https://cloud.test/2.m3u8');
  assert.equal(result.auto, true);
});
for (const mixedCodecs of [false, true]) test(`subsequent slow transfers trigger native downshifts (${mixedCodecs ? 'Main10 Original' : 'H.264'})`, async () => {
  const result = await startup(90_000_000, { mixedCodecs, afterStart(hls) {
    const initial = hls.nextAutoLevel;
    for (let i = 0; i < 4; i++) {
      const frag = { type: 'main', sn: i, level: 4, bitrate: 8_000_000, duration: 2,
        stats: { loaded: 100000, loading: { start: 100, first: 200, end: 15100 }, parsing: { end: 15100 } } };
      hls.abrController.onFragLoaded(Hls.Events.FRAG_LOADED, { frag });
      hls.abrController.onFragBuffered(Hls.Events.FRAG_BUFFERED, { frag });
    }
    return { initial, next: hls.nextAutoLevel };
  } });
  assert.equal(result.extra.initial, 4);
  assert.equal(result.extra.next, 0);
  assert.equal(result.auto, true);
});

test('the pinned element downgrade notification cannot silently pin native Auto', async () => {
  const result = await startup(90_000_000, { afterStart(hls) {
    hls.on(Hls.Events.LEVEL_SWITCHED, () => { hls.nextLevel = 1; });
    hls.trigger(Hls.Events.LEVEL_SWITCHED, { level: 1 });
    return hls.manualLevel;
  } });
  assert.equal(result.extra, -1);
  assert.equal(result.auto, true);
});

test('manual choices use native scheduled switching without an immediate flush or playhead change', async () => {
  for (const paused of [false, true]) {
    const result = await startup(90_000_000, { afterStart(hls, video) {
      let scheduled = 0, immediate = 0;
      hls.streamController.nextLevelSwitch = () => scheduled++;
      hls.streamController.immediateLevelSwitch = () => immediate++;
      video.currentTime = 12.25;
      video.paused = paused;
      hls.nextLevel = 2;
      assert.equal(hls.manualLevel, 2);
      hls.nextLevel = 4;
      return { scheduled, immediate, manual: hls.manualLevel, time: video.currentTime, paused: video.paused };
    } });
    assert.deepEqual(result.extra, { scheduled: 2, immediate: 0, manual: 4, time: 12.25, paused });
  }
});

test('measured recovery expedites native Auto only when playback can safely improve', async () => {
  const fetcher = globalThis.fetch;
  globalThis.fetch = async (url) => ({ ok: true, headers: { get: () => null },
    arrayBuffer: async () => new ArrayBuffer(Number(new URL(url).searchParams.get('bytes'))) });
  try {
    for (const mode of ['playing', 'paused', 'seeking', 'short-buffer', 'top', 'capped', 'expensive', 'manual']) {
      const result = await startup(500_000, { async afterStart(hls, video) {
        let switches = 0;
        hls.streamController.nextLevelSwitch = () => switches++;
        Object.defineProperty(hls, 'currentLevel', { value: mode === 'top' ? 4 : 0 });
        if (mode === 'paused') video.paused = true;
        if (mode === 'seeking') video.seeking = true;
        if (mode === 'short-buffer') video.buffered.end = () => 2;
        if (mode === 'capped') hls.autoLevelCapping = 0;
        if (mode === 'expensive') Object.defineProperty(hls.levels[1], 'maxBitrate', { value: 200_000_000 });
        hls.nextLevel = -1;
        if (mode === 'manual') hls.nextLevel = 1;
        const manualSwitches = switches;
        await new Promise((resolve) => setTimeout(resolve, 0));
        return { switches: switches - manualSwitches, manual: hls.manualLevel };
      } });
      assert.equal(result.extra.switches, mode === 'playing' ? 1 : 0, mode);
      assert.equal(result.extra.manual, mode === 'manual' ? 1 : -1, 'recovery must retain Auto or a later manual choice');
    }
  } finally { globalThis.fetch = fetcher; }
});

test('fast recovery can cross from AVC back to Main10 Original without a manual pin or bypassing decoder caps', async () => {
  const fetcher = globalThis.fetch;
  globalThis.fetch = async (url) => ({ ok: true, headers: { get: () => null },
    arrayBuffer: async () => new ArrayBuffer(Number(new URL(url).searchParams.get('bytes'))) });
  try {
    for (const cap of [-1, 2]) {
      const result = await startup(500_000, { mixedCodecs: true, async afterStart(hls) {
        Object.defineProperty(hls, 'currentLevel', { value: 0 });
        hls.abrController.lastLoadedFragLevel = 0;
        hls.streamController.nextLevelSwitch = () => {};
        hls.autoLevelCapping = cap;
        hls.nextLevel = -1;
        await new Promise((resolve) => setTimeout(resolve, 0));
        return { next: hls.nextAutoLevel, manual: hls.manualLevel };
      } });
      assert.equal(result.extra.manual, -1);
      if (cap === -1) assert.equal(result.extra.next, 4, 'fast recovery should re-enter supported Original across codec families');
      else assert.ok(result.extra.next <= cap, 'decoder protection must remain authoritative');
    }
  } finally { globalThis.fetch = fetcher; }
});

test('detaching restores native HLS hooks and cannot undo a later attachment', () => {
  for (const ownDescriptor of [false, true]) {
    const hls = new Hls({ ...adaptiveHlsConfig, enableWorker: false });
    const trigger = hls.trigger;
    if (ownDescriptor) Object.defineProperty(hls, 'nextLevel', { configurable: true, get: () => -1, set() {} });
    const descriptor = Object.getOwnPropertyDescriptor(hls, 'nextLevel');
    const video = Object.assign(new EventTarget(), { paused: true, buffered: { length: 0 } });
    const cleanup = attachAdaptivePlayback(hls, video, 'https://cloud.test/main.m3u8', 0);
    try {
      cleanup();
      assert.equal(hls.trigger, trigger);
      assert.deepEqual(Object.getOwnPropertyDescriptor(hls, 'nextLevel'), descriptor);
      const detach = attachAdaptivePlayback(hls, video, 'https://cloud.test/main.m3u8', 0);
      try {
        cleanup();
        assert.notEqual(hls.trigger, trigger, 'an old cleanup must not detach the new player policy');
      } finally { detach(); }
      assert.equal(hls.trigger, trigger);
      assert.deepEqual(Object.getOwnPropertyDescriptor(hls, 'nextLevel'), descriptor);
    } finally { cleanup(); hls.destroy(); }
  }
});

test('a cold backward seek restarts both buffers without changing paused state or manual quality', () => {
  const hls = new Hls({ ...adaptiveHlsConfig, enableWorker: false });
  let ranges = [[0, 20]];
  const video = Object.assign(new EventTarget(), { currentTime: 12, paused: true, ended: false,
    buffered: { get length() { return ranges.length; }, start: (i) => ranges[i][0], end: (i) => ranges[i][1] } });
  const flushes = [], starts = [];
  hls.on(Hls.Events.BUFFER_FLUSHING, (_, data) => flushes.push(data));
  hls.startLoad = (position) => starts.push(position);
  const cleanup = attachAdaptivePlayback(hls, video, 'https://cloud.test/main.m3u8', 0);
  try {
    hls.loadLevel = 0;
    video.currentTime = 4;
    video.dispatchEvent(new Event('seeking'));
    assert.equal(flushes.length, 0, 'buffered rewinds keep playable data');
    ranges = [[8, 20]];
    video.currentTime = 15;
    video.dispatchEvent(new Event('timeupdate'));
    video.currentTime = 25;
    video.dispatchEvent(new Event('seeking'));
    assert.equal(flushes.length, 0, 'forward seeks retain the native loading policy');
    video.currentTime = 0;
    video.dispatchEvent(new Event('seeking'));
    assert.deepEqual(flushes, [{ startOffset: 0, endOffset: Infinity, type: null }], 'audio must reset with video');
    assert.deepEqual(starts, [0]);
    assert.equal(hls.manualLevel, 0);
    assert.equal(video.paused, true);
    video.dispatchEvent(new Event('seeking'));
    assert.equal(flushes.length, 1, 'one seek cannot reset twice');
    video.currentTime = 0.1;
    video.dispatchEvent(new Event('timeupdate'));
    ranges = [[0.075, 20]];
    video.currentTime = 0.05;
    video.dispatchEvent(new Event('seeking'));
    assert.equal(flushes.length, 2, 'even a small rewind outside the buffer needs coherent tracks');
    cleanup();
    video.currentTime = 16;
    video.dispatchEvent(new Event('timeupdate'));
    video.currentTime = 0;
    video.dispatchEvent(new Event('seeking'));
    assert.equal(flushes.length, 2, 'detaching removes the rewind listener');
  } finally { cleanup(); hls.destroy(); }
});
