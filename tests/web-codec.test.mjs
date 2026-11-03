import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import vm from 'node:vm';
import { beforeEach, test } from 'node:test';

const sourceRoot = process.env.IMMICH_SOURCE
  ? resolve(process.env.IMMICH_SOURCE)
  : fileURLToPath(new URL('../overlays/', import.meta.url));
const sourcePath = (path) => resolve(sourceRoot, 'web/src/lib', path);
const { MediaCapabilitiesManager } = await import(pathToFileURL(sourcePath('managers/media-capabilities-manager.svelte.ts')));
const codecHelpers = await import(pathToFileURL(sourcePath('utils/video-codec.ts')));
const { isHevcDecodeFailure, isMediaDecodeFailure, playbackPosition } = codecHelpers;
const supported = { supported: true, smooth: true, powerEfficient: true, keySystemAccess: null };

function environment({ mse = () => true, decoding = async () => supported } = {}) {
  Object.defineProperty(globalThis, 'MediaSource', { configurable: true, value: { isTypeSupported: mse } });
  Object.defineProperty(globalThis, 'ManagedMediaSource', { configurable: true, writable: true, value: undefined });
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { mediaCapabilities: { decodingInfo: decoding } },
  });
}
beforeEach(() => environment());

function ladder(portrait = false) {
  return [480, 720, 1080, 1440, 2160].flatMap((edge) => {
    const width = portrait ? edge : Math.round(edge * 16 / 9 / 2) * 2;
    const height = portrait ? Math.round(edge * 16 / 9 / 2) * 2 : edge;
    return [
      { videoCodec: 'avc1.640028', width, height, bitrate: edge * 8000, frameRate: 30 },
      { videoCodec: 'hvc1.1.6.L120.B0', width, height, bitrate: edge * 4500, frameRate: 30 },
    ];
  });
}

test('HEVC is preferred across all five portrait and landscape resolutions when smooth and efficient', async () => {
  for (const portrait of [false, true]) {
    const levels = ladder(portrait);
    const keep = await new MediaCapabilitiesManager().efficientLevels(levels);
    assert.deepEqual([...keep], [1, 3, 5, 7, 9]);
  }
});

test('an explicit MSE rejection overrides optimistic MediaCapabilities data', async () => {
  const queries = [];
  environment({
    mse: (type) => type.includes('avc1'),
    decoding: async (query) => { queries.push(query); return supported; },
  });
  assert.deepEqual([...await new MediaCapabilitiesManager().efficientLevels(ladder())], [0, 2, 4, 6, 8]);
  assert.equal(queries.length, 5);
  assert.ok(queries.every((query) => query.video.contentType.includes('avc1')));
});

test('unsupported, unsmooth or inefficient HEVC retains AVC at each resolution', async () => {
  for (const override of [{ supported: false }, { smooth: false }, { powerEfficient: false }]) {
    environment({ decoding: async ({ video }) => video.contentType.includes('hvc1') ? { ...supported, ...override } : supported });
    assert.deepEqual([...await new MediaCapabilitiesManager().efficientLevels(ladder())], [0, 2, 4, 6, 8]);
  }
});

test('missing or failed MediaCapabilities keeps verified AVC without guessing HEVC efficiency', async () => {
  environment({ decoding: async () => { throw new Error('API unavailable'); } });
  assert.deepEqual([...await new MediaCapabilitiesManager().efficientLevels(ladder())], [0, 2, 4, 6, 8]);
  delete globalThis.navigator.mediaCapabilities;
  assert.deepEqual([...await new MediaCapabilitiesManager().efficientLevels(ladder())], [0, 2, 4, 6, 8]);
});

test('MSE absence/rejection yields no allegedly playable levels; ManagedMediaSource is supported', async () => {
  delete globalThis.MediaSource;
  assert.equal((await new MediaCapabilitiesManager().efficientLevels(ladder())).size, 0);
  globalThis.ManagedMediaSource = { isTypeSupported: () => true };
  assert.deepEqual([...await new MediaCapabilitiesManager().efficientLevels(ladder())], [1, 3, 5, 7, 9]);
});

