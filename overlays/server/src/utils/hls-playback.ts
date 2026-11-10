import type { AudioStreamInfo, VideoStreamInfo } from 'src/types.js';

// Adapted from memories-rkmpp's SourceSegments/RKMPPKeyframeGrid. One immutable
// presentation grid is shared by copied and encoded video. Audio has its own clock.
export type PlaybackSegment = { start: number; duration: number; keyframeAt?: number };
export type PlaybackPlan = {
  segments: PlaybackSegment[] | null;
  audio: boolean;
  duration: number;
  original?: { codec: string; bitrate: number };
  bitrates: Record<number, number>;
};
export const PLAYBACK_EPSILON = 0.000001;
export const AUDIO_SEGMENT_DURATION = (94 * 1024) / 48_000;
export const playbackPacing = ['-readrate', '1', '-readrate_initial_burst', '18', '-readrate_catchup', '3.5'];

export function originalVideoCodec(video: VideoStreamInfo): string | undefined {
  if (video.rotation !== 0 || video.dvProfile !== null || [16, 18].includes(video.colorTransfer) || !video.level)
    return;
  if (
    video.codecName === 'h264' &&
    [66, 77, 100].includes(video.profile ?? -1) &&
    ['yuv420p', 'yuvj420p'].includes(video.pixelFormat) &&
    video.level >= 10 &&
    video.level <= 62
  ) {
    return `avc1.${video.profile!.toString(16).padStart(2, '0')}00${video.level.toString(16).padStart(2, '0')}`;
  }
  if (
    video.codecName === 'hevc' &&
    [30, 60, 63, 90, 93, 120, 123, 150, 153, 156, 180, 183, 186].includes(video.level)
  ) {
    if (video.profile === 1 && video.pixelFormat === 'yuv420p') return `hvc1.1.6.L${video.level}.B0`;
    if (video.profile === 2 && video.pixelFormat === 'yuv420p10le') return `hvc1.2.4.L${video.level}.B0`;
  }
}

export const copyCapability = (codec: string) =>
  codec.startsWith('avc1') ? 'avc' : codec.startsWith('hvc1.2') ? 'hevc10' : 'hevc';

export class PlaybackTimeline {
  private frames: { pts: number; start: number }[] = [];
  private end = 0;
  private invalid = false;

  // Packet order, rather than sorted PTS, exposes leading pictures in open GOPs.
  packet(pts: number, duration: number, flags: string) {
    if (!Number.isFinite(pts) || !Number.isFinite(duration) || duration <= 0 || flags.includes('D')) return;
    this.end = Math.max(this.end, pts + duration);
    if (flags.includes('K')) {
      if (this.frames.length >= 4096 || (this.frames.length && pts <= this.frames.at(-1)!.pts)) this.invalid = true;
      if (!this.invalid) this.frames.push({ pts, start: pts });
    } else if (this.frames.length) {
      this.frames.at(-1)!.start = Math.min(this.frames.at(-1)!.start, pts);
    }
  }

  finish(): PlaybackSegment[] | null {
    if (this.invalid || this.frames.length < 2 || this.end <= 0 || Math.abs(this.frames[0].start) > 0.0001) return null;
    const segments = this.frames.map((frame, i) => {
      const start = i === 0 ? 0 : frame.start;
      const end = this.frames[i + 1]?.start ?? this.end;
      return { start, duration: end - start, ...(frame.pts !== start ? { keyframeAt: frame.pts } : {}) };
    });
    let bytes = 0;
    for (let i = 0; i < segments.length; i++) {
      const s = segments[i];
      bytes += s.start.toFixed(9).length + 1;
      if (
        s.start < 0 ||
        s.duration <= 0 ||
        s.duration > 6.0001 ||
        (i > 0 && this.frames[i].pts <= this.frames[i - 1].pts) ||
        bytes > 60 * 1024
      )
        return null;
    }
    return segments.length - 2 > this.end * 4 ? null : segments;
  }
}

export function segmentAt(segments: PlaybackSegment[], position: number) {
  return Math.max(
    0,
    segments.findLastIndex((segment) => segment.start <= position + PLAYBACK_EPSILON),
  );
}

export function videoSeek(segments: PlaybackSegment[], index: number, copy: boolean) {
  const segment = segments[index];
  if (index === 0) return 0;
  if (copy) return (segment.keyframeAt ?? segment.start) + 10 * PLAYBACK_EPSILON;
  const previous = segments[index - 1];
  return (
    (segment.keyframeAt === undefined ? segment.start : (previous.keyframeAt ?? previous.start)) + 10 * PLAYBACK_EPSILON
  );
}

