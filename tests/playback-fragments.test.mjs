import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { PlaybackTimeline, audioSegments, copyVideoArgs, sharedAudioArgs, videoSeek } from '../overlays/server/src/utils/hls-playback.ts';
import { mp4Presentation } from './mp4-timeline.mjs';

// Explicit opt-in: this runs real FFmpeg and writes only disposable synthetic
// media. It tests muxing/timelines, not Rockchip throughput or browser behavior.
const ffmpeg = process.env.IMMICH_FFMPEG_BIN;
const ffprobe = process.env.IMMICH_FFPROBE_BIN;
const enabled = ffmpeg && ffprobe;
const compiledMedia = process.env.IMMICH_COMPILED_MEDIA
  ? await import(pathToFileURL(path.resolve(process.env.IMMICH_COMPILED_MEDIA))) : null;
const ffmpegJoin = (...parts) => path.join(...parts).replaceAll('\\', '/');
const scratchRoot = path.resolve(process.env.IMMICH_PLAYBACK_SCRATCH ?? 'work/playback-fragments');
if (enabled) mkdirSync(scratchRoot, { recursive: true });
function run(bin, args) {
  const result = spawnSync(bin, args, { encoding: 'utf8', timeout: 60_000, maxBuffer: 16 * 1024 * 1024 });
  assert.equal(result.status, 0, `${bin}: ${result.error ?? result.stderr}`);
  return result.stdout;
}
function probe(file) {
  return JSON.parse(run(ffprobe, ['-v', 'error', '-show_streams', '-show_packets', '-show_data_hash', 'sha256', '-of', 'json', file]));
}
function range(file, type) {
  const info = probe(file);
  const stream = info.streams.find((stream) => stream.codec_type === type);
  const packets = info.packets.filter((packet) => packet.stream_index === stream.index);
  return { ...mp4Presentation(readFileSync(file), type), packets };
}
function fragment(directory, index) {
  const file = path.join(directory, `check_${index}.mp4`);
  writeFileSync(file, Buffer.concat([readFileSync(path.join(directory, 'init.mp4')), readFileSync(path.join(directory, `seg_${index}.m4s`))]));
  run(ffmpeg, ['-v', 'error', '-xerror', '-i', file, '-f', 'null', '-']);
  return file;
}

