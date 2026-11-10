import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import vm from 'node:vm';
import { PlaybackTimeline, audioSegments, originalVideoCodec, videoSeek, playbackPlaylist, sharedAudioArgs, copyVideoArgs } from '../overlays/server/src/utils/hls-playback.ts';
import { adaptiveHlsConfig, originalCapability, playbackEndpoint, prepareAdaptivePlayback, probeConnection, safeEstimate, transferBandwidth } from '../overlays/web/src/lib/utils/adaptive-playback.ts';

// Exercise the URL builder that the real Svelte component passes to preparation.
// Immich normally uses a relative API base; a synthetic absolute URL hid the bug.
const utils = readFileSync(new URL('../overlays/web/src/lib/utils.ts', import.meta.url), 'utf8');
const urlBuilders = stripTypeScriptTypes([
  utils.match(/const createUrl = [\s\S]*?\n};/)[0],
  utils.match(/export const getAssetHlsUrl = [\s\S]*?\n};/)[0].replace('export ', ''),
].join('\n'));
for (const base of ['/api', '/immich/api', 'https://media.test/immich/api']) {
  test(`browser playback starts with the production URL builder and API base ${base}`, async (t) => {
    const previous = Object.getOwnPropertyDescriptor(globalThis, 'location');
    Object.defineProperty(globalThis, 'location', { configurable: true, value: { href: 'https://cloud.test/immich/photos/id' } });
    t.after(() => previous ? Object.defineProperty(globalThis, 'location', previous) : delete globalThis.location);
    const masterUrl = vm.runInNewContext(`${urlBuilders}\ngetAssetHlsUrl('id', 'h264')`, {
      URL, URLSearchParams, getBaseUrl: () => base, authManager: { params: { key: 'secret' } },
    });
    const expected = new URL(`${base}/assets/id/video/stream/`, globalThis.location.href);
    const endpoint = playbackEndpoint(masterUrl, 'original-info');
    assert.equal(endpoint.origin, expected.origin);
    assert.equal(endpoint.pathname, `${expected.pathname}original-info`);
    assert.equal(endpoint.searchParams.get('key'), 'secret');
    assert.equal(endpoint.searchParams.has('videoCodec'), false);
    const requests = [];
    const decision = await prepareAdaptivePlayback({
      masterUrl, signal: new AbortController().signal, supported: () => true,
      fetcher: async (value) => {
        const url = new URL(value);
        requests.push(url.pathname);
        assert.equal(url.origin, expected.origin);
        assert.equal(url.searchParams.get('key'), 'secret');
        return { ok: true, headers: { get: () => null },
          json: async () => ({ rotation: 0, dvProfile: null, colorTransfer: 1, videoCodec: 'h264', videoProfile: 100, videoLevel: 40, pixelFormat: 'yuv420p' }),
          arrayBuffer: async () => new ArrayBuffer(Number(url.searchParams.get('bytes'))) };
      },
    });
    const source = new URL(decision.url);
    assert.equal(source.origin, expected.origin);
    assert.equal(source.pathname, `${expected.pathname}main.m3u8`);
    assert.equal(source.searchParams.get('videoCodec'), 'h264');
    assert.equal(source.searchParams.get('strategy'), 'memories');
    assert.equal(source.searchParams.get('copy'), 'avc');
    assert.equal(requests.length, 4);
    assert.ok(requests.every((path) => path.startsWith(expected.pathname)));
  });
}

test('open-GOP packet order yields one presentation grid and separate decoder entry points', () => {
  const timeline = new PlaybackTimeline();
  for (const [pts, flags] of [[0, 'K'], [.08, '_'], [.04, '_'], [2.08, 'K'], [2, '_'], [2.04, '_'], [4.08, 'K'], [4, '_'], [4.04, '_'], [5.96, '_']]) timeline.packet(pts, .04, flags);
  const segments = timeline.finish();
  assert.deepEqual(segments, [{ start: 0, duration: 2 }, { start: 2, duration: 2, keyframeAt: 2.08 }, { start: 4, duration: 2, keyframeAt: 4.08 }]);
  assert.equal(videoSeek(segments, 2, true), 4.08001);
  assert.equal(videoSeek(segments, 2, false), 2.08001, 'decode leading pictures from the preceding random-access point');
  assert.match(playbackPlaylist(segments, false), /TARGETDURATION:2/);
});

test('missing, non-monotonic, dense or overlong copy grids never advertise Original', () => {
  for (const packets of [[], [[1, 'K'], [2, 'K']], [[0, 'K'], [0, 'K']], [[0, 'K'], [7, 'K']]]) {
    const timeline = new PlaybackTimeline();
    for (const [pts, flags] of packets) timeline.packet(pts, .04, flags);
    assert.equal(timeline.finish(), null);
  }
});