export function audioSegments(duration: number): PlaybackSegment[] {
  const end = (Math.ceil((duration * 48_000) / 1024) * 1024) / 48_000;
  return Array.from({ length: Math.ceil(end / AUDIO_SEGMENT_DURATION) }, (_, i) => ({
    start: i * AUDIO_SEGMENT_DURATION,
    duration: Math.min(AUDIO_SEGMENT_DURATION, end - i * AUDIO_SEGMENT_DURATION),
  }));
}

export function playbackPlaylist(segments: PlaybackSegment[], independent: boolean) {
  return [
    '#EXTM3U',
    '#EXT-X-VERSION:7',
    ...(independent ? ['#EXT-X-INDEPENDENT-SEGMENTS'] : []),
    `#EXT-X-TARGETDURATION:${Math.ceil(Math.max(...segments.map((s) => s.duration)))}`,
    '#EXT-X-MEDIA-SEQUENCE:0',
    '#EXT-X-PLAYLIST-TYPE:VOD',
    '#EXT-X-MAP:URI="init.mp4"',
    ...segments.flatMap((s, i) => [`#EXTINF:${s.duration.toFixed(9)},`, `seg_${i}.m4s`]),
    '#EXT-X-ENDLIST',
    '',
  ].join('\n');
}

export function copyVideoArgs(
  input: string,
  video: VideoStreamInfo,
  segments: PlaybackSegment[],
  index: number,
  directory: string,
  join: (...paths: string[]) => string,
) {
  const seek = videoSeek(segments, index, true);
  return [
    '-hide_banner',
    '-loglevel',
    'warning',
    '-nostdin',
    ...(seek ? ['-ss', seek.toFixed(9), '-noaccurate_seek'] : []),
    ...playbackPacing,
    '-i',
    input,
    '-copyts',
    '-map',
    `0:${video.index}`,
    '-c:v',
    'copy',
    '-an',
    ...(video.codecName === 'hevc' ? ['-tag:v', 'hvc1'] : []),
    '-avoid_negative_ts',
    'disabled',
    '-f',
    'hls',
    '-hls_time',
    '0.00001',
    '-hls_list_size',
    '0',
    '-hls_segment_type',
    'fmp4',
    '-hls_fmp4_init_filename',
    'init.mp4',
    '-hls_segment_options',
    'movflags=+frag_discont+negative_cts_offsets+skip_sidx:use_editlist=0',
    '-hls_flags',
    'temp_file',
    '-hls_segment_filename',
    join(directory, 'seg_%d.m4s'),
    '-start_number',
    String(index),
    join(directory, 'playlist.m3u8'),
  ];
}

export function sharedAudioArgs(
  input: string,
  audio: AudioStreamInfo,
  duration: number,
  index: number,
  directory: string,
  join: (...paths: string[]) => string,
) {
  const start = index * AUDIO_SEGMENT_DURATION;
  const end = (Math.ceil((duration * 48_000) / 1024) * 1024) / 48_000;
  return [
    '-hide_banner',
    '-loglevel',
    'warning',
    '-nostdin',
    ...(start ? ['-ss', start.toFixed(9)] : []),
    ...playbackPacing,
    '-i',
    input,
    '-copyts',
    '-vn',
    '-map',
    `0:${audio.index}`,
    '-c:a',
    'aac',
    '-b:a',
    '192k',
    '-ac',
    '2',
    '-ar',
    '48000',
    '-af',
    `aresample=async=1:first_pts=${Math.round(start * 48_000)},apad=whole_dur=${(end - start).toFixed(9)},atrim=duration=${(end - start).toFixed(9)},asetpts=N/SR/TB+${start.toFixed(9)}/TB`,
    '-bsf:a',
    `noise=amount=0:drop=lt(pts*tb\\,${start.toFixed(9)})`,
    '-avoid_negative_ts',
    'disabled',
    '-f',
    'hls',
    '-hls_time',
    String(AUDIO_SEGMENT_DURATION),
    '-hls_list_size',
    '0',
    '-hls_segment_type',
    'fmp4',
    '-hls_fmp4_init_filename',
    'init.mp4',
    '-hls_segment_options',
    'movflags=+frag_discont+negative_cts_offsets:use_editlist=0',
    '-hls_flags',
    'temp_file',
    '-hls_segment_filename',
    join(directory, 'seg_%d.m4s'),
    '-start_number',
    String(index),
    join(directory, 'playlist.m3u8'),
  ];
}
