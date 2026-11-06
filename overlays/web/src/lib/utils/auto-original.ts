// Conservative direct-original policy for the optional RKMPP browser player.
// A "maybe" codec answer is only a candidate: the existing direct monitor
// performs a one-way transition to HLS on decoder failure or buffer starvation.
export type OriginalPlaybackInfo = {
  container: string;
  videoCodec: string | null;
  videoProfile: number | null;
  videoLevel: number | null;
  pixelFormat: string;
  colorTransfer: number;
  dvProfile: number | null;
  audioCodec: string | null;
  audioProfile: number | null;
  bitrate: number;
  width: number;
  height: number;
  frameRate: number | null;
};

type CanPlay = (mime: string) => string;

const MIN_PROBE_BYTES = 512 * 1024;
const MIN_SAMPLE_MS = 25;
const PROBE_TIMEOUT_MS = 2200;
const BANDWIDTH_HEADROOM = 1.8;

export const originalContentType = (info: OriginalPlaybackInfo): string | null => {
  // Only known ISO-BMFF files are selected automatically. Manual Original
  // remains available for MOV, Matroska, HDR, Dolby Vision and other formats.
  if (!['mp4', 'm4v'].includes(info.container) || info.dvProfile !== null ||
      [16, 18].includes(info.colorTransfer) || !Number.isFinite(info.bitrate) ||
      info.bitrate <= 0 || info.width <= 0 || info.height <= 0) {
    return null;
  }
  if (info.audioCodec !== null && (info.audioCodec !== 'aac' || info.audioProfile !== 2)) {
    return null;
  }

  let codec: string;
  if (info.videoCodec === 'h264') {
    if (!info.videoProfile || ![66, 77, 100].includes(info.videoProfile) ||
        !info.videoLevel || info.videoLevel < 10 || info.videoLevel > 62 ||
        !['yuv420p', 'yuvj420p'].includes(info.pixelFormat)) {
      return null;
    }
    codec = 'avc1.' + info.videoProfile.toString(16).padStart(2, '0') + '00' +
      info.videoLevel.toString(16).padStart(2, '0');
  } else if (info.videoCodec === 'hevc') {
    if (!info.videoLevel || ![1, 2].includes(info.videoProfile ?? -1) ||
        (info.videoProfile === 1 && info.pixelFormat !== 'yuv420p') ||
        (info.videoProfile === 2 && info.pixelFormat !== 'yuv420p10le') ||
        ![30, 60, 63, 90, 93, 120, 123, 150, 153, 156, 180, 183, 186].includes(info.videoLevel)) {
      return null;
    }
    codec = info.videoProfile === 1
      ? `hvc1.1.6.L${info.videoLevel}.B0`
      : `hvc1.2.4.L${info.videoLevel}.B0`;
  } else {
    return null;
  }

  return `video/mp4; codecs="${codec}${info.audioCodec === 'aac' ? ', mp4a.40.2' : ''}"`;
};

export const originalIsAffordable = (info: OriginalPlaybackInfo, bitsPerSecond: number, canPlay: CanPlay) => {
  const mime = originalContentType(info);
  return mime !== null && canPlay(mime) !== '' && Number.isFinite(bitsPerSecond) &&
    bitsPerSecond > 0 && bitsPerSecond >= info.bitrate * BANDWIDTH_HEADROOM;
};

export const originalEndpointUrl = (masterUrl: string, endpoint: 'original-info' | 'network-probe',
  authParams: Record<string, string | undefined> = {}) => {
  const url = new URL(masterUrl);
  if (!url.pathname.endsWith('/main.m3u8')) throw new Error('Unexpected Immich HLS master URL');
  url.pathname = url.pathname.slice(0, -'main.m3u8'.length) + endpoint;
  for (const [key, value] of Object.entries(authParams)) {
    if (value) url.searchParams.set(key, value);
  }
  return url.href;
};

export const preferDirectOriginal = async ({
  masterUrl,
  authParams,
  canPlay,
  signal,
  fetcher = fetch,
  now = () => performance.now(),
}: {
  masterUrl: string;
  authParams?: Record<string, string | undefined>;
  canPlay: CanPlay;
  signal?: AbortSignal;
  fetcher?: typeof fetch;
  now?: () => number;
}): Promise<boolean> => {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  if (signal?.aborted) return false;
  signal?.addEventListener('abort', cancel, { once: true });
  const timeout = setTimeout(cancel, PROBE_TIMEOUT_MS);

  try {
    const metadataUrl = originalEndpointUrl(masterUrl, 'original-info', authParams);
    const response = await fetcher(metadataUrl, { signal: controller.signal, cache: 'no-store' });
    if (!response.ok) return false;
    const info = await response.json() as OriginalPlaybackInfo;
    const mime = originalContentType(info);
    if (!mime || canPlay(mime) === '') return false;

    const probeUrl = originalEndpointUrl(masterUrl, 'network-probe', authParams);
    const started = now();
    const sample = await fetcher(probeUrl, { signal: controller.signal, cache: 'no-store' });
    if (!sample.ok || sample.headers.get('Content-Encoding')) return false;
    const body = await sample.arrayBuffer();
    const elapsedMs = Math.max(MIN_SAMPLE_MS, now() - started);
    if (body.byteLength < MIN_PROBE_BYTES || controller.signal.aborted) return false;
    return originalIsAffordable(info, body.byteLength * 8000 / elapsedMs, canPlay);
  } catch {
    // Network, permissions, incomplete metadata, stale source and timeout all
    // fail closed to Immich's existing HLS path rather than speculative Original.
    return false;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', cancel);
  }
};