test('capability cache uses exact dimensions, bitrate and frame rate and queries no speculative levels', async () => {
  const queries = [];
  environment({ decoding: async (query) => { queries.push(query); return supported; } });
  const manager = new MediaCapabilitiesManager();
  assert.equal(queries.length, 0);
  const level = ladder()[1];
  await manager.decodingInfo(level);
  await manager.decodingInfo({ ...level });
  assert.equal(queries.length, 1);
  await manager.decodingInfo({ ...level, frameRate: 60 });
  await manager.decodingInfo({ ...level, width: level.height, height: level.width });
  await manager.decodingInfo({ ...level, bitrate: level.bitrate + 1 });
  assert.equal(queries.length, 4);
});

test('capability cache bounds old source shapes while retaining recently used queries', async () => {
  const queries = [];
  environment({ decoding: async (query) => { queries.push(query); return supported; } });
  const manager = new MediaCapabilitiesManager();
  const level = ladder()[0];
  const levels = Array.from({ length: 129 }, (_, i) => ({ ...level, bitrate: level.bitrate + i }));
  for (const item of levels.slice(0, 128)) await manager.decodingInfo(item);
  await manager.decodingInfo(levels[0]);
  await manager.decodingInfo(levels[128]);
  await manager.decodingInfo(levels[0]);
  assert.equal(queries.length, 129, 'a recently used source must remain cached');
  await manager.decodingInfo(levels[1]);
  assert.equal(queries.length, 130, 'the oldest unused source must have been released');
});

test('codec recovery excludes network failures, nonfatal events and known AVC failures', () => {
  const codecError = { fatal: true, type: 'mediaError', details: 'bufferAddCodecError' };
  assert.equal(isHevcDecodeFailure(codecError, 'hvc1.1.6.L120.B0'), true);
  assert.equal(isHevcDecodeFailure(codecError, 'hev1.1.6.L120.B0'), true);
  assert.equal(isHevcDecodeFailure(codecError, 'avc1.640028'), false);
  assert.equal(isHevcDecodeFailure({ ...codecError, fatal: false }, 'hvc1'), false);
  assert.equal(isHevcDecodeFailure({ ...codecError, type: 'networkError' }, 'hvc1'), false);
  assert.equal(isHevcDecodeFailure({ ...codecError, details: 'fragLoadError' }, 'hvc1'), false);
  assert.equal(isMediaDecodeFailure(2), false);
  assert.equal(isMediaDecodeFailure(3), true);
  assert.equal(isMediaDecodeFailure(4), true);
  assert.deepEqual(playbackPosition({ currentTime: NaN, paused: true }), { currentTime: 0, paused: true });
});

const component = await readFile(sourcePath('components/asset-viewer/VideoNativeViewer.svelte'), 'utf8');
const script = component.match(/<script lang="ts">([\s\S]*?)<\/script>/)[1]
  .replace(/^\s*import\s[\s\S]*?;\s*$/gm, '');
const componentScript = stripTypeScriptTypes(script, { mode: 'strip' });
const utilsSource = await readFile(sourcePath('utils.ts'), 'utf8');
const hlsUrlSource = stripTypeScriptTypes(utilsSource.match(/export const getAssetHlsUrl = [\s\S]*?\n};/)[0].replace('export ', ''));

