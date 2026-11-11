import type Hls from 'hls.js';
import type { FragBufferedData } from 'hls.js';

// Port of Memories' bounded probes and native hls.js policy. A producer's wait
// before the first byte is not evidence that the connection is slow.
export const adaptiveHlsConfig = {
  autoStartLoad: false,
  startFragPrefetch: false,
  testBandwidth: false,
  maxBufferLength: 18,
  maxMaxBufferLength: 18,
  maxBufferSize: 96 * 1024 * 1024,
  backBufferLength: 8,
  capLevelOnFPSDrop: true,
  fpsDroppedMonitoringThreshold: 0.2,
  maxStarvationDelay: 6,
  maxLoadingDelay: 6,
};
export const safeEstimate = (bps: number) =>
  Number.isFinite(bps) && bps > 0 ? Math.max(150_000, Math.round(Math.min(bps, 120_000_000) * 0.75)) : 750_000;

export function transferBandwidth(stats: { loaded: number; loading: { first: number; end: number } }) {
  const { first, end } = stats.loading;
  return first > 0 && end > first && stats.loaded >= 16_384
    ? Math.min(120_000_000, (stats.loaded * 8000) / Math.max(20, end - first))
    : 0;
}

export const isOriginalLevel = (level?: { url: string[] }) =>
  level?.url.some((url) => new URL(url, 'https://local.invalid').searchParams.get('original') === '1') ?? false;

export function playbackEndpoint(master: string, endpoint: string, authParams: Record<string, unknown> = {}) {
  const url = new URL(master, globalThis.location?.href);
  if (!url.pathname.endsWith('/main.m3u8')) throw new Error('Unexpected playback URL');
  url.pathname = url.pathname.slice(0, -'main.m3u8'.length) + endpoint;
  url.searchParams.delete('videoCodec');
  for (const [key, value] of Object.entries(authParams))
    if (typeof value === 'string' && value) url.searchParams.set(key, value);
  return url;
}

export async function probeConnection(
  master: string,
  signal: AbortSignal,
  recovery = false,
  fetcher: typeof fetch = fetch,
  now = () => performance.now(),
): Promise<number> {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  if (signal.aborted) return 0;
  signal.addEventListener('abort', cancel, { once: true });
  const timer = setTimeout(cancel, 2200);
  let estimate = 0;
  try {
    for (const size of recovery ? [131072, 393216] : [65536, 393216, 1572864]) {
      const url = playbackEndpoint(master, 'network-probe');
      url.searchParams.set('bytes', String(size));
      const start = now();
      const response = await fetcher(url.href, { signal: controller.signal, cache: 'no-store' });
      if (!response.ok || response.headers.get('Content-Encoding')) break;
      const bytes = await response.arrayBuffer();
      // Aborted, partial and transformed replies never establish capacity.
      if (bytes.byteLength !== size || controller.signal.aborted) break;
      const elapsed = Math.max(25, now() - start);
      estimate = (size * 8000) / elapsed;
      // Memories continues after a cold first request so connection setup and
      // TCP warmup do not set Auto's quality. The overall deadline bounds cost.
    }
  } catch {
    /* retain only the last completed sample */
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', cancel);
  }
  return signal.aborted ? 0 : estimate;
}

type OriginalInfo = {
  rotation: number;
  videoCodec: string;
  videoProfile: number | null;
  videoLevel: number | null;
  pixelFormat: string;
  colorTransfer: number;
  dvProfile: number | null;
};