const video = { index: 0, codecName: 'hevc', profile: 2, level: 153, rotation: 0, dvProfile: null, colorTransfer: 1, pixelFormat: 'yuv420p10le' };
test('copied Main10 is declared accurately and only follows explicit browser MSE support', () => {
  assert.equal(originalVideoCodec(video), 'hvc1.2.4.L153.B0');
  const info = { ...video, videoCodec: video.codecName, videoProfile: video.profile, videoLevel: video.level };
  assert.equal(originalCapability(info, (mime) => mime.includes('hvc1.2.4.L153')), 'hevc10');
  assert.equal(originalCapability(info, () => false), undefined);
  for (const overrides of [{ rotation: 90 }, { dvProfile: 5 }, { colorTransfer: 16 }, { pixelFormat: 'yuv420p12le' }])
    assert.equal(originalVideoCodec({ ...video, ...overrides }), undefined);
});

test('audio uses one independent AAC clock and both workers are input-paced', () => {
  const segments = audioSegments(9);
  assert.equal(segments[1].start, 94 * 1024 / 48000);
  assert.ok(Math.abs(segments.at(-1).start + segments.at(-1).duration - 9) < 1024 / 48000);
  const args = sharedAudioArgs('/source', { index: 1 }, 9, 2, '/cache', (...p) => p.join('/'));
  assert.ok(args.includes('-vn'));
  assert.match(args[args.indexOf('-af') + 1], /apad=whole_dur=/);
  const copy = copyVideoArgs('/source', video, [{ start: 0, duration: 2 }, { start: 2, duration: 2 }], 1, '/cache', (...p) => p.join('/'));
  assert.equal(copy[copy.indexOf('-c:v') + 1], 'copy');
  assert.ok(copy.includes('-an'));
  for (const command of [copy, args]) {
    assert.equal(command[command.indexOf('-readrate_initial_burst') + 1], '18');
    assert.equal(command.includes('-readrate_catchup'), false);
    assert.ok(command.includes('-copyts'));
  }
});

test('network-only transfer timing does not charge a cold encoder wait against throughput', () => {
  assert.equal(transferBandwidth({ loaded: 125000, loading: { first: 5000, end: 5100 } }), 10_000_000);
  assert.equal(transferBandwidth({ loaded: 125000, loading: { first: 0, end: 5100 } }), 0);
  assert.equal(safeEstimate(10_000_000), 7_500_000);
  assert.equal(adaptiveHlsConfig.testBandwidth, false);
  assert.equal(adaptiveHlsConfig.maxMaxBufferLength, 18);
});

test('failed, transformed, cancelled and incomplete probes cannot establish a fast connection', async () => {
  for (const mode of ['failed', 'encoded', 'partial', 'aborted']) {
    const controller = new AbortController();
    if (mode === 'aborted') controller.abort();
    const result = await probeConnection('https://cloud.test/api/assets/id/video/stream/main.m3u8?key=secret', controller.signal, false,
      async (url) => ({ ok: mode !== 'failed', headers: { get: () => mode === 'encoded' ? 'gzip' : null },
        arrayBuffer: async () => new ArrayBuffer(Number(new URL(url).searchParams.get('bytes')) - 1) }));
    assert.equal(result, 0);
  }
});

test('Auto keeps one authenticated HLS source and negotiates Original independently of source audio', async () => {
  const requests = [];
  const result = await prepareAdaptivePlayback({
    masterUrl: 'https://cloud.test/base/assets/id/video/stream/main.m3u8?key=secret',
    signal: new AbortController().signal, supported: () => true,
    fetcher: async (value) => {
      const url = new URL(value); requests.push(url);
      assert.equal(url.searchParams.get('key'), 'secret');
      return { ok: true, headers: { get: () => null }, json: async () => ({
        rotation: 0, dvProfile: null, colorTransfer: 1, videoCodec: 'h264', videoProfile: 100,
        videoLevel: 40, pixelFormat: 'yuv420p', audioCodec: 'flac',
      }), arrayBuffer: async () => new ArrayBuffer(Number(url.searchParams.get('bytes'))) };
    },
  });
  assert.equal(new URL(result.url).searchParams.get('copy'), 'avc');
  assert.equal(new URL(result.url).searchParams.get('strategy'), 'memories');
  assert.ok(result.bandwidth > 0);
  assert.equal(requests.length, 4, 'metadata and three bounded completed network samples');
  assert.ok(requests.every((url) => !url.pathname.includes('/original/')));
});
