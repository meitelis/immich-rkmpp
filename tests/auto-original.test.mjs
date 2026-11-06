import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = process.env.IMMICH_SOURCE ? resolve(process.env.IMMICH_SOURCE) : fileURLToPath(new URL('../overlays/', import.meta.url));
const {
  originalContentType, originalIsAffordable, originalEndpointUrl, preferDirectOriginal,
} = await import(pathToFileURL(resolve(root, 'web/src/lib/utils/auto-original.ts')));

const source = {
  container: 'mp4', videoCodec: 'hevc', videoProfile: 1, videoLevel: 153,
  pixelFormat: 'yuv420p', colorTransfer: 1, dvProfile: null,
  audioCodec: 'aac', audioProfile: 2, bitrate: 8_000_000,
  width: 3200, height: 1800, frameRate: 30,
};
const supported = () => 'probably';
const MASTER = 'https://cloud.test/api/assets/abc/video/stream/main.m3u8?key=existing';

test('known, supported 1800p HEVC/AAC MP4 can use original at exact resolution without transcoding', () => {
  assert.match(originalContentType(source), /hvc1\.1\.6\.L153\.B0, mp4a\.40\.2/);
  assert.equal(originalIsAffordable(source, 20_000_000, supported), true);
  assert.equal(originalIsAffordable(source, 10_000_000, supported), false);
  assert.equal(originalIsAffordable(source, 30_000_000, () => ''), false);
});

test('H.264 profile and actual level enter the MIME type; unknown or unsafe codecs fall back', () => {
  assert.match(originalContentType({
    ...source, videoCodec: 'h264', videoProfile: 100, videoLevel: 42,
  }), /avc1\.64002a/);
  for (const info of [
    { videoCodec: 'av1' },
    { videoCodec: 'h264', videoProfile: 110 },
    { videoCodec: 'h264', pixelFormat: 'yuv420p10le' },
    { videoCodec: 'hevc', videoProfile: 4 },
    { container: 'mkv' },
    { container: 'mov' },
    { colorTransfer: 16 },
    { colorTransfer: 18 },
    { dvProfile: 8 },
    { audioCodec: 'ac3' },
    { audioCodec: 'aac', audioProfile: 5 },
    { bitrate: 0 },
  ]) {
    assert.equal(originalContentType({ ...source, ...info }), null, JSON.stringify(info));
  }
});

test('auth and base path survive metadata and speed probe URL construction', () => {
  const master = 'https://cloud.test/immich/api/assets/a/video/stream/main.m3u8?key=old';
  const url = originalEndpointUrl(master, 'network-probe', { key: 'new', password: 'secret' });
  assert.equal(new URL(url).pathname, '/immich/api/assets/a/video/stream/network-probe');
  assert.equal(new URL(url).searchParams.get('key'), 'new');
  assert.equal(new URL(url).searchParams.get('password'), 'secret');
  assert.throws(() => originalEndpointUrl('https://cloud.test/not-a-master', 'original-info'));
});

function setup({
  info = source, sampleMs = 100, compatible = supported, bytes = 1024 * 1024,
  networkStatus = 200, metadataStatus = 200, encoding = null, signal, onDecision,
} = {}) {
  let time = 1000;
  const calls = [];
  const fetcher = async (url, request) => {
    calls.push({ url, request });
    assert.equal(request.cache, 'no-store');
    if (url.includes('/original-info')) return { ok: metadataStatus === 200, json: async () => info };
    time += sampleMs;
    return {
      ok: networkStatus === 200,
      headers: { get: (name) => name === 'Content-Encoding' ? encoding : null },
      arrayBuffer: async () => new ArrayBuffer(bytes),
    };
  };
  return {
    calls,
    measure: () => preferDirectOriginal({
      masterUrl: MASTER, authParams: { password: 'shared' },
      canPlay: compatible, fetcher, now: () => time, signal, onDecision,
    }),
  };
}

test('fast compatible original selects direct without opening an HLS session', async () => {
  const h = setup();
  assert.equal(await h.measure(), true);
  assert.equal(h.calls.length, 2);
  assert.match(h.calls[0].url, /original-info/);
  assert.match(h.calls[1].url, /network-probe/);
  assert.equal(new URL(h.calls[1].url).searchParams.get('password'), 'shared');
});

test('weak bandwidth, unsupported source and unverified metadata fall back to HLS', async () => {
  assert.equal(await setup({ sampleMs: 1400 }).measure(), false);
  assert.equal(await setup({ bytes: 12 }).measure(), false);
  assert.equal(await setup({ encoding: 'gzip' }).measure(), false);
  assert.equal(await setup({ metadataStatus: 403 }).measure(), false);
  assert.equal(await setup({ networkStatus: 404 }).measure(), false);
  assert.equal(await setup({ info: { ...source, audioCodec: 'opus' } }).measure(), false);
  const h = setup({ compatible: () => '' });
  assert.equal(await h.measure(), false);
  assert.equal(h.calls.length, 1, 'unsupported codec must not trigger a speed probe');
});

test('aborted or stale requests never enable direct playback', async () => {
  const abort = new AbortController();
  abort.abort();
  const h = setup({ signal: abort.signal });
  assert.equal(await h.measure(), false);
  assert.equal(h.calls.length, 0);
  const abortDuringDownload = new AbortController();
  const second = setup({ signal: abortDuringDownload.signal });
  // The caller must not use a completed decision after navigation; an
  // already-aborted signal always wins.
  abortDuringDownload.abort();
  assert.equal(await second.measure(), false);
});

test('Auto decision reports why it selected HLS or Original', async () => {
  const events = [];
  const report = (direct, reason) => events.push({ direct, reason });
  await setup({ onDecision: report }).measure();
  await setup({ compatible: () => '', onDecision: report }).measure();
  await setup({ sampleMs: 1400, onDecision: report }).measure();
  await setup({ metadataStatus: 403, onDecision: report }).measure();
  assert.deepEqual(events, [
    { direct: true, reason: 'original selected' },
    { direct: false, reason: 'browser reports source codec unsupported' },
    { direct: false, reason: 'measured connection below original bitrate headroom' },
    { direct: false, reason: 'metadata unavailable' },
  ]);
});