function harness({ native = false, paused = false, autoplay = true } = {}) {
  const effects = [];
  const released = [];
  const warnings = [];
  const derived = (value) => value;
  derived.by = (callback) => callback();
  let serial = 0;
  const sessionId = '00000000-0000-0000-0000-000000000001';
  class Hls {
    static Events = { MANIFEST_PARSED: 'manifest', FRAG_LOADED: 'fragment', ERROR: 'error' };
    static ErrorDetails = { FRAG_LOAD_ERROR: 'fragLoadError' };
    constructor(url, video) {
      this.video = video;
      this.handlers = new Map();
      this.currentLevel = 0;
      this.loadLevel = 0;
      this.levels = ladder().slice(0, 2).reverse().map((level) => ({
        ...level, url: [`https://cloud.test/api/assets/asset-a/video/stream/${sessionId}/${serial++}/playlist.m3u8`],
      }));
      if (new URL(url).searchParams.get('videoCodec') === 'h264') {
        this.levels = this.levels.filter((level) => level.videoCodec.startsWith('avc1'));
      }
    }
    on(event, callback) { this.handlers.set(event, callback); }
    stopLoad() { this.stopped = true; }
    startLoad(position) { this.startedAt = position; this.started = true; }
    removeLevel(index) { this.levels.splice(index, 1); }
    async emit(event, data) {
      // hls-video-element@1.5.11 registers this callback before the viewer's.
      if (event === Hls.Events.MANIFEST_PARSED && this.video.autoplay && this.video.paused) {
        await this.video.play();
      }
      return this.handlers.get(event)?.(event, data);
    }
  }
  const context = {
    ...codecHelpers,
    console: { warn: (...args) => warnings.push(args), error: (...args) => warnings.push(args) },
    queueMicrotask,
    fetch: async (url, options) => { released.push({ url, options }); },
    $props: () => ({ asset: { id: 'asset-a', width: 1920, height: 1080 }, assetId: 'asset-a', loopVideo: false, cacheKey: null, playOriginalVideo: false }),
    $state: (value) => value,
    $derived: derived,
    $effect: (callback) => effects.push(callback),
    onMount() {}, onDestroy() {}, untrack: (callback) => callback(),
    $autoPlayVideo: autoplay,
    Hls, AbrController: class {},
    featureFlagsManager: { value: { realtimeTranscoding: true } },
    authManager: { params: { key: 'keep-auth' } },
    createUrl: (path, params) => {
      const url = new URL(`/api${path}`, 'https://cloud.test');
      for (const [key, value] of Object.entries(params)) if (value !== undefined) url.searchParams.set(key, value);
      return url.href;
    },
    getAssetHlsSessionUrl: (assetId, id) => `/api/assets/${assetId}/video/stream/${id}`,
    mediaCapabilitiesManager: new MediaCapabilitiesManager(),
  };
  vm.createContext(context);
  vm.runInContext(`${hlsUrlSource}\n${componentScript}\n globalThis.harness = {
    setVideo(video) { videoPlayer = video; },
    flush() { assetFileUrl = getAssetHlsUrl(assetId, avcFallbackAssetId === assetId ? 'h264' : undefined); globalThis.flushMain(); },
    metadata(video) { handleLoadedMetadata(video); },
    play(video) { if (typeof handlePlay === 'function') handlePlay(video); },
    mediaError(video) { handleMediaError({ currentTarget: video }); },
    changeAsset(id) { assetId = id; },
    state() { return { avcFallbackAssetId, pendingResume, rebuildCount, activeSession }; },
  };`, context);
  context.flushMain = effects[0];
  const video = {
    tagName: 'HLS-VIDEO', currentTime: 45.25, paused, autoplay, api: undefined, sourceChanges: 0,
    error: null, playCalls: 0, pauseCalls: 0,
    sourceAutoplay: [],
    set src(url) {
      this.sourceAutoplay.push(this.autoplay);
      this.source = url; this.sourceChanges++; this.currentTime = 0; this.paused = true;
      this.api = native ? undefined : new Hls(url, this);
    },
    play() { this.paused = false; this.playCalls++; controls.play(this); return Promise.resolve(); },
    pause() { this.paused = true; this.pauseCalls++; },
    load() { this.src = this.source; },
    async finishLoading() {
      // Native autoplay can run after loadedmetadata, including with native HLS.
      await Promise.resolve();
      if (this.autoplay && this.paused) await this.play();
    },
  };
  const controls = context.harness;
  controls.setVideo(video);
  return { controls, video, released, warnings, Hls };
}

async function flush(h) {
  h.controls.flush();
  await Promise.resolve();
}

