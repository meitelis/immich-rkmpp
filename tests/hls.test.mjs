import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import vm from 'node:vm';
import test from 'node:test';
import * as playback from '../overlays/server/src/utils/hls-playback.ts';
import { join } from 'node:path';

// Run the exact patched service with isolated repositories and the real Zod schema.
// Install zod@4.4.3, or set IMMICH_ZOD_MODULE to that package's index.js.
const { default: z } = await import(process.env.IMMICH_ZOD_MODULE
  ? pathToFileURL(resolve(process.env.IMMICH_ZOD_MODULE)).href
  : 'zod');
const overlay = (path) => fileURLToPath(new URL(`../overlays/server/src/${path}`, import.meta.url));
const sourcePath = process.env.IMMICH_HLS_SOURCE ? resolve(process.env.IMMICH_HLS_SOURCE) : overlay('services/hls.service.ts');
const dtoPath = process.env.IMMICH_HLS_DTO_SOURCE ? resolve(process.env.IMMICH_HLS_DTO_SOURCE) : overlay('dtos/streaming.dto.ts');
const stripImports = (source) => source.replace(/^import[\s\S]*?from\s+['"][^'"]+['"];\s*/gm, '');
const script = (source) => stripTypeScriptTypes(stripImports(source), { mode: 'transform' }).replace(/\bexport\s+/g, '');
const dtoContext = vm.createContext({
  z,
  createZodDto: (schema) => class { static create(value) { return schema.parse(value); } },
  ImmichHeader: { HlsInitSegment: 'x-immich-hls-init-segment', HlsPosition: 'x-immich-hls-position' },
});
vm.runInContext(`${script(readFileSync(dtoPath, 'utf8'))}\n;globalThis.QueryDto = HlsMainPlaylistQueryDto;`, dtoContext);
const QueryDto = dtoContext.QueryDto;

class BadRequestException extends Error {}
class NotFoundException extends Error {}
class PendingEvents {
  pending = new Map();
  wait(key) { return new Promise((resolve) => this.pending.set(key, resolve)); }
  complete(key, value) { this.pending.get(key)?.(value); }
  rejectByPrefix() {}
}

// Preserve the upstream stable index order; a filtered ladder must not renumber paths.
const HLS_VARIANTS = [480, 720, 1080, 1440, 2160].flatMap((resolution) => [
  { resolution, codec: 'av1', bitrate: 1_000_000 },
  { resolution, codec: 'hevc', bitrate: 1_200_000 },
  { resolution, codec: 'h264', bitrate: 2_500_000 },
]);
const serviceContext = vm.createContext({
  ...playback,
  join,
  constants: { R_OK: 4 },
  StorageCore: { getHlsVariantFolder: ({ variantIndex }) => `/fixture/${variantIndex}` },
  ImmichFileResponse: class { constructor(value) { Object.assign(this, value); } },
  CacheControl: { PrivateWithCache: 'private' },
  HLS_SEGMENT_FILENAME_REGEX: /^seg_(\d+)\.m4s$/,
  HLS_SEGMENT_DURATION: 2,
  BadRequestException,
  NotFoundException,
  BaseService: class {},
  PendingEvents,
  randomBytes: (length) => new Uint8Array(length),
  HLS_VARIANTS,
  HLS_VERSION: 7,
  Permission: { AssetView: 'asset.read' },
  getCodecString: (codec) => ({ h264: 'avc1.fixture', hevc: 'hvc1.fixture', av1: 'av01.fixture' })[codec],
  getOutputSize: (_stream, resolution) => ({ width: resolution * 16 / 9, height: resolution }),
});
const serviceSource = readFileSync(sourcePath, 'utf8').replace(/^\s*@(?:Injectable|OnEvent)\([^\n]*\)\s*$/gm, '');
vm.runInContext(`${script(serviceSource)}\n;globalThis.Service = HlsService;`, serviceContext);