for (const codec of ['h264', 'hevc']) {
  test(`real ${codec} Original remux preserves video payloads, presentation ranges and cold seeks`,
    { skip: !enabled && 'Set IMMICH_FFMPEG_BIN and IMMICH_FFPROBE_BIN to run real fragment checks' }, () => {
      const scratch = mkdtempSync(path.join(scratchRoot, `${codec}-`));
      const source = path.join(scratch, 'source.mp4');
      run(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=25:duration=10',
        '-c:v', codec === 'h264' ? 'libx264' : 'libx265', '-pix_fmt', 'yuv420p',
        ...(codec === 'h264' ? ['-g', '50', '-keyint_min', '50', '-sc_threshold', '0', '-bf', '2']
          : ['-x265-params', 'keyint=50:min-keyint=50:scenecut=0:open-gop=1:bframes=3:pools=1:frame-threads=1']), source]);
      const info = probe(source);
      const timeline = new PlaybackTimeline();
      for (const packet of info.packets) timeline.packet(+packet.pts_time, +packet.duration_time, packet.flags);
      const segments = timeline.finish();
      assert.ok(segments, 'source must establish an adaptive copy grid');
      const full = path.join(scratch, 'full'); mkdirSync(full);
      const video = { index: 0, codecName: codec };
      run(ffmpeg, copyVideoArgs(source, video, segments, 0, full, ffmpegJoin));
      const hashes = [];
      for (let i = 0; i < segments.length; i++) {
        const actual = range(fragment(full, i), 'video');
        assert.ok(Math.abs(actual.start - segments[i].start) < .001, `segment ${i} starts at ${actual.start}, expected ${segments[i].start}`);
        assert.ok(Math.abs(actual.end - segments[i].start - segments[i].duration) < .001, `segment ${i} ends at ${actual.end}`);
        hashes.push(...actual.packets.map((p) => p.data_hash));
      }
      assert.deepEqual(hashes, info.packets.map((p) => p.data_hash), 'Original must keep video packet payloads');
      const cold = path.join(scratch, 'cold'); mkdirSync(cold);
      run(ffmpeg, copyVideoArgs(source, video, segments, 2, cold, ffmpegJoin));
      const actual = range(fragment(cold, 2), 'video');
      assert.ok(Math.abs(actual.start - segments[2].start) < .001);
      assert.deepEqual(actual.packets.map((p) => p.data_hash), range(fragment(full, 2), 'video').packets.map((p) => p.data_hash));
      if (compiledMedia) {
        // Exercise the actual compiled BaseConfig timeline path using software
        // encoding here. The same forced-IDR plan still needs RKMPP board checks.
        const stream = info.streams[0];
        const timeBase = Number(stream.time_base.split('/')[1]);
        const totalDuration = info.packets.reduce((sum, packet) => sum + Number(packet.duration), 0);
        const metadata = { ...video, rotation: 0, width: stream.width, height: stream.height,
          timeBase, frameCount: info.packets.length, pixelFormat: 'yuv420p', colorTransfer: 1 };
        const config = compiledMedia.BaseConfig.create({ accel: 'disabled', targetVideoCodec: 'h264',
          targetAudioCodec: 'aac', targetResolution: '180', tonemap: 'disabled', preset: 'ultrafast',
          crf: 23, cqMode: 'auto', maxBitrate: '0', twoPass: false, threads: 2, bframes: 0, refs: 0, gopSize: 275 },
        { dri: [], mali: false }, { strictGop: true, lowLatency: true });
        for (const startSegment of [0, 2]) {
          const encoded = path.join(scratch, `encoded-${startSegment}`); mkdirSync(encoded);
          const args = config.getHlsCommand({ inputPath: source, packetCount: info.packets.length, timeBase,
            totalDuration, initFilename: 'init.mp4', playlistFilename: ffmpegJoin(encoded, 'playlist.m3u8'),
            segmentFilename: ffmpegJoin(encoded, 'seg_%d.m4s'), segmentDuration: 2, startSegment,
            target: 'ALL', seekSeconds: videoSeek(segments, startSegment, false),
            playback: { starts: segments.map((segment) => segment.start), start: segments[startSegment].start,
              duration: segments.at(-1).start + segments.at(-1).duration } }, metadata);
          run(ffmpeg, args);
          for (let i = startSegment; i < segments.length; i++) {
            const output = range(fragment(encoded, i), 'video');
            assert.ok(Math.abs(output.start - segments[i].start) < .001, `encoded ${codec}/${i}: ${output.start}`);
            assert.ok(Math.abs(output.end - segments[i].start - segments[i].duration) < .001, `encoded ${codec}/${i} end: ${output.end}`);
          }
        }
      }
    });
}

test('real shared AAC pads a short source through the video tail and retains cold-seek clock',
  { skip: !enabled && 'Set IMMICH_FFMPEG_BIN and IMMICH_FFPROBE_BIN to run real fragment checks' }, () => {
    const scratch = mkdtempSync(path.join(scratchRoot, 'audio-'));
    const source = path.join(scratch, 'source.mkv');
    run(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=25:duration=10',
      '-f', 'lavfi', '-i', 'sine=frequency=1000:sample_rate=44100:duration=3',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'flac', source]);
    const segments = audioSegments(10);
    for (const start of [0, 3]) {
      const directory = path.join(scratch, String(start)); mkdirSync(directory);
      run(ffmpeg, sharedAudioArgs(source, { index: 1 }, 10, start, directory, ffmpegJoin));
      for (let i = start; i < segments.length; i++) {
        const actual = range(fragment(directory, i), 'audio');
        assert.ok(Math.abs(actual.start - segments[i].start) < .001, `audio ${start}/${i}: ${actual.start}, expected ${segments[i].start}`);
        assert.ok(Math.abs(actual.end - segments[i].start - segments[i].duration) < .001, `audio ${start}/${i} ends at ${actual.end}`);
      }
    }
  });