for (const paused of [false, true]) {
  test(`actual player retries HEVC once as authenticated AVC and restores ${paused ? 'paused' : 'playing'} position`, async () => {
    const h = harness({ paused });
    await flush(h);
    const oldApi = h.video.api;
    await oldApi.emit(h.Hls.Events.MANIFEST_PARSED);
    assert.equal(oldApi.levels[0].videoCodec.startsWith('hvc1'), true);
    h.video.paused = paused;
    h.video.currentTime = 45.25;
    await oldApi.emit(h.Hls.Events.ERROR, { fatal: true, type: 'mediaError', details: 'bufferAddCodecError' });
    assert.equal(h.controls.state().avcFallbackAssetId, 'asset-a');
    await flush(h);
    assert.equal(new URL(h.video.source).searchParams.get('videoCodec'), 'h264');
    assert.equal(new URL(h.video.source).searchParams.get('key'), 'keep-auth');
    assert.equal(h.released.length, 1);
    assert.equal(h.released[0].options.method, 'DELETE');
    await h.video.api.emit(h.Hls.Events.MANIFEST_PARSED);
    assert.equal(h.video.api.startedAt, 45.25);
    assert.ok(h.video.api.levels.every((level) => level.videoCodec.startsWith('avc1')));
    h.controls.metadata(h.video);
    assert.equal(h.video.currentTime, 45.25);
    assert.equal(h.video.paused, paused);
    const changes = h.video.sourceChanges;
    h.video.error = { code: 3 };
    h.controls.mediaError(h.video);
    await h.video.api.emit(h.Hls.Events.ERROR, { fatal: true, type: 'mediaError', details: 'bufferAddCodecError' });
    assert.equal(h.video.sourceChanges, changes);
    assert.equal(h.controls.state().pendingResume, undefined);
  });
}

test('native HLS decoder rejection switches once to AVC master and restores playback', async () => {
  const h = harness({ native: true });
  await flush(h);
  h.video.paused = false;
  h.video.currentTime = 12.5;
  h.video.error = { code: 2 };
  h.controls.mediaError(h.video);
  assert.equal(h.controls.state().avcFallbackAssetId, undefined);
  h.video.error = { code: 4 };
  h.controls.mediaError(h.video);
  await flush(h);
  assert.equal(new URL(h.video.source).searchParams.get('videoCodec'), 'h264');
  h.controls.metadata(h.video);
  assert.equal(h.video.currentTime, 12.5);
  assert.equal(h.video.playCalls, 1);
  h.controls.mediaError(h.video);
  assert.equal(h.controls.state().pendingResume, undefined);
});

test('network failures remain separate from codec recovery and 404 rebuilds preserve position', async () => {
  const h = harness({ paused: true });
  await flush(h);
  await h.video.api.emit(h.Hls.Events.MANIFEST_PARSED);
  h.video.paused = true;
  h.video.currentTime = 23;
  await h.video.api.emit(h.Hls.Events.ERROR, { fatal: true, type: 'networkError', details: 'fragLoadTimeOut' });
  assert.equal(h.controls.state().avcFallbackAssetId, undefined);
  await h.video.api.emit(h.Hls.Events.ERROR, { fatal: true, type: 'networkError', details: 'fragLoadError', response: { code: 404 } });
  await Promise.resolve();
  assert.equal(h.controls.state().avcFallbackAssetId, undefined);
  assert.equal(h.controls.state().rebuildCount, 1);
  await h.video.api.emit(h.Hls.Events.MANIFEST_PARSED);
  assert.equal(h.video.api.startedAt, 23);
  h.controls.metadata(h.video);
  assert.equal(h.video.currentTime, 23);
  assert.equal(h.video.paused, true);
});

test('an old player error cannot switch the next asset to AVC', async () => {
  const h = harness();
  await flush(h);
  const oldApi = h.video.api;
  await oldApi.emit(h.Hls.Events.MANIFEST_PARSED);
  h.controls.changeAsset('asset-b');
  await flush(h);
  await oldApi.emit(h.Hls.Events.ERROR, { fatal: true, type: 'mediaError', details: 'bufferAddCodecError' });
  assert.equal(h.controls.state().avcFallbackAssetId, undefined);
  assert.equal(new URL(h.video.source).searchParams.has('videoCodec'), false);
  await h.video.api.emit(h.Hls.Events.MANIFEST_PARSED);
  await h.video.api.emit(h.Hls.Events.ERROR, { fatal: true, type: 'mediaError', details: 'bufferAddCodecError' });
  assert.equal(h.controls.state().avcFallbackAssetId, 'asset-b');
});

