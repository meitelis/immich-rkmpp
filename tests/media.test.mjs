import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import test from 'node:test';

// Exercise the exact patched module without installing the whole Immich server.
// IMMICH_MEDIA_SOURCE also accepts the patched TypeScript source during development.
const sourcePath = process.env.IMMICH_MEDIA_SOURCE
  ? resolve(process.env.IMMICH_MEDIA_SOURCE)
  : fileURLToPath(new URL('../overlays/server/src/utils/media.ts', import.meta.url));
let source = readFileSync(sourcePath, 'utf8').replace(/^import[\s\S]*?from\s+['"][^'"]+['"];\s*/gm, '');
if (sourcePath.endsWith('.ts')) {
  source = stripTypeScriptTypes(source, { mode: 'transform' });
}
source = source.replace(/\bexport\s+/g, '');

const VideoCodec = { H264: 'h264', Hevc: 'hevc', Vp9: 'vp9', Av1: 'av1' };
const TranscodeTarget = { All: 'ALL', Video: 'VIDEO', Audio: 'AUDIO', None: 'NONE' };
const context = vm.createContext({
  VideoCodec,
  TranscodeTarget,
  AacProfile: { Lc: 2 },
  TranscodeHardwareAcceleration: { Rkmpp: 'rkmpp', Disabled: 'disabled' },
  ToneMapping: { Disabled: 'disabled', Hable: 'hable' },
  ColorTransfer: { Smpte2084: 16, AribStdB67: 18 },
  CQMode: { Cqp: 'cqp' },
  AUDIO_ENCODER: { aac: 'aac' },
  SUPPORTED_HWA_CODECS: { rkmpp: ['h264', 'hevc'] },
  H264_LEVELS: [
    { maxFrame: 1620, maxRate: 40500, token: '1e' },
    { maxFrame: 3600, maxRate: 108000, token: '1f' },
    { maxFrame: 5120, maxRate: 216000, token: '20' },
    { maxFrame: 8192, maxRate: 245760, token: '28' },
    { maxFrame: 8704, maxRate: 522240, token: '2a' },
    { maxFrame: 22080, maxRate: 589824, token: '32' },
    { maxFrame: 36864, maxRate: 983040, token: '33' },
    { maxFrame: 36864, maxRate: 2073600, token: '34' },
  ],
  HEVC_LEVELS: [
    { maxFrame: 552960, maxRate: 16588800, token: 'L90' },
    { maxFrame: 983040, maxRate: 33177600, token: 'L93' },
    { maxFrame: 2228224, maxRate: 66846720, token: 'L120' },
    { maxFrame: 2228224, maxRate: 133693440, token: 'L123' },
    { maxFrame: 8912896, maxRate: 267386880, token: 'L150' },
    { maxFrame: 8912896, maxRate: 534773760, token: 'L153' },
    { maxFrame: 8912896, maxRate: 1069547520, token: 'L156' },
  ],
});
vm.runInContext(`${source}\n;globalThis.media = { BaseConfig, RkmppHwDecodeConfig, RkmppSwDecodeConfig, getOutputSize };`, context);
const { BaseConfig, getOutputSize } = context.media;

const video = (overrides = {}) => ({
  index: 0,
  width: 1280,
  height: 720,
  rotation: 0,
  pixelFormat: 'yuv420p10le',
  codecName: 'hevc',
  colorTransfer: 16,
  frameCount: 300,
  ...overrides,
});
const config = (overrides = {}) => ({
  accel: 'rkmpp',
  accelDecode: true,
  targetVideoCodec: 'hevc',
  targetAudioCodec: 'aac',
  targetResolution: '1080',
  preferredHwDevice: 'auto',
  tonemap: 'hable',
  preset: 'fast',
  crf: 26,
  cqMode: 'auto',
  maxBitrate: '0',
  twoPass: false,
  threads: 0,
  bframes: -1,
  refs: 0,
  gopSize: 60,
  ...overrides,
});
const handler = (mali, overrides = {}, tune) =>
  BaseConfig.create(config(overrides), { dri: ['renderD128'], mali }, tune);