export function originalCapability(
  info: OriginalInfo,
  supported: (mime: string) => boolean,
): 'avc' | 'hevc' | 'hevc10' | undefined {
  if (info.rotation !== 0 || info.dvProfile !== null || [16, 18].includes(info.colorTransfer) || !info.videoLevel)
    return;
  let codec: string | undefined;
  let capability: 'avc' | 'hevc' | 'hevc10' = 'avc';
  if (
    info.videoCodec === 'h264' &&
    [66, 77, 100].includes(info.videoProfile ?? -1) &&
    ['yuv420p', 'yuvj420p'].includes(info.pixelFormat) &&
    info.videoLevel >= 10 &&
    info.videoLevel <= 62
  ) {
    codec = `avc1.${info.videoProfile!.toString(16).padStart(2, '0')}00${info.videoLevel.toString(16).padStart(2, '0')}`;
  } else if (
    info.videoCodec === 'hevc' &&
    [30, 60, 63, 90, 93, 120, 123, 150, 153, 156, 180, 183, 186].includes(info.videoLevel)
  ) {
    if (info.videoProfile === 1 && info.pixelFormat === 'yuv420p') {
      codec = `hvc1.1.6.L${info.videoLevel}.B0`;
      capability = 'hevc';
    } else if (info.videoProfile === 2 && info.pixelFormat === 'yuv420p10le') {
      codec = `hvc1.2.4.L${info.videoLevel}.B0`;
      capability = 'hevc10';
    }
  }
  try {
    if (codec && supported(`video/mp4; codecs="${codec}"`)) return capability;
  } catch {
    /* unsupported */
  }
}

export async function prepareAdaptivePlayback({
  masterUrl,
  authParams,
  signal,
  allowOriginal = true,
  supported = (mime: string) => {
    const source =
      (globalThis as typeof globalThis & { ManagedMediaSource?: typeof MediaSource }).ManagedMediaSource ??
      globalThis.MediaSource;
    return source?.isTypeSupported(mime) ?? false;
  },
  fetcher = fetch,
}: {
  masterUrl: string;
  authParams?: Record<string, unknown>;
  signal: AbortSignal;
  allowOriginal?: boolean;
  supported?: (mime: string) => boolean;
  fetcher?: typeof fetch;
}) {
  // getAssetHlsUrl uses the SDK's API base, normally the relative path /api.
  const url = new URL(masterUrl, globalThis.location?.href);
  for (const [key, value] of Object.entries(authParams ?? {}))
    if (typeof value === 'string' && value) url.searchParams.set(key, value);
  url.searchParams.set('strategy', 'memories');
  const metadataController = new AbortController();
  const cancel = () => metadataController.abort();
  if (signal.aborted) return { url: url.href, bandwidth: 0 };
  signal.addEventListener('abort', cancel, { once: true });
  const timeout = setTimeout(cancel, 1200);
  const metadata = (async () => {
    if (!allowOriginal) return;
    try {
      const response = await fetcher(playbackEndpoint(url.href, 'original-info').href, {
        signal: metadataController.signal,
        cache: 'no-store',
      });
      if (response.ok && !metadataController.signal.aborted)
        return originalCapability(await response.json(), supported);
    } catch {
      /* no Original; encoded HLS remains available */
    }
  })();
  try {
    const [copy, bandwidth] = await Promise.all([metadata, probeConnection(url.href, signal, false, fetcher)]);
    if (copy && !signal.aborted) url.searchParams.set('copy', copy);
    return { url: url.href, bandwidth };
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener('abort', cancel);
  }
}

