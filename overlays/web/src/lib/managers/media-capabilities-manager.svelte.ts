export type Level = {
  videoCodec?: string;
  width: number;
  height: number;
  bitrate: number;
  frameRate: number;
  url?: string[];
};

export const DEFAULT_DECODING_INFO: MediaCapabilitiesDecodingInfo = {
  powerEfficient: false,
  smooth: false,
  supported: false,
  keySystemAccess: null,
};

export class MediaCapabilitiesManager {
  private static readonly MAX_CACHE_ENTRIES = 128;
  private cache = new Map<string, Promise<MediaCapabilitiesDecodingInfo>>();

  async efficientLevels(levels: Level[]) {
    const decodingInfo = await Promise.all(levels.map((level) => this.decodingInfo(level)));
    // eslint-disable-next-line svelte/prefer-svelte-reactivity
    const candidatesByHeight = new Map<number, number[]>();
    const originals: number[] = [];
    for (let i = 0; i < levels.length; i++) {
      if (decodingInfo[i].supported) {
        if (levels[i].url?.some((url) => new URL(url, 'https://local.invalid').searchParams.get('original') === '1')) {
          originals.push(i);
          continue;
        }
        const candidates = candidatesByHeight.get(levels[i].height) ?? [];
        candidates.push(i);
        candidatesByHeight.set(levels[i].height, candidates);
      }
    }

    const selected: number[] = [];
    for (const candidates of candidatesByHeight.values()) {
      const efficient = candidates.filter((i) => decodingInfo[i].smooth && decodingInfo[i].powerEfficient);
      const avc = candidates.filter((i) => levels[i].videoCodec?.startsWith('avc1'));
      const smooth = candidates.filter((i) => decodingInfo[i].smooth);
      // A missing/failed MediaCapabilities query must not remove MSE-supported AVC.
      const preferred = efficient.length ? efficient : avc.length ? avc : smooth;
      const best = preferred.reduce<number | undefined>(
        (best, i) => (best === undefined || levels[i].bitrate < levels[best].bitrate ? i : best),
        undefined,
      );
      if (best !== undefined) {
        selected.push(best);
      }
    }
    return new Set([...selected, ...originals]);
  }

  decodingInfo(level: Level): Promise<MediaCapabilitiesDecodingInfo> {
    const mediaSource =
      (globalThis as typeof globalThis & { ManagedMediaSource?: typeof MediaSource }).ManagedMediaSource ??
      globalThis.MediaSource;
    const contentType = `video/mp4; codecs="${level.videoCodec}"`;
    try {
      if (!level.videoCodec || !mediaSource?.isTypeSupported(contentType)) {
        return Promise.resolve(DEFAULT_DECODING_INFO);
      }
    } catch {
      return Promise.resolve(DEFAULT_DECODING_INFO);
    }

    // Decoder limits depend on the full frame and frame rate, including portrait video.
    const key = `${level.videoCodec}|${level.width}|${level.height}|${level.bitrate}|${level.frameRate}`;
    let promise = this.cache.get(key);
    if (promise) {
      // Refresh recency without retaining every asset shape for the whole session.
      this.cache.delete(key);
    } else {
      promise = this.queryDecodingInfo(level, contentType);
    }
    this.cache.set(key, promise);
    if (this.cache.size > MediaCapabilitiesManager.MAX_CACHE_ENTRIES) {
      this.cache.delete(this.cache.keys().next().value!);
    }
    return promise;
  }

  private async queryDecodingInfo(level: Level, contentType: string): Promise<MediaCapabilitiesDecodingInfo> {
    try {
      return await navigator.mediaCapabilities.decodingInfo({
        type: 'media-source',
        video: {
          contentType,
          width: level.width,
          height: level.height,
          bitrate: level.bitrate,
          framerate: level.frameRate,
        },
      });
    } catch {
      // MSE support is confirmed above; efficiency and smoothness remain unknown.
      return { ...DEFAULT_DECODING_INFO, supported: true };
    }
  }
}

// Query actual renditions lazily; fixed 60fps guesses can misclassify other sources.
export const mediaCapabilitiesManager = new MediaCapabilitiesManager();