const plain = (value) => JSON.parse(JSON.stringify(value));
const argument = (args, name) => args[args.indexOf(name) + 1];

test('Memories hardware commands keep video on its source grid without muxed audio or process suspension', () => {
  const args = handler(false, { gopSize: 330, maxBitrate: '1200k' }, { strictGop: true, lowLatency: true }).getHlsCommand({
    inputPath: '/fixture.mp4', packetCount: 300, timeBase: 1, totalDuration: 10,
    segmentDuration: 2, initFilename: 'init.mp4', segmentFilename: '/hls/seg_%d.m4s',
    startSegment: 1, seekSeconds: 0.00001, playlistFilename: '/hls/playlist.m3u8', target: 'ALL',
    playback: { starts: [0, 2.04, 4.08, 6.12, 8.16], start: 2.04, duration: 10 },
  }, video({ colorTransfer: 1 }));
  assert.equal(argument(args, '-readrate_initial_burst'), '18');
  assert.equal(args.includes('-readrate_catchup'), false, 'the pinned Immich FFmpeg does not support this flag');
  assert.equal(argument(args, '-fps_mode'), 'passthrough');
  assert.ok(args.includes('-noaccurate_seek'));
  assert.ok(args.includes('-an'));
  assert.equal(argument(args, '-bf'), '0');
  assert.equal(argument(args, '-flags:v'), '+low_delay');
  assert.equal(argument(args, '-force_key_frames'), '2.039999000,4.079999000,6.119999000,8.159999000');
  assert.match(argument(args, '-vf'), /^trim=start=2.039999000,/);
  assert.equal(argument(args, '-hls_time'), '0.00001');
  assert.equal(argument(args, '-rc_mode'), 'VBR');
  assert.equal(argument(args, '-maxrate'), '1200k');
  assert.equal(argument(args, '-bufsize'), '2400k');
});

test('480p advertised dimensions match FFmpeg nearest-even scaling in both orientations', () => {
  assert.deepEqual(plain(getOutputSize(video({ width: 3840, height: 2160 }), 480)), { width: 854, height: 480 });
  assert.deepEqual(plain(getOutputSize(video({ width: 2160, height: 3840 }), 480)), { width: 480, height: 854 });
  assert.deepEqual(plain(getOutputSize(video({ width: 3840, height: 2160, rotation: 90 }), 480)), { width: 480, height: 854 });
});

test('HLS hardware levels match the rendition dimensions and exact frame rate', () => {
  const cases = [
    [480, 30, 31, 90], [720, 30, 31, 93], [1080, 30, 40, 120],
    [1440, 30, 50, 150], [2160, 30, 51, 150], [2160, 60, 52, 153],
  ];
  for (const [resolution, fps, avcLevel, hevcLevel] of cases) {
    for (const [codec, expected] of [['h264', avcLevel], ['hevc', hevcLevel]]) {
      const sut = handler(false, { targetResolution: String(resolution), targetVideoCodec: codec });
      const args = sut.getHlsCommand({
        inputPath: '/fixture.mp4', packetCount: fps * 12, timeBase: 1, totalDuration: 12,
        segmentDuration: 2, initFilename: 'init.mp4', segmentFilename: '/hls/seg_%d.m4s',
        startSegment: 0, playlistFilename: '/hls/playlist.m3u8', target: TranscodeTarget.All,
      }, video({ width: 3840, height: 2160, colorTransfer: 1 }));
      assert.equal(argument(args, '-level'), String(expected), `${codec} ${resolution}p/${fps}`);
      assert.equal(argument(sut.getPresetOptions(), '-level'), codec === 'h264' ? '51' : '153', 'offline defaults stay unchanged');
    }
  }
});