export function attachAdaptivePlayback(
  hls: Hls,
  video: HTMLVideoElement,
  master: string,
  initialBandwidth: number,
  onStatus: (text: string) => void = () => {},
) {
  const controller = new AbortController();
  const signal = controller.signal;
  const events = hls.constructor as typeof Hls;
  let lastProbe = Date.now();
  let probing = false;
  let samples: number[] = [];
  let lastPosition = video.currentTime || 0;
  const debug = new URL(globalThis.location?.href ?? master).searchParams.has('playbackDebug');
  let automaticNotification = false;
  // hls-video-element 1.5.11 mirrors an emergency downgrade into its rendition
  // menu. That programmatic change must not turn Auto into a manual quality pin.
  const originalTrigger = hls.trigger;
  const originalNextLevel = Object.getOwnPropertyDescriptor(hls, 'nextLevel');
  const smoothSwitch = Object.getOwnPropertyDescriptor(events.prototype, 'nextLevel')?.set;
  hls.trigger = ((event: string, data: unknown) => {
    const previous = automaticNotification;
    if (event === events.Events.LEVEL_SWITCHED) automaticNotification = hls.autoLevelEnabled;
    try {
      return (originalTrigger as (event: string, data: unknown) => boolean).call(hls, event, data);
    } finally {
      if (automaticNotification) {
        const renditions = (video as HTMLVideoElement & { videoRenditions?: { selectedIndex: number } })
          .videoRenditions;
        if (renditions && renditions.selectedIndex >= 0) renditions.selectedIndex = -1;
      }
      automaticNotification = previous;
    }
  }) as Hls['trigger'];
  const bufferAhead = () => {
    for (let i = 0; i < video.buffered.length; i++) {
      if (video.buffered.start(i) <= video.currentTime + 0.1 && video.buffered.end(i) > video.currentTime)
        return video.buffered.end(i) - video.currentTime;
    }
    return 0;
  };
  const refresh = async (force = false) => {
    if (probing || signal.aborted || !hls.autoLevelEnabled || (!force && Date.now() - lastProbe < 20_000)) return;
    lastProbe = Date.now();
    probing = true;
    try {
      const bps = await probeConnection(master, signal, true);
      if (bps > 0 && !signal.aborted && hls.autoLevelEnabled) {
        const estimate = safeEstimate(bps);
        hls.bandwidthEstimate = estimate;
        const higher = hls.levels[hls.currentLevel + 1];
        if (
          !video.paused &&
          !video.seeking &&
          bufferAhead() >= 3 &&
          hls.currentLevel >= 0 &&
          hls.currentLevel < hls.maxAutoLevel &&
          higher &&
          estimate >= (higher.maxBitrate || higher.bitrate) * 1.35
        ) {
          const original = hls.levels.findIndex(isOriginalLevel);
          if (
            original >= 0 &&
            original <= hls.maxAutoLevel &&
            hls.levels[original].bitrate < estimate * hls.config.abrBandWidthUpFactor
          ) {
            // Native ABR stays within its current codec family. A measured,
            // affordable Original can re-enter Auto for one fragment; native
            // adaptation and decoder caps remain in force afterwards.
            hls.nextAutoLevel = original;
          }
          // Memories expedites recovery through native Auto. Keep the playing
          // fragment while hls.js reselects future data from the new estimate.
          smoothSwitch?.call(hls, -1);
        }
      }
    } finally {
      probing = false;
    }
  };
  // Native nextLevel keeps the playing fragment and schedules replacement of
  // future data. loadLevel alone waits for the entire buffered tail to play.
  Object.defineProperty(hls, 'nextLevel', {
    configurable: true,
    get: () => hls.manualLevel,
    set: (level: number) => {
      if (automaticNotification) return;
      samples = [];
      if (level === -1) {
        hls.loadLevel = -1;
        void refresh(true);
      } else if (smoothSwitch) {
        smoothSwitch.call(hls, level);
      } else {
        hls.loadLevel = level;
      }
    },
  });
  hls.loadLevel = -1;
  const estimate = safeEstimate(initialBandwidth);
  hls.bandwidthEstimate = estimate;
  // Native startup can prefer the AVC codec tier over an affordable Main10
  // Original. Select only the first rendition; manualLevel stays -1 so native
  // Auto can still downshift if subsequent delivery or decoding requires it.
  const original = hls.levels.findIndex(isOriginalLevel);
  hls.startLevel =
    initialBandwidth > 0 && original >= 0 && hls.levels[original].bitrate < estimate * hls.config.abrBandWidthUpFactor
      ? original
      : -1;
  const buffered = (_: unknown, data: FragBufferedData) => {
    if (data.frag.type !== 'main') return;
    const bps = transferBandwidth(data.stats);
    if (bps > 0) samples = [...samples.slice(-3), bps];
    const producerWait = data.stats.loading.first - data.stats.loading.start;
    if (hls.autoLevelEnabled && producerWait >= 900 && samples.length >= 2 && bufferAhead() >= 3) {
      const estimate = safeEstimate(Math.min(...samples.slice(-2)));
      if (hls.bandwidthEstimate < estimate * 0.65) hls.bandwidthEstimate = estimate;
    }
  };
  const update = () => {
    lastPosition = Math.max(lastPosition, video.currentTime || 0);
    if (debug && video.dataset) {
      const native = (video as HTMLVideoElement & { nativeEl?: HTMLVideoElement }).nativeEl ?? video;
      const quality = native.getVideoPlaybackQuality?.();
      Object.assign(video.dataset, {
        playbackBandwidth: String(Math.round(hls.bandwidthEstimate)),
        playbackLevel: String(hls.currentLevel),
        playbackCap: String(hls.autoLevelCapping),
        playbackDropped: String(quality?.droppedVideoFrames ?? ''),
        playbackFrames: String(quality?.totalVideoFrames ?? ''),
      });
    }
    const level = hls.levels[hls.currentLevel];
    if (video.videoWidth && video.videoHeight)
      onStatus(
        `${isOriginalLevel(level) ? 'Original' : hls.autoLevelEnabled ? 'Auto' : 'Playing'} · ${video.videoWidth}×${video.videoHeight}`,
      );
    if (
      !video.paused &&
      !video.ended &&
      !video.seeking &&
      bufferAhead() >= 3 &&
      hls.currentLevel >= 0 &&
      hls.currentLevel < hls.levels.length - 1
    )
      void refresh();
  };
  const network = () => {
    if (!video.paused && !video.ended) void refresh(true);
  };
  const foreground = () => {
    if (!document.hidden) network();
  };
  const seeking = () => {
    const position = video.currentTime;
    const backward = position < lastPosition;
    lastPosition = position;
    if (!backward || !video.buffered.length) return;
    for (let i = 0; i < video.buffered.length; i++) {
      if (video.buffered.start(i) <= position && video.buffered.end(i) > position) return;
    }
    // Appending earlier AAC against retained future data can leave a splice
    // hole, and retained Original GOPs can outlive a manual quality change.
    // An unbuffered rewind/loop needs one fresh audio/video timeline.
    hls.stopLoad();
    hls.trigger(events.Events.BUFFER_FLUSHING, { startOffset: 0, endOffset: Infinity, type: null });
    hls.startLoad(position);
  };
  const connection = (navigator as Navigator & { connection?: EventTarget }).connection;
  hls.on(events.Events.FRAG_BUFFERED, buffered);
  video.addEventListener('resize', update);
  video.addEventListener('timeupdate', update);
  video.addEventListener('seeking', seeking);
  window.addEventListener('online', network);
  document.addEventListener('visibilitychange', foreground);
  connection?.addEventListener('change', network);
  const timer = setInterval(update, 1000);
  return () => {
    if (signal.aborted) return;
    controller.abort();
    clearInterval(timer);
    hls.trigger = originalTrigger;
    if (originalNextLevel) Object.defineProperty(hls, 'nextLevel', originalNextLevel);
    else Reflect.deleteProperty(hls, 'nextLevel');
    hls.off(events.Events.FRAG_BUFFERED, buffered);
    video.removeEventListener('resize', update);
    video.removeEventListener('timeupdate', update);
    video.removeEventListener('seeking', seeking);
    if (debug && video.dataset) {
      for (const key of ['playbackBandwidth', 'playbackLevel', 'playbackCap', 'playbackDropped', 'playbackFrames'])
        delete video.dataset[key];
    }
    window.removeEventListener('online', network);
    document.removeEventListener('visibilitychange', foreground);
    connection?.removeEventListener('change', network);
  };
}