const sessionId = '00000000-0000-4000-8000-000000000000';
const auth = { user: { id: 'owner' } };
function setup({ codecs = ['h264', 'hevc'], resolutions = [480, 720, 1080], enabled = true, width = 1920, height = 1080 } = {}) {
  const sut = new serviceContext.Service();
  const events = [];
  const accesses = [];
  sut.requireAccess = async (access) => accesses.push(access);
  sut.getConfig = async () => ({ ffmpeg: { realtime: { enabled, videoCodecs: codecs, resolutions } } });
  sut.videoStreamRepository = { getForMainPlaylist: async () => ({
    videoStream: { width, height, timeBase: 1 },
    packets: { packetCount: 300, totalDuration: 10, outputFrames: 300 },
  }) };
  sut.cryptoRepository = { randomUUID: () => sessionId };
  sut.websocketRepository = { serverSend: (name, event) => {
    events.push({ name, event });
    if (name === 'HlsSessionRequest') queueMicrotask(() => sut.onSessionResult({ sessionId: event.sessionId }));
  } };
  return { sut, events, accesses };
}

async function memories({ copy = 'avc', codec = 'h264', grid = true } = {}) {
  const h = setup();
  h.sut.getConfig = async () => ({ ffmpeg: { accel: 'rkmpp', realtime: { enabled: true, videoCodecs: ['h264', 'hevc'], resolutions: [480, 720, 1080] } } });
  const asset = { originalPath: '/private/source.mp4', format: { bitrate: 6_000_000 },
    videoStream: { index: 0, width: 1920, height: 1080, timeBase: 1, codecName: codec, profile: codec === 'h264' ? 100 : 1,
      level: codec === 'h264' ? 40 : 120, colorTransfer: 1, dvProfile: null, pixelFormat: 'yuv420p', rotation: 0, bitrate: 5_000_000 },
    audioStream: { index: 1, codecName: 'flac', bitrate: 1_000_000 },
    packets: { packetCount: 300, totalDuration: 10, outputFrames: 300 } };
  h.sut.videoStreamRepository.getForMainPlaylist = async () => asset;
  h.sut.videoStreamRepository.getForTranscoding = async () => asset;
  h.sut.videoStreamRepository.getForMediaPlaylist = async () => asset;
  h.sut.videoStreamRepository.getSession = async () => ({ assetId: 'asset' });
  h.sut.mediaRepository = { probePlaybackTimeline: async () => grid ? [0, 2, 4, 6, 8].map((start) => ({ start, duration: 2 })) : null };
  h.sut.storageRepository = { checkFileExists: async () => true };
  const master = await h.sut.getMainPlaylist(auth, 'asset', undefined, { strategy: 'memories', copy });
  return { ...h, master, plan: h.events.find((event) => event.name === 'HlsSessionRequest').event.playback };
}