for (const mali of [false, true]) {
  const pipeline = mali ? 'Mali' : 'CPU';

  test(`${pipeline} HDR preserves a 720p source below the 1080p limit`, () => {
    const filters = plain(handler(mali).getFilterOptions(video()));
    assert.equal(filters[0], 'scale_rkrga=format=p010:afbc=1:async_depth=4');
    assert.equal(filters.some((filter) => filter.includes('tonemap_opencl=')), mali);
    assert.equal(filters.some((filter) => filter.includes('tonemapx=')), !mali);
  });

  test(`${pipeline} HDR still downsizes 1080p to the 720p limit`, () => {
    const filters = plain(handler(mali, { targetResolution: '720' }).getFilterOptions(video({ width: 1920, height: 1080 })));
    assert.equal(filters[0], 'scale_rkrga=-2:720:format=p010:afbc=1:async_depth=4');
  });

  test(`${pipeline} HDR preserves stored portrait dimensions while downsizing`, () => {
    const filters = plain(handler(mali, { targetResolution: '480' }).getFilterOptions(video({ width: 720, height: 1280 })));
    assert.equal(filters[0], 'scale_rkrga=480:-2:format=p010:afbc=1:async_depth=4');
  });

  test(`${pipeline} HDR original resolution only converts the pixel surface`, () => {
    const filters = plain(handler(mali, { targetResolution: 'original' }).getFilterOptions(video()));
    assert.equal(filters[0], 'scale_rkrga=format=p010:afbc=1:async_depth=4');
  });
}

