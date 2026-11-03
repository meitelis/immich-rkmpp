import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import test from 'node:test';

// Run the actual lifecycle service with deferred repositories and fake processes.
// Point IMMICH_TRANSCODING_SOURCE at upstream to reproduce the regressions.
const sourcePath = process.env.IMMICH_TRANSCODING_SOURCE
  ? resolve(process.env.IMMICH_TRANSCODING_SOURCE)
  : fileURLToPath(new URL('../overlays/server/src/services/transcoding.service.ts', import.meta.url));
const source = readFileSync(sourcePath, 'utf8')
  .replace(/^import[\s\S]*?from\s+['"][^'"]+['"];\s*/gm, '')
  .replace(/^\s*@(?:Injectable|OnEvent|OnJob)\([^\n]*\)\s*$/gm, '');
const context = vm.createContext({
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
  TranscodeTarget: { All: 'ALL' },
  BaseConfig: { create: () => ({ getHlsCommand: () => [] }) },
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
const flush = async () => { for (let i = 0; i < 4; i++) await Promise.resolve(); };
const deferred = () => Promise.withResolvers();

async function setup({ deferConfig = false, onSpawn } = {}) {
  const sut = new context.Service();
  const metadataRequests = [];
  const configRequests = [];
  const processes = [];
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
  sut.websocketRepository = { serverSend() {} };
  sut.storageRepository = {
    mkdirSync() {},
    watchDir: () => Object.assign(new EventEmitter(), { close() {} }),
    unlinkDir: async (directory) => { removedDirectories.push(directory); },
  };
  sut.processRepository = {
    spawn: () => {
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
  await sut.onSessionRequest({ sessionId: 'session', assetId: 'asset', ownerId: 'owner' });
  const start = (variantIndex = 0, segmentIndex = 0) => sut.onSegmentRequest({
    sessionId: 'session', assetId: 'asset', variantIndex, segmentIndex,
  });
  return { sut, start, metadataRequests, configRequests, processes, removedDirectories };
}

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
