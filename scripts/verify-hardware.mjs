#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { watch } from 'node:fs';
import { appendFile, mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';

const usage = `Usage: node verify-hardware.mjs --scratch /tmp/immich-rkmpp-verify [--quick] [--hdr] [--sdr10] [--small] [--audio] [--fallback] [--rotation] [--label patched]

Run inside an Immich v3.3.5 test container with the Rockchip devices exposed.
Creates synthetic media only, serially tests all five HLS resolutions in HEVC
and H264, then tests middle seeks at 1080p and 2160p. Every fMP4 fragment must
start with a keyframe and pass independent strict software decoding.
--quick uses six seconds of SDR instead of twelve. Optional HDR/SDR10 tests use
six-second 720p 10-bit fixtures and require libx265. --small verifies a source
below the minimum rendition size without upscaling it.
--audio adds mono 44.1 kHz AAC copy/cold seeks and lossless PCM/FLAC conversion.
All generated files and report.json stay in a new directory under --scratch.
No application configuration, database, or existing media is read or changed.`;

function options(argv) {
  const out = { quick: false, hdr: false, sdr10: false, small: false, audio: false, fallback: false, rotation: false, label: 'unlabelled', appDist: '/usr/src/app/server/dist' };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help') { console.log(usage); process.exit(0); }
    if (['--quick', '--hdr', '--sdr10', '--small', '--audio', '--fallback', '--rotation'].includes(arg)) { out[arg.slice(2)] = true; continue; }
    if (['--scratch', '--label', '--app-dist'].includes(arg) && argv[i + 1]) {
      const name = arg === '--app-dist' ? 'appDist' : arg.slice(2);
      out[name] = argv[++i];
      continue;
    }
    throw new Error(`Unknown or incomplete argument: ${arg}`);
  }
  if (!out.scratch || !path.isAbsolute(out.scratch) || path.resolve(out.scratch) === path.parse(path.resolve(out.scratch)).root) {
    throw new Error('--scratch must name an absolute, non-root scratch directory');
  }
  if (!/^[a-zA-Z0-9_.-]{1,40}$/.test(out.label)) throw new Error('--label must contain 1–40 letters, numbers, dots, underscores, or hyphens');
  return out;
}

const opts = options(process.argv.slice(2));
await mkdir(opts.scratch, { recursive: true });
const scratch = await mkdtemp(path.join(path.resolve(opts.scratch), 'run-'));
const reportPath = path.join(scratch, 'report.json');
const cleanError = (error) => String(error?.stack ?? error).replaceAll(scratch, '<scratch>').slice(-12_000);
const report = { schemaVersion: 1, label: opts.label, node: process.version, quick: opts.quick, cases: [], errors: [], complete: false };
const saveReport = () => writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);

function run(bin, args, { timeoutMs = 180_000, onStart } = {}) {
  return new Promise((resolve, reject) => {
    const start = performance.now();
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (data) => { stdout = (stdout + data).slice(-2_000_000); });
    child.stderr.on('data', (data) => { stderr = (stderr + data).slice(-64_000); });
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      const result = { code, signal, stdout, stderr, wallMs: performance.now() - start };
      if (timedOut || code !== 0) {
        const error = new Error(`${bin} ${timedOut ? 'timed out' : `exited ${code ?? signal}`}\n${stderr}`);
        error.result = result;
        reject(error);
      } else resolve(result);
    });
    onStart?.(start);
  });
}

const ffmpeg = (args, extra) => run('ffmpeg', ['-hide_banner', '-loglevel', 'warning', ...args], extra);
const ffprobe = async (filename, packets = false) => JSON.parse((await run('ffprobe', [
  '-v', 'error', '-show_streams', '-show_format', ...(packets ? ['-show_packets', '-show_data_hash', 'sha256'] : []), '-of', 'json', filename,
])).stdout);
const rational = (value) => { const [a, b = '1'] = String(value).split('/'); return Number(a) / Number(b); };
const rotation = (stream) => Number(stream.side_data_list?.find((item) => item.rotation !== undefined)?.rotation ?? stream.tags?.rotate ?? 0);
const displayDimensions = (stream) => Math.abs(rotation(stream)) % 180 === 90
  ? { width: stream.height, height: stream.width }
  : { width: stream.width, height: stream.height };