test('a capability result finishing after source replacement cannot start the destroyed decoder', async () => {
  let finish;
  const waiting = new Promise((resolve) => { finish = resolve; });
  environment({ decoding: async () => { await waiting; return supported; } });
  const h = harness();
  await flush(h);
  const oldApi = h.video.api;
  const initialManifest = oldApi.emit(h.Hls.Events.MANIFEST_PARSED);
  h.controls.changeAsset('asset-b');
  await flush(h);
  finish();
  await initialManifest;
  assert.equal(oldApi.started, undefined);
});

for (const [native, recovery] of [[false, 'codec'], [true, 'codec'], [false, 'expired session']]) {
  test(`paused ${native ? 'native HLS' : 'hls.js'} ${recovery} recovery suppresses manifest and delayed autoplay`, async () => {
    const h = harness({ native });
    await flush(h);
    if (h.video.api) await h.video.api.emit(h.Hls.Events.MANIFEST_PARSED);
    h.video.pause();
    h.video.currentTime = 37;
    const playsBefore = h.video.playCalls;
    if (recovery === 'codec') {
      h.video.error = { code: 3 };
      h.controls.mediaError(h.video);
      await flush(h);
    } else {
      await h.video.api.emit(h.Hls.Events.ERROR, {
        fatal: true, type: 'networkError', details: 'fragLoadError', response: { code: 404 },
      });
      await Promise.resolve();
    }
    assert.equal(h.video.sourceAutoplay.at(-1), false, 'autoplay must be disabled before src/load');
    if (h.video.api) await h.video.api.emit(h.Hls.Events.MANIFEST_PARSED);
    h.controls.metadata(h.video);
    await h.video.finishLoading();
    assert.equal(h.video.currentTime, 37);
    assert.equal(h.video.paused, true);
    assert.equal(h.video.playCalls, playsBefore, 'neither manifest nor a later ready task may play');
    await h.video.play();
    assert.equal(h.video.paused, false);
    assert.equal(h.video.autoplay, true, 'user play releases the per-asset hold');
  });
}

test('another asset restores its normal autoplay preference after paused recovery', async () => {
  for (const autoplay of [false, true]) {
    const h = harness({ autoplay });
    await flush(h);
    await h.video.api.emit(h.Hls.Events.MANIFEST_PARSED);
    h.video.pause();
    h.video.error = { code: 3 };
    h.controls.mediaError(h.video);
    await flush(h);
    h.controls.metadata(h.video);
    assert.equal(h.video.autoplay, false);
    h.controls.changeAsset('asset-b');
    await flush(h);
    assert.equal(h.video.sourceAutoplay.at(-1), autoplay);
    await h.video.api.emit(h.Hls.Events.MANIFEST_PARSED);
    await h.video.finishLoading();
    assert.equal(h.video.paused, !autoplay);
  }
});

test('intentional play while a paused recovery is loading survives the later metadata event', async () => {
  const h = harness();
  await flush(h);
  await h.video.api.emit(h.Hls.Events.MANIFEST_PARSED);
  h.video.pause();
  h.video.currentTime = 19;
  h.video.error = { code: 3 };
  h.controls.mediaError(h.video);
  await flush(h);
  await h.video.play();
  h.controls.metadata(h.video);
  await h.video.finishLoading();
  assert.equal(h.video.currentTime, 19);
  assert.equal(h.video.paused, false);
});

test('playing recovery resumes even when normal autoplay is disabled', async () => {
  const h = harness({ autoplay: false });
  await flush(h);
  await h.video.api.emit(h.Hls.Events.MANIFEST_PARSED);
  await h.video.play();
  h.video.currentTime = 22;
  h.video.error = { code: 3 };
  h.controls.mediaError(h.video);
  await flush(h);
  assert.equal(h.video.paused, true, 'replacing the source resets native playback');
  await h.video.api.emit(h.Hls.Events.MANIFEST_PARSED);
  h.controls.metadata(h.video);
  assert.equal(h.video.currentTime, 22);
  assert.equal(h.video.paused, false);
  assert.equal(h.video.autoplay, false);
});
