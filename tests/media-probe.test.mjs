import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import vm from 'node:vm';
import test from 'node:test';

// Execute the real probe method, without loading unrelated image/EXIF libraries.
const source = readFileSync(new URL('../overlays/server/src/repositories/media.repository.ts', import.meta.url), 'utf8');
const method = source.slice(source.indexOf('  async probe('), source.indexOf('  /**', source.indexOf('  async probe(')));
const probeData = {
  format: {},
  streams: [
    { index: 2, codec_type: 'audio', codec_name: 'aac', profile: 'LC', bit_rate: '192000', channels: 2, sample_rate: '48000' },
    { index: 3, codec_type: 'audio', codec_name: 'aac', profile: 'HE-AAC', channels: 6, sample_rate: '96000' },
    { index: 4, codec_type: 'audio', codec_name: 'flac' },
    { index: 5, codec_type: 'audio', codec_name: 'unknown' },
  ],
};
const context = vm.createContext({ probe: async () => probeData, AacProfile: { Lc: 2, HeAac: 5 } });
vm.runInContext(stripTypeScriptTypes(`class Probe { ${method}
  parseInt(value) { return Number.parseInt(value) || 0; }
  parseFloat(value) { return Number.parseFloat(value) || 0; }
  compareStreams() { return 0; }
  parseEnum(_, value) { return value === 'LC' ? 2 : value === 'HE-AAC' ? 5 : null; }
}; globalThis.repository = new Probe();`, { mode: 'transform' }), context);

test('real ffprobe mapping retains audio safety metadata and treats missing values conservatively', async () => {
  const result = JSON.parse(JSON.stringify(await context.repository.probe('/synthetic.mp4')));
  assert.deepEqual(result.audioStreams, [
    { index: 2, codecName: 'aac', profile: 2, bitrate: 192_000, channels: 2, sampleRate: 48_000 },
    { index: 3, codecName: 'aac', profile: 5, bitrate: 0, channels: 6, sampleRate: 96_000 },
    { index: 4, codecName: 'flac', profile: null, bitrate: 0, channels: 0, sampleRate: 0 },
  ]);
});
