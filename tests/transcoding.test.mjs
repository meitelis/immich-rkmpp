import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import test from 'node:test';
import * as playback from '../overlays/server/src/utils/hls-playback.ts';

// Run the actual lifecycle service with deferred repositories and fake processes.
// Point IMMICH_TRANSCODING_SOURCE at upstream to reproduce the regressions.
const sourcePath = process.env.IMMICH_TRANSCODING_SOURCE
  ? resolve(process.env.IMMICH_TRANSCODING_SOURCE)
  : fileURLToPath(new URL('../overlays/server/src/services/transcoding.service.ts', import.meta.url));
const source = readFileSync(sourcePath, 'utf8')
  .replace(/^import[\s\S]*?from\s+['"][^'"]+['"];\s*/gm, '')
  .replace(/^\s*@(?:Injectable|OnEvent|OnJob)\([^\n]*\)\s*$/gm, '');
const context = vm.createContext({
  ...playback,
  join,
  BaseService: class {},
  StorageCore: { getHlsVariantFolder: () => '/fixture/hls/variant', getHlsSessionFolder: () => '/fixture/hls' },
  HLS_VARIANTS: [
    { codec: 'hevc', resolution: 480, bitrate: 1_000_000 },
    { codec: 'hevc', resolution: 2160, bitrate: 10_000_000 },
  ],
  HLS_SEGMENT_DURATION: 2,
  HLS_CRF: { hevc: 26 },
  HLS_SEGMENT_FILENAME_REGEX: /^seg_(\d+)\.m4s$/,
  HLS_BACKPRESSURE_PAUSE_SEGMENTS: 10,
  HLS_BACKPRESSURE_RESUME_SEGMENTS: 5,
  HLS_LEASE_DURATION_MS: 60_000,
  HLS_CLEANUP_INTERVAL_MS: 5_000,
  HLS_INACTIVITY_TIMEOUT_MS: 30_000,
  AacProfile: { Lc: 2 },
  TranscodeTarget: { All: 'ALL' },
  BaseConfig: { create: () => ({ getHlsCommand: (_, __, audio) => [JSON.stringify(audio ?? null)] }) },
  setInterval: () => ({}),
  clearInterval() {},
});
vm.runInContext(
  `${stripTypeScriptTypes(source, { mode: 'transform' }).replace(/\bexport\s+/g, '')}\n;globalThis.Service = TranscodingService;`,
  context,
);

const metadata = {
  packets: { packetCount: 120, totalDuration: 4 },
  videoStream: { timeBase: 1 },
  originalPath: '/fixture/video.mp4',
};
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
const deferred = () => Promise.withResolvers();

async function setup({ deferConfig = false, onSpawn, playback } = {}) {
  const sut = new context.Service();
  const metadataRequests = [];
  const configRequests = [];
  const processes = [];
  const commands = [];
  const audioRequests = [];
  const removedDirectories = [];
  sut.getConfig = () => {
    if (!deferConfig) return Promise.resolve({ ffmpeg: {} });
    const request = deferred();
    configRequests.push(request);
    return request.promise;
  };
  sut.videoStreamRepository = {
    createSession: async () => {},
    deleteSession: async () => {},
    getForTranscoding: () => {
      const request = deferred();
      metadataRequests.push(request);
      return request.promise;
    },
  };
  sut.logger = { debug() {}, log() {}, warn() {}, error() {} };
  sut.mediaRepository = {
    probe: () => {
      const request = deferred();
      audioRequests.push(request);
      return request.promise;
    },
  };
  sut.websocketRepository = { serverSend() {} };
  sut.storageRepository = {
    mkdirSync() {},
    watchDir: () => Object.assign(new EventEmitter(), { close() {} }),
    unlinkDir: async (directory) => { removedDirectories.push(directory); },
  };
  sut.processRepository = {
    spawn: (_, args) => {
      commands.push(args);
      const process = Object.assign(new EventEmitter(), {
        stderr: new EventEmitter(),
        signals: [],
        kill(signal) {
          this.signals.push(signal);
          queueMicrotask(() => this.emit('exit', null, signal));
          return true;
        },
      });
      processes.push(process);
      onSpawn?.(sut, process);
      return process;
    },
  };
  await sut.onSessionRequest({ sessionId: 'session', assetId: 'asset', ownerId: 'owner', playback });
  const start = (variantIndex = 0, segmentIndex = 0) => sut.onSegmentRequest({
    sessionId: 'session', assetId: 'asset', variantIndex, segmentIndex,
  });
  return { sut, start, metadataRequests, configRequests, processes, commands, audioRequests, removedDirectories };
}

