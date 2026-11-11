const codecFailures = new Set([
  'manifestIncompatibleCodecsError',
  'bufferAddCodecError',
  'bufferAppendError',
  'bufferAppendingError',
  'fragParsingError',
]);

export const isHevcCodec = (codec?: string) => /^(?:hvc1|hev1)(?:\.|$)/.test(codec ?? '');

export const isHevcDecodeFailure = (
  error: { fatal: boolean; type: string; details: string },
  codec?: string,
) => error.fatal && error.type !== 'networkError' && codecFailures.has(error.details) && (!codec || isHevcCodec(codec));

export const isMediaDecodeFailure = (code?: number) => code === 3 || code === 4;

export type PlaybackPosition = { currentTime: number; paused: boolean };

export const playbackPosition = (video: PlaybackPosition): PlaybackPosition => ({
  currentTime: Number.isFinite(video.currentTime) ? Math.max(0, video.currentTime) : 0,
  paused: video.paused,
});