test('Memories master advertises one audio group and real Original without starting any rendition', async () => {
  const h = await memories();
  assert.equal((h.master.match(/#EXT-X-MEDIA:TYPE=AUDIO/g) ?? []).length, 1);
  assert.match(h.master, /original=1/);
  assert.match(h.master, /AUDIO="audio"/);
  assert.equal(h.plan.segments.length, 5);
  assert.equal(h.plan.original.codec, 'avc1.640028');
  assert.ok(h.events.every((event) => event.name === 'HlsSessionRequest'), 'master must not start the entire encoder ladder');
  const playlist = await h.sut.getMediaPlaylist(auth, 'asset', sessionId, HLS_VARIANTS.length, 6, 'memories');
  assert.match(playlist, /seg_3\.m4s\?strategy=memories/);
  assert.doesNotMatch(playlist, /INDEPENDENT-SEGMENTS/, 'copied open GOPs must not be falsely declared independent');
  assert.equal(h.events.length, 1, 'playlist prewarming must not race actual upcoming fragment selection');
});

test('unavailable copy grids and mismatched browser capabilities retain encoded HLS', async () => {
  for (const options of [{ grid: false }, { copy: 'hevc' }]) {
    const h = await memories(options);
    assert.doesNotMatch(h.master, /original=1/);
    assert.equal(h.plan.segments, null);
    assert.match(h.master, /AUDIO="audio"/);
  }
});

test('shared audio requests do not overwrite the video sequence or invalidate its pending requests', async () => {
  const h = await memories();
  await h.sut.getSegment(auth, 'asset', sessionId, 2, 'seg_3.m4s', undefined, 'memories');
  await h.sut.getSegment(auth, 'asset', sessionId, HLS_VARIANTS.length + 1, 'seg_1.m4s', undefined, 'memories');
  await h.sut.getSegment(auth, 'asset', sessionId, 2, 'init.mp4', undefined, 'memories');
  assert.equal(h.events.at(-1).event.segmentIndex, 4, 'video init still follows video segment 3');
  await assert.rejects(h.sut.getSegment(auth, 'wrong-asset', sessionId, 2, 'seg_0.m4s'), NotFoundException);
  await assert.rejects(h.sut.getSegment(auth, 'asset', sessionId, HLS_VARIANTS.length, 'seg_999.m4s', undefined, 'memories'), NotFoundException);
});

test('another API worker fetches the owned session plan through internal events', async () => {
  const h = await memories();
  h.sut.sessions.clear();
  const send = h.sut.websocketRepository.serverSend;
  h.sut.websocketRepository.serverSend = (name, event) => {
    send(name, event);
    if (name === 'HlsPlaybackPlanRequest') queueMicrotask(() => h.sut.onPlaybackPlan({ sessionId, playback: h.plan }));
  };
  const playlist = await h.sut.getMediaPlaylist(auth, 'asset', sessionId, HLS_VARIANTS.length, undefined, 'memories');
  assert.match(playlist, /seg_4\.m4s/);
  assert.ok(h.events.some((event) => event.name === 'HlsPlaybackPlanRequest'));
});

test('authorized original metadata returns only the indexed playback fields, without reading media', async () => {
  const { sut, accesses, events } = setup();
  sut.videoStreamRepository.getForTranscoding = async () => ({
    originalPath: '/private/DJI/test.MP4',
    format: { bitrate: 7_760_000 },
    videoStream: {
      codecName: 'hevc', profile: 1, level: 153, pixelFormat: 'yuv420p',
      colorTransfer: 1, dvProfile: null, bitrate: 7_000_000,
      width: 3200, height: 1800, frameRate: 30,
    },
    audioStream: { codecName: 'aac', profile: 2, bitrate: 160_000 },
  });
  const info = await sut.getOriginalPlaybackInfo(auth, 'asset');
  assert.equal(info.container, 'mp4');
  assert.equal(info.width, 3200);
  assert.equal(info.bitrate, 7_760_000);
  assert.equal(info.audioCodec, 'aac');
  assert.equal(info.videoProfile, 1);
  assert.equal(Object.hasOwn(info, 'originalPath'), false, 'server paths are private');
  assert.equal(events.length, 0, 'checking Original should not open an encoder session');
  assert.equal(accesses[0].auth, auth);
});

test('network probe checks asset permissions before allocating one MiB, and metadata failure is safe', async () => {
  const { sut, accesses } = setup();
  const blob = await sut.getOriginalNetworkProbe(auth, 'asset');
  assert.equal(blob.byteLength, 1024 * 1024);
  assert.equal(accesses[0].auth, auth);
  sut.videoStreamRepository.getForTranscoding = async () => undefined;
  await assert.rejects(sut.getOriginalPlaybackInfo(auth, 'asset'), NotFoundException);
});

test('default master retains both configured codecs and authentication access checks', async () => {
  const { sut, events, accesses } = setup();
  const playlist = await sut.getMainPlaylist(auth, 'asset');
  assert.match(playlist, /CODECS="avc1\./);
  assert.match(playlist, /CODECS="hvc1\./);
  assert.doesNotMatch(playlist, /av01\./);
  assert.equal((playlist.match(/#EXT-X-STREAM-INF:/g) ?? []).length, 6);
  assert.equal(events.length, 1);
  assert.equal(accesses[0].auth, auth);
});

test('1800p source gets exact 3200x1800 HLS from configured 2160 rung without upscaling', async () => {
  const { sut } = setup({
    width: 3200, height: 1800, codecs: ['h264', 'hevc'],
    resolutions: [480, 720, 1080, 1440, 2160],
  });
  const playlist = await sut.getMainPlaylist(auth, 'asset');
  assert.match(playlist, /RESOLUTION=3200x1800/);
  assert.doesNotMatch(playlist, /RESOLUTION=3840x2160/);
  assert.ok(playlist.includes(`${sessionId}/13/playlist.m3u8`), 'HEVC uses stable 2160-rung index');
  assert.ok(playlist.includes(`${sessionId}/14/playlist.m3u8`), 'AVC uses stable 2160-rung index');
});

test('1800p source respects the configured resolution limit when 2160 is disabled', async () => {
  const { sut } = setup({
    width: 3200, height: 1800, codecs: ['h264', 'hevc'],
    resolutions: [480, 720, 1080, 1440],
  });
  const playlist = await sut.getMainPlaylist(auth, 'asset');
  assert.match(playlist, /RESOLUTION=2560x1440/);
  assert.doesNotMatch(playlist, /RESOLUTION=3200x1800/);
  assert.doesNotMatch(playlist, /\/13\/playlist\.m3u8/);
});

test('sources below the minimum ladder retain their real dimensions in the master', async () => {
  const { sut } = setup({ width: 320, height: 180 });
  const playlist = await sut.getMainPlaylist(auth, 'asset');
  assert.equal((playlist.match(/#EXT-X-STREAM-INF:/g) ?? []).length, 2);
  assert.match(playlist, /RESOLUTION=320x180/);
  assert.doesNotMatch(playlist, /RESOLUTION=853/);
});

for (const [videoCodec, token, excluded, indices] of [
  ['h264', 'avc1.', ['hvc1.', 'av01.'], [2, 5, 8]],
  ['hevc', 'hvc1.', ['avc1.', 'av01.'], [1, 4, 7]],
]) {
  test(`${videoCodec} query filters the ladder and preserves global variant indices`, async () => {
    const { sut } = setup({ codecs: ['h264', 'hevc', 'av1'] });
    const playlist = await sut.getMainPlaylist(auth, 'asset', videoCodec);
    assert.ok(playlist.includes(`CODECS="${token}`));
    for (const codec of excluded) assert.equal(playlist.includes(codec), false);
    assert.equal((playlist.match(/#EXT-X-STREAM-INF:/g) ?? []).length, indices.length);
    for (const index of indices) assert.ok(playlist.includes(`${sessionId}/${index}/playlist.m3u8`));
  });
}

for (const options of [
  { codecs: ['hevc'], requested: 'h264' },
  { codecs: ['h264'], requested: 'hevc' },
  { codecs: [], requested: undefined },
  { resolutions: [], requested: 'h264' },
]) {
  test(`empty intersection rejects before requesting a session: ${JSON.stringify(options)}`, async () => {
    const { sut, events } = setup(options);
    await assert.rejects(sut.getMainPlaylist(auth, 'asset', options.requested), NotFoundException);
    assert.equal(events.length, 0);
  });
}

test('disabled real-time streaming rejects before requesting a session', async () => {
  const { sut, events } = setup({ enabled: false });
  await assert.rejects(sut.getMainPlaylist(auth, 'asset', 'h264'), BadRequestException);
  assert.equal(events.length, 0);
});

test('master query schema accepts omitted, H.264, and HEVC codec requests', () => {
  for (const videoCodec of [undefined, 'h264', 'hevc']) {
    assert.equal(QueryDto.create({ videoCodec }).videoCodec, videoCodec);
  }
});

test('master query schema rejects unsupported, empty, repeated, and malformed codec requests', () => {
  for (const videoCodec of ['av1', 'vp9', '', 'H264', ['h264', 'hevc'], null, 1]) {
    assert.throws(() => QueryDto.create({ videoCodec }));
  }
});

test('master query schema tolerates existing authentication query parameters', () => {
  const result = QueryDto.create({ videoCodec: 'h264', key: 'fixture-key', password: 'fixture-password' });
  assert.equal(result.videoCodec, 'h264');
});