for (const codec of ['hevc', 'h264']) {
  const hlsOptions = {
    inputPath: '/fixture.mp4', packetCount: 300, timeBase: 1, totalDuration: 10,
    segmentDuration: 2, initFilename: 'init.mp4', segmentFilename: '/hls/seg_%d.m4s',
    startSegment: 3, seekSeconds: 5.983333, playlistFilename: '/hls/playlist.m3u8', target: TranscodeTarget.All,
  };
  const compatibleAudio = { index: 1, codecName: 'aac', profile: 2, bitrate: 192_000, channels: 2, sampleRate: 48_000 };

  test(`${codec} HLS preserves ordinary AAC-LC packets without changing offline conversion`, () => {
    const sut = handler(false, { targetVideoCodec: codec });
    for (const channels of [1, 2]) {
      for (const sampleRate of [32_000, 44_100, 48_000]) {
        const audio = { ...compatibleAudio, channels, sampleRate };
        const args = plain(sut.getHlsCommand(hlsOptions, video({ colorTransfer: 1 }), audio));
        assert.equal(argument(args, '-c:v'), `${codec}_rkmpp`);
        assert.equal(argument(args, '-c:a'), 'copy');
        assert.equal(args.includes('-ac'), false, 'Stream copy must not receive an audio conversion option');
        assert.equal(argument(args, '-ss'), '5.983333');
        assert.ok(args.includes('-copyts'), 'Source clock must remain intact');
        assert.equal(argument(args, '-bsf:a'), 'noise=amount=0:drop=lt(pts*tb\\,6)',
          'Copied audio preroll must be discarded at the exact GOP boundary, not the midpoint seek');
        const offline = plain(sut.getCommand(TranscodeTarget.All, video({ colorTransfer: 1 }), audio));
        assert.equal(argument(offline.outputOptions, '-c:a'), 'aac');
        assert.equal(argument(offline.outputOptions, '-ac'), '2');
      }
    }
  });

  test(`${codec} copied AAC trims fractional-rate seeks without rewriting timestamps or initial packets`, () => {
    const sut = handler(false, { targetVideoCodec: codec });
    const fractionalOptions = { ...hlsOptions, packetCount: 300, timeBase: 30_000, totalDuration: 300_300 };
    const args = plain(sut.getHlsCommand(fractionalOptions, video({ colorTransfer: 1 }), compatibleAudio));
    const fps = 300 * 30_000 / 300_300;
    const boundary = 3 * Math.ceil(2 * fps) / fps;
    assert.equal(argument(args, '-bsf:a'), `noise=amount=0:drop=lt(pts*tb\\,${boundary})`);
    assert.ok(args.includes('-copyts'));
    assert.equal(args.includes('-start_at_zero'), false);
    const initial = plain(sut.getHlsCommand({ ...hlsOptions, startSegment: 0, seekSeconds: 0 }, video(), compatibleAudio));
    assert.equal(initial.includes('-bsf:a'), false, 'Initial AAC priming must remain intact');
  });

  test(`${codec} HLS encodes incompatible, unknown, surround and high-rate audio`, () => {
    const sut = handler(false, { targetVideoCodec: codec });
    const cases = [
      { codecName: 'flac' }, { codecName: 'pcm_s16le' }, { codecName: 'opus' },
      { profile: 5 }, { profile: null }, { channels: 6 }, { channels: undefined },
      { sampleRate: 96_000 }, { sampleRate: undefined },
      { bitrate: 0 }, { bitrate: Number.NaN }, { bitrate: 320_000 },
    ];
    for (const override of cases) {
      const args = plain(sut.getHlsCommand(hlsOptions, video({ colorTransfer: 1 }), { ...compatibleAudio, ...override }));
      assert.equal(argument(args, '-c:a'), 'aac', JSON.stringify(override));
      assert.equal(argument(args, '-ac'), '2');
      assert.equal(args.includes('-bsf:a'), false, 'Decoded audio uses normal accurate seeking');
    }
    const explicitAudio = plain(sut.getHlsCommand({ ...hlsOptions, target: TranscodeTarget.Audio }, video(), compatibleAudio));
    assert.equal(argument(explicitAudio, '-c:a'), 'aac', 'An explicit audio conversion must remain an audio conversion');
  });

  test(`${codec} normalizes full-size 10-bit SDR to NV12 and keeps hardware encoding`, () => {
    const command = plain(handler(false, { targetVideoCodec: codec }).getCommand(TranscodeTarget.All, video({ colorTransfer: 1 })));
    assert.equal(argument(command.outputOptions, '-vf'), 'scale_rkrga=format=nv12:afbc=1:async_depth=4');
    assert.equal(argument(command.outputOptions, '-c:v'), `${codec}_rkmpp`);
    assert.equal(command.twoPass, false);
    if (codec === 'hevc') assert.equal(argument(command.outputOptions, '-tag:v'), 'hvc1');
  });

  test(`${codec} HLS retains matching segment clocks, strict GOP and AAC audio`, () => {
    const args = plain(handler(false, { targetVideoCodec: codec }, { strictGop: true, lowLatency: true }).getHlsCommand({
      seekSeconds: 5.983333,
      inputPath: '/fixture.mp4',
      packetCount: 300,
      timeBase: 1,
      totalDuration: 10,
      segmentDuration: 2,
      initFilename: 'init.mp4',
      segmentFilename: '/hls/seg_%d.m4s',
      startSegment: 3,
      playlistFilename: '/hls/playlist.m3u8',
      target: TranscodeTarget.All,
    }, video({ colorTransfer: 1 }), { index: 1, codecName: 'aac' }));
    assert.equal(argument(args, '-c:v'), `${codec}_rkmpp`);
    assert.equal(argument(args, '-c:a'), 'aac');
    assert.equal(argument(args, '-ac'), '2');
    assert.equal(argument(args, '-g'), '60');
    assert.equal(argument(args, '-keyint_min'), '60');
    assert.equal(argument(args, '-r'), '300/10');
    assert.equal(argument(args, '-ss'), '5.983333');
    assert.equal(argument(args, '-start_number'), '3');
    assert.equal(argument(args, '-hls_segment_type'), 'fmp4');
    assert.equal(argument(args, '-hls_flags'), 'temp_file');
  });

  test(`${codec} software decoding fallback still selects the MPP encoder`, () => {
    const command = plain(handler(false, { targetVideoCodec: codec, accelDecode: false }).getCommand(TranscodeTarget.All, video({ colorTransfer: 1 })));
    assert.equal(command.inputOptions.includes('-hwaccel'), false);
    assert.equal(argument(command.outputOptions, '-c:v'), `${codec}_rkmpp`);
  });
}