function videoMetadata(info) {
  const stream = info.streams.find((item) => item.codec_type === 'video');
  assert.ok(stream, 'Synthetic fixture must contain video');
  const [timeNumerator, timeDenominator] = stream.time_base.split('/').map(Number);
  assert.equal(timeNumerator, 1, 'Synthetic fixture must use a reciprocal integer time base');
  const packets = info.packets.filter((item) => item.stream_index === stream.index);
  const packetCount = packets.filter((item) => item.flags?.[1] !== 'D').length;
  const totalDuration = packets.reduce((sum, item) => sum + Number(item.duration), 0);
  assert.ok(packetCount > 0 && totalDuration > 0, 'Synthetic fixture must have packet durations');
  const video = {
    index: stream.index, width: stream.width, height: stream.height, rotation: rotation(stream),
    codecName: stream.codec_name, profile: null, level: stream.level ?? null,
    frameCount: packetCount, frameRate: rational(stream.avg_frame_rate), timeBase: timeDenominator,
    bitrate: Number(stream.bit_rate ?? 0), pixelFormat: stream.pix_fmt,
    colorPrimaries: stream.color_primaries === 'bt2020' ? 9 : 1,
    colorMatrix: stream.color_space === 'bt2020nc' ? 9 : 1,
    colorTransfer: stream.color_transfer === 'smpte2084' ? 16 : stream.color_transfer === 'arib-std-b67' ? 18 : 1,
    dvProfile: null, dvLevel: null, dvBlSignalCompatibilityId: null,
  };
  const audioSource = info.streams.find((item) => item.codec_type === 'audio');
  const audio = audioSource ? {
    index: audioSource.index, codecName: audioSource.codec_name, profile: audioSource.profile === 'LC' ? 2 : null,
    bitrate: Number(audioSource.bit_rate ?? 0), channels: audioSource.channels, sampleRate: Number(audioSource.sample_rate),
  } : undefined;
  const audioPackets = audio ? info.packets.filter((item) => item.stream_index === audio.index) : [];
  return { video, audio, audioPackets, packets: { packetCount, totalDuration }, fps: packetCount * timeDenominator / totalDuration };
}