const storedAudio = { index: 1, codecName: 'aac', profile: 2, bitrate: 128_000 };
const probedAudio = { ...storedAudio, channels: 2, sampleRate: 48_000 };

test('AAC compatibility analysis is shared by overlapping quality starts and selects the stored stream', async () => {
  const h = await setup();
  const first = h.start(0);
  await flush();
  h.metadataRequests[0].resolve({ ...metadata, audioStream: storedAudio });
  await flush();
  assert.equal(h.audioRequests.length, 1);
  const second = h.start(1);
  await flush();
  h.metadataRequests[1].resolve({ ...metadata, audioStream: storedAudio });
  await flush();
  assert.equal(h.audioRequests.length, 1, 'Quality changes must share the pending audio probe');
  h.audioRequests[0].resolve({ audioStreams: [{ ...probedAudio, index: 0, channels: 6 }, probedAudio] });
  await Promise.all([first, second]);
  assert.equal(h.processes.length, 1, 'A superseded start must not spawn after its probe resolves');
  assert.deepEqual(JSON.parse(h.commands[0][0]), probedAudio);
  const third = h.start(0, 2);
  await flush();
  h.metadataRequests[2].resolve({ ...metadata, audioStream: storedAudio });
  await third;
  assert.equal(h.audioRequests.length, 1, 'Later quality changes reuse verified audio metadata');
});

const playbackPlan = { segments: [{ start: 0, duration: 2 }, { start: 2, duration: 2 }],
  audio: true, duration: 4, original: { codec: 'avc1.640028', bitrate: 4_000_000 }, bitrates: { 0: 1_000_000, 1: 2_000_000 } };
const playbackMetadata = { ...metadata, videoStream: { timeBase: 1, index: 0, width: 1920, height: 1080, codecName: 'h264' }, audioStream: storedAudio };

test('Memories video quality switches retain the same independent audio worker', async () => {
  const h = await setup({ playback: playbackPlan });
  const first = h.start(0); const audio = h.start(3);
  await flush();
  for (const request of h.metadataRequests) request.resolve(playbackMetadata);
  await Promise.all([first, audio]);
  assert.equal(h.processes.length, 2);
  const audioProcess = h.processes[1];
  const switchVideo = h.start(1, 1);
  await flush(); h.metadataRequests[2].resolve(playbackMetadata); await switchVideo;
  assert.deepEqual(audioProcess.signals, [], 'video selection must not kill or restart shared audio');
  assert.equal(h.processes.length, 3);
  const session = h.sut.sessions.get('session');
  session.renditions.get(1).lastCompletedSegment = 100;
  await h.sut.onHeartbeat({ sessionId: 'session', variantIndex: 1, segmentIndex: 1 });
  assert.deepEqual(h.processes[2].signals, [], 'paced RKMPP must not receive SIGSTOP even with a full buffer');
  await h.sut.onSessionEnd({ sessionId: 'session' });
  assert.deepEqual(audioProcess.signals, ['SIGKILL']);
  assert.deepEqual(h.processes[2].signals, ['SIGKILL']);
});