try {
  const [media, configuration, constants, enums] = await Promise.all([
    import(pathToFileURL(path.join(opts.appDist, 'utils/media.js')).href),
    import(pathToFileURL(path.join(opts.appDist, 'dtos/config.dto.js')).href),
    import(pathToFileURL(path.join(opts.appDist, 'constants.js')).href),
    import(pathToFileURL(path.join(opts.appDist, 'enum.js')).href),
  ]);
  const { BaseConfig, getOutputSize, getCodecString } = media;
  const { HLS_VARIANTS, HLS_CRF, HLS_SEGMENT_DURATION } = constants;
  const { TranscodeTarget } = enums;
  const defaults = configuration.defaults.ffmpeg;
  const duration = opts.quick ? 6 : 12;
  const interfaces = { dri: (await readdir('/dev/dri')).filter((name) => /^(renderD|card)/.test(name)), mali: false };
  try { interfaces.mali = (await readdir('/dev')).includes('mali0'); } catch {}
  report.hardwareInterfaces = { dri: interfaces.dri, mali: interfaces.mali };
  report.ffmpeg = (await run('ffmpeg', ['-version'])).stdout.split('\n')[0];
  report.source = { width: 3840, height: 2160, fps: 30, durationSeconds: duration };
  const fixture = path.join(scratch, 'synthetic-sdr-4k30.mp4');
  await ffmpeg([
    '-nostdin', '-filter_threads', '1', '-f', 'lavfi', '-i', 'testsrc2=size=3840x2160:rate=30',
    '-f', 'lavfi', '-i', 'sine=frequency=1000:sample_rate=48000', '-t', String(duration),
    '-map', '0:v:0', '-map', '1:a:0', '-vf', 'format=nv12', '-c:v', 'h264_rkmpp',
    '-rc_mode', 'CQP', '-qp_init', '26', '-g', '60', '-bf', '0', '-c:a', 'aac',
    '-ac', '2', '-ar', '48000', '-b:a', '128k', '-movflags', '+faststart', fixture,
  ]);
  const source = videoMetadata(await ffprobe(fixture, true));
  report.source.packetCount = source.packets.packetCount;
  report.source.measuredFps = source.fps;

  async function verifyCase({ name, input = fixture, metadata = source, resolution, codec, startSegment = 0, mali = interfaces.mali, accelDecode = true, belowLimit = false }) {
    const entry = { name, codec, resolution, startSegment, mali, accelDecode, ok: false };
    report.cases.push(entry);
    const directory = path.join(scratch, name);
    await mkdir(directory);
    let watcher;
    try {
      const variant = HLS_VARIANTS.find((item) => item.codec === codec && item.resolution === resolution);
      assert.ok(variant, `Missing upstream ${codec}/${resolution} variant`);
      const gop = Math.ceil(HLS_SEGMENT_DURATION * metadata.fps);
      const seekSeconds = startSegment > 0 ? (startSegment * gop - 0.5) / metadata.fps : 0;
      const config = BaseConfig.create({
        ...defaults, accel: 'rkmpp', accelDecode, targetVideoCodec: codec,
        targetResolution: String(resolution), maxBitrate: `${Math.round(variant.bitrate / 1000)}k`,
        gopSize: gop, crf: HLS_CRF[codec], targetAudioCodec: 'aac',
      }, { ...interfaces, mali }, { strictGop: true, lowLatency: true });
      const args = config.getHlsCommand({
        initFilename: 'init.mp4', inputPath: input, packetCount: metadata.packets.packetCount,
        playlistFilename: path.join(directory, 'playlist.m3u8'), seekSeconds,
        segmentDuration: HLS_SEGMENT_DURATION, segmentFilename: path.join(directory, 'seg_%d.m4s'),
        startSegment, target: TranscodeTarget.All, timeBase: metadata.video.timeBase,
        totalDuration: metadata.packets.totalDuration,
      }, metadata.video, metadata.audio);
      entry.encoder = args[args.indexOf('-c:v') + 1];
      assert.equal(entry.encoder, `${codec}_rkmpp`, 'Video must use the requested hardware encoder');
      entry.audioEncoder = metadata.audio ? args[args.indexOf('-c:a') + 1] : null;
      const copyAudio = metadata.audio?.codecName === 'aac' && metadata.audio.profile === 2 &&
        [1, 2].includes(metadata.audio.channels) && [32_000, 44_100, 48_000].includes(metadata.audio.sampleRate) &&
        metadata.audio.bitrate > 0 && metadata.audio.bitrate <= 256_000;
      if (metadata.audio) assert.equal(entry.audioEncoder, copyAudio ? 'copy' : 'aac', 'Unexpected HLS audio policy');
      entry.filter = args.includes('-vf') ? args[args.indexOf('-vf') + 1] : null;
      entry.seekSeconds = seekSeconds;
      entry.gop = gop;
      let started = performance.now();
      watcher = watch(directory, (event, filename) => {
        if (/^seg_\d+\.m4s$/.test(String(filename)) && entry.firstSegmentMs === undefined) {
          entry.firstSegmentMs = Math.round(performance.now() - started);
        }
      });
      const encoded = await ffmpeg(['-progress', 'pipe:1', '-stats_period', '0.25', ...args], { onStart: (value) => { started = value; } });
      watcher.close(); watcher = undefined;
      entry.encodeWallMs = Math.round(encoded.wallMs);
      entry.ffmpegSpeed = [...encoded.stdout.matchAll(/^speed=([^\n]+)/gm)].at(-1)?.[1]?.trim() ?? null;
      const filenames = (await readdir(directory)).filter((name) => /^seg_\d+\.m4s$/.test(name))
        .sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]));
      const expectedFrames = metadata.packets.packetCount - startSegment * gop;
      assert.ok(filenames.length > 0, 'No complete HLS fragments were created');
      assert.equal(Number(filenames[0].match(/\d+/)[0]), startSegment, 'First segment number must match the cold seek');
      assert.equal(filenames.length, Math.ceil(expectedFrames / gop), 'Unexpected segment count');
      const expected = belowLimit
        ? displayDimensions({ width: metadata.video.width, height: metadata.video.height, side_data_list: [{ rotation: metadata.video.rotation }] })
        : getOutputSize(metadata.video, resolution);
      entry.expectedDisplay = expected;
      entry.fragments = [];
      let totalFrames = 0;
      let lastAudioEnd;
      for (const filename of filenames) {
        const segmentIndex = Number(filename.match(/\d+/)[0]);
        const joined = path.join(directory, 'independent-fragment.mp4');
        await writeFile(joined, await readFile(path.join(directory, 'init.mp4')));
        await appendFile(joined, await readFile(path.join(directory, filename)));
        const info = await ffprobe(joined, true);
        const stream = info.streams.find((item) => item.codec_type === 'video');
        assert.ok(stream, 'Fragment must contain a video stream');
        assert.equal(stream.codec_name, codec, 'Encoded codec differs from requested codec');
        const displayed = displayDimensions(stream);
        assert.equal(displayed.width, expected.width, 'Encoded display width differs from the advertised rendition');
        assert.equal(displayed.height, expected.height, 'Encoded display height differs from the advertised rendition');
        const advertisedCodec = getCodecString(codec, expected.width, expected.height, metadata.fps);
        const advertisedLevel = codec === 'h264'
          ? Number.parseInt(advertisedCodec.slice(-2), 16)
          : Number(advertisedCodec.split('.')[3].slice(1));
        assert.equal(stream.level, advertisedLevel, 'Encoded codec level differs from the capability declaration');
        const packets = info.packets.filter((item) => item.stream_index === stream.index);
        assert.ok(packets.length > 0, 'Fragment contains no video packets');
        assert.ok(packets[0].flags?.includes('K'), 'Fragment must begin with a keyframe');
        const firstPts = Number(packets[0].pts_time);
        assert.ok(Math.abs(firstPts - segmentIndex * gop / metadata.fps) <= 2 / metadata.fps,
          `Fragment timestamp ${firstPts} differs from the shared rendition clock`);
        if (filename !== filenames.at(-1)) assert.equal(packets.length, gop, 'A full segment must contain exactly one GOP');
        const audio = info.streams.find((item) => item.codec_type === 'audio');
        let audioFirstPts, audioEndPts;
        if (metadata.audio) {
          assert.equal(audio?.codec_name, 'aac');
          assert.equal(audio?.channels, copyAudio ? metadata.audio.channels : 2);
          const audioPackets = info.packets.filter((item) => item.stream_index === audio.index);
          assert.ok(audioPackets.length > 0, 'Fragment must contain audio packets');
          audioFirstPts = Number(audioPackets[0].pts_time);
          const last = audioPackets.at(-1);
          audioEndPts = Number(last.pts_time) + Number(last.duration_time);
          const sampleRate = Number(audio.sample_rate);
          assert.ok(Math.abs(audioFirstPts - firstPts) <= 1024 / sampleRate + 1 / sampleRate,
            `Audio begins at ${audioFirstPts}, outside the video fragment boundary ${firstPts}`);
          if (lastAudioEnd !== undefined) assert.ok(Math.abs(audioFirstPts - lastAudioEnd) <= 2 / sampleRate,
            'Adjacent HLS fragments must have a continuous audio clock');
          if (copyAudio) {
            const sourceBySample = new Map(metadata.audioPackets.map((packet) =>
              [Math.round(Number(packet.pts_time) * metadata.audio.sampleRate), packet]));
            for (const packet of audioPackets) {
              const original = sourceBySample.get(Math.round(Number(packet.pts_time) * sampleRate));
              assert.ok(original, 'Copied audio packet must retain its source timestamp');
              assert.ok(packet.data_hash && packet.data_hash === original.data_hash,
                'Copied audio packet payload must be identical to its source');
            }
          }
          await ffmpeg(['-xerror', '-err_detect', 'explode', '-threads', '2', '-i', joined,
            '-map', '0:a:0', '-vn', '-f', 'null', '-']);
          lastAudioEnd = audioEndPts;
        }
        const decoded = await ffmpeg(['-xerror', '-err_detect', 'explode', '-threads', '2', '-i', joined,
          '-map', '0:v:0', '-an', '-fps_mode', 'passthrough', '-progress', 'pipe:1', '-f', 'null', '-']);
        const decodedFrames = Number([...decoded.stdout.matchAll(/^frame=(\d+)/gm)].at(-1)?.[1] ?? 0);
        assert.equal(decodedFrames, packets.length, 'Independent strict decode must recover every video frame');
        entry.fragments.push({ index: segmentIndex, frames: packets.length, firstPts, width: stream.width, height: stream.height,
          rotation: rotation(stream), codec: stream.codec_name, level: stream.level, independentStrictDecode: true,
          ...(metadata.audio ? { audioFirstPts, audioEndPts, audioStrictDecode: true, audioSourcePacketsPreserved: copyAudio } : {}) });
        totalFrames += packets.length;
      }
      assert.ok(Math.abs(totalFrames - expectedFrames) <= 1, `Output contains ${totalFrames} frames; expected ${expectedFrames}`);
      entry.frames = totalFrames;
      entry.wallFps = Number((totalFrames / (entry.encodeWallMs / 1000)).toFixed(2));
      entry.wallSpeed = Number((totalFrames / metadata.fps / (entry.encodeWallMs / 1000)).toFixed(3));
      entry.ok = true;
    } catch (error) {
      entry.error = cleanError(error);
    } finally {
      watcher?.close();
      await saveReport();
      console.error(`${entry.ok ? 'PASS' : 'FAIL'} ${name}${entry.wallFps ? ` ${entry.wallFps} fps` : ''}`);
    }
  }

  for (const resolution of [480, 720, 1080, 1440, 2160]) {
    for (const codec of ['hevc', 'h264']) await verifyCase({ name: `sdr-${resolution}-${codec}`, resolution, codec });
  }
  const middle = Math.max(1, Math.floor(duration / (2 * HLS_SEGMENT_DURATION)));
  for (const resolution of [1080, 2160]) {
    for (const codec of ['hevc', 'h264']) await verifyCase({ name: `seek-${resolution}-${codec}`, resolution, codec, startSegment: middle });
  }
  if (opts.fallback) {
    for (const codec of ['hevc', 'h264']) await verifyCase({ name: `swdecode-720-${codec}`, resolution: 720, codec, accelDecode: false });
  }
  if (opts.rotation) {
    const rotated = path.join(scratch, 'synthetic-rotated.mp4');
    await ffmpeg(['-nostdin', '-display_rotation', '90', '-i', fixture, '-map', '0', '-c', 'copy', rotated]);
    const metadata = videoMetadata(await ffprobe(rotated, true));
    assert.equal(Math.abs(metadata.video.rotation), 90, 'Rotated synthetic fixture must contain a display matrix');
    for (const codec of ['hevc', 'h264']) await verifyCase({ name: `rotation-1080-${codec}`, input: rotated, metadata, resolution: 1080, codec });
  }
  if (opts.audio) {
    for (const [name, audioArgs, suffix] of [
      ['aac-mono-44100', ['-c:a', 'aac', '-ac', '1', '-ar', '44100', '-b:a', '96k'], 'mp4'],
      ['pcm-stereo', ['-c:a', 'pcm_s16le', '-ac', '2', '-ar', '48000'], 'mov'],
      ['flac-stereo', ['-c:a', 'flac', '-ac', '2', '-ar', '48000', '-strict', '-2'], 'mp4'],
    ]) {
      const input = path.join(scratch, `synthetic-${name}.${suffix}`);
      await ffmpeg(['-nostdin', '-i', fixture, '-map', '0:v:0', '-map', '0:a:0', '-t', '6',
        '-c:v', 'copy', ...audioArgs, input]);
      const metadata = videoMetadata(await ffprobe(input, true));
      for (const codec of ['hevc', 'h264']) {
        await verifyCase({ name: `audio-${name}-${codec}`, input, metadata, resolution: 720, codec });
        if (name.startsWith('aac')) await verifyCase({ name: `audio-seek-${name}-${codec}`,
          input, metadata, resolution: 720, codec, startSegment: 1 });
      }
    }
  }
  if (opts.sdr10) {
    const sdr = path.join(scratch, 'synthetic-sdr10-720.mp4');
    await ffmpeg(['-nostdin', '-filter_threads', '1', '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30',
      '-t', '6', '-vf', 'format=yuv420p10le', '-c:v', 'libx265', '-preset', 'ultrafast',
      '-x265-params', 'pools=2:frame-threads=2:log-level=error', '-g', '60', '-bf', '0',
      '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709', '-an', sdr]);
    const metadata = videoMetadata(await ffprobe(sdr, true));
    for (const codec of ['hevc', 'h264']) await verifyCase({ name: `sdr10-fullsize-${codec}`,
      input: sdr, metadata, resolution: 720, codec });
  }
  if (opts.small) {
    const small = path.join(scratch, 'synthetic-small.mp4');
    await ffmpeg(['-nostdin', '-filter_threads', '1', '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=30',
      '-t', '6', '-vf', 'format=nv12', '-c:v', 'h264_rkmpp', '-g', '60', '-bf', '0', '-an', small]);
    const metadata = videoMetadata(await ffprobe(small, true));
    for (const codec of ['hevc', 'h264']) await verifyCase({ name: `small-fullsize-${codec}`,
      input: small, metadata, resolution: 480, codec, belowLimit: true });
  }
  if (opts.hdr) {
    const hdr = path.join(scratch, 'synthetic-hdr-pq-720.mp4');
    await ffmpeg(['-nostdin', '-filter_threads', '1', '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30',
      '-t', '6', '-vf', 'format=yuv420p10le', '-c:v', 'libx265', '-preset', 'ultrafast',
      '-x265-params', 'pools=2:frame-threads=2:log-level=error', '-g', '60', '-bf', '0',
      '-color_primaries', 'bt2020', '-color_trc', 'smpte2084', '-colorspace', 'bt2020nc', '-an', hdr]);
    const metadata = videoMetadata(await ffprobe(hdr, true));
    for (const mali of interfaces.mali ? [true, false] : [false]) {
      for (const codec of ['hevc', 'h264']) await verifyCase({ name: `hdr-${mali ? 'mali' : 'cpu'}-${codec}`,
        input: hdr, metadata, resolution: 1080, codec, mali, belowLimit: true });
    }
  }
  report.complete = true;
} catch (error) {
  report.errors.push(cleanError(error));
}
report.passed = report.cases.filter((item) => item.ok).length;
report.failed = report.cases.filter((item) => !item.ok).length;
report.ok = report.complete && report.errors.length === 0 && report.failed === 0 && report.cases.length > 0;
await saveReport();
console.log(JSON.stringify(report, null, 2));
console.error(`Report: ${reportPath}`);
if (!report.ok) process.exitCode = 1;