test('overlapping cold Memories qualities own independent producers and duplicate requests share their start', async () => {
  const h = await setup({ playback: playbackPlan });
  const low = h.start(0), high = h.start(1, 1), duplicate = h.start(1, 1);
  await flush();
  assert.equal(h.metadataRequests.length, 2);
  h.metadataRequests[1].resolve(playbackMetadata);
  await high;
  h.metadataRequests[0].resolve(playbackMetadata);
  await Promise.all([low, duplicate]);
  assert.equal(h.processes.length, 2, 'a later quality must not supersede a pending producer for another level');
  assert.ok(h.processes.every((process) => process.signals.length === 0));
  await h.sut.onSessionEnd({ sessionId: 'session' });
  assert.ok(h.processes.every((process) => process.signals.join() === 'SIGKILL'));
});

test('inactive Memories producers release hardware without stopping the active quality or shared audio', async () => {
  const h = await setup({ playback: playbackPlan });
  const starts = [h.start(0), h.start(1), h.start(3)];
  await flush();
  for (const request of h.metadataRequests) request.resolve(playbackMetadata);
  await Promise.all(starts);
  const session = h.sut.sessions.get('session');
  session.renditions.get(0).lastActivityTime = new Date(Date.now() - 31_000);
  await h.sut.removeInactiveSessions();
  assert.deepEqual(h.processes[0].signals, ['SIGKILL']);
  assert.deepEqual(h.processes[1].signals, []);
  assert.deepEqual(h.processes[2].signals, []);
  assert.equal(session.renditions.has(0), false);
  await h.sut.onSessionEnd({ sessionId: 'session' });
});

test('a swept cold Memories start cannot create an orphan or attach to its replacement', async () => {
  const h = await setup({ playback: playbackPlan });
  const old = h.start(0);
  await flush();
  h.sut.sessions.get('session').renditions.get(0).lastActivityTime = new Date(Date.now() - 31_000);
  await h.sut.removeInactiveSessions();
  const replacement = h.start(0);
  await flush();
  h.metadataRequests[0].resolve(playbackMetadata);
  await old;
  assert.equal(h.processes.length, 0);
  h.metadataRequests[1].resolve(playbackMetadata);
  await replacement;
  assert.equal(h.processes.length, 1);
  await h.sut.onSessionEnd({ sessionId: 'session' });
});

test('Original requests remux video without opening a hardware encoder or a duplicate audio encoder', async () => {
  const h = await setup({ playback: playbackPlan });
  const start = h.start(2);
  await flush(); h.metadataRequests[0].resolve(playbackMetadata); await start;
  assert.equal(h.processes.length, 1);
  assert.equal(h.commands[0][h.commands[0].indexOf('-c:v') + 1], 'copy');
  assert.ok(h.commands[0].includes('-an'));
  assert.equal(h.audioRequests.length, 0);
});

test('closing while shared audio starts cancels both workers and their pending metadata', async () => {
  const h = await setup({ playback: playbackPlan });
  const first = h.start(0); const audio = h.start(3);
  await flush(); await h.sut.onSessionEnd({ sessionId: 'session' });
  for (const request of h.metadataRequests) request.resolve(playbackMetadata);
  await Promise.all([first, audio]);
  assert.equal(h.processes.length, 0);
});

test('closing a viewer during AAC verification prevents an orphan encoder', async () => {
  const h = await setup();
  const pending = h.start();
  await flush();
  h.metadataRequests[0].resolve({ ...metadata, audioStream: storedAudio });
  await flush();
  await h.sut.onSessionEnd({ sessionId: 'session' });
  h.audioRequests[0].resolve({ audioStreams: [probedAudio] });
  await pending;
  assert.equal(h.processes.length, 0);
});

test('failed or missing AAC verification preserves conservative encoding metadata', async () => {
  for (const fail of [false, true]) {
    const h = await setup();
    const pending = h.start();
    await flush();
    h.metadataRequests[0].resolve({ ...metadata, audioStream: storedAudio });
    await flush();
    if (fail) h.audioRequests[0].reject(new Error('Synthetic probe failure'));
    else h.audioRequests[0].resolve({ audioStreams: [] });
    await pending;
    assert.deepEqual(JSON.parse(h.commands[0][0]), storedAudio);
  }
});

test('lossless, high-rate and non-LC sources skip copy-only compatibility probing', async () => {
  for (const override of [{ codecName: 'flac' }, { bitrate: 384_000 }, { profile: 5 }, { bitrate: 0 }]) {
    const h = await setup();
    const pending = h.start();
    await flush();
    const audio = { ...storedAudio, ...override };
    h.metadataRequests[0].resolve({ ...metadata, audioStream: audio });
    await pending;
    assert.equal(h.audioRequests.length, 0);
    assert.deepEqual(JSON.parse(h.commands[0][0]), audio);
  }
});

test('concurrent requests for the same cold rendition share one encoder start', async () => {
  const h = await setup();
  const first = h.start();
  await flush();
  const second = h.start();
  await second;
  assert.equal(h.metadataRequests.length, 1);
  h.metadataRequests[0].resolve(metadata);
  await first;
  assert.equal(h.processes.length, 1);
});

test('a superseded start cannot unlock another pending rendition start', async () => {
  const h = await setup();
  const first = h.start(0);
  await flush();
  const switched = h.start(1);
  await flush();
  h.metadataRequests[0].resolve(metadata);
  await first;
  const duplicate = h.start(1);
  await flush();
  // Resolve every request so the negative control also finishes without hangs.
  for (const request of h.metadataRequests.slice(1)) request.resolve(metadata);
  await Promise.all([switched, duplicate]);
  assert.equal(h.metadataRequests.length, 2, 'the duplicate must join the pending switch');
  assert.equal(h.processes.length, 1, 'only the selected rendition may own an encoder');
  assert.equal(h.processes[0].signals.length, 0);
});

test('closing a session during metadata lookup prevents an orphan encoder', async () => {
  const h = await setup();
  const starting = h.start();
  await flush();
  await h.sut.onSessionEnd({ sessionId: 'session' });
  h.metadataRequests[0].resolve(metadata);
  await starting;
  assert.equal(h.processes.length, 0);
  assert.equal(h.removedDirectories.length, 1);
});

test('closing during configuration lookup skips subsequent source analysis', async () => {
  const h = await setup({ deferConfig: true });
  const starting = h.start();
  await h.sut.onSessionEnd({ sessionId: 'session' });
  h.configRequests[0].resolve({ ffmpeg: {} });
  await flush();
  for (const request of h.metadataRequests) request.resolve(metadata);
  await starting;
  assert.equal(h.metadataRequests.length, 0);
  assert.equal(h.processes.length, 0);
});

test('a replacement session cannot inherit an old session’s pending encoder', async () => {
  const h = await setup();
  const previous = h.start();
  await flush();
  await h.sut.onSessionEnd({ sessionId: 'session' });
  await h.sut.onSessionRequest({ sessionId: 'session', assetId: 'asset', ownerId: 'owner' });
  const replacement = h.start();
  await flush();
  h.metadataRequests[0].resolve(metadata);
  h.metadataRequests[1].resolve(metadata);
  await Promise.all([previous, replacement]);
  assert.equal(h.processes.length, 1);
});

test('a session ending after spawn but before promise continuation kills the unowned process', async () => {
  const h = await setup({ onSpawn: (sut) => {
    queueMicrotask(() => { void sut.onSessionEnd({ sessionId: 'session' }); });
  } });
  const starting = h.start();
  await flush();
  h.metadataRequests[0].resolve(metadata);
  await starting;
  await flush();
  assert.equal(h.processes.length, 1);
  assert.deepEqual(h.processes[0].signals, ['SIGKILL']);
});
