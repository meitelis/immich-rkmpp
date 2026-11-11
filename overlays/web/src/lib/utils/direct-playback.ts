type DirectMedia = Pick<HTMLVideoElement,
  'paused' | 'ended' | 'seeking' | 'currentTime' | 'duration' | 'readyState' | 'playbackRate' |
  'buffered' | 'addEventListener' | 'removeEventListener'>;

// A direct original has no adaptive ladder. Fall back before a persistently
// draining buffer empties, or after a sustained stall. Pauses and seeks are not
// evidence of a slow connection. One monitor belongs to one media element.
export const monitorDirectPlayback = (video: DirectMedia, onFallback: () => void) => {
  let timer: ReturnType<typeof setInterval> | undefined;
  let last: { time: number; position: number; ahead: number } | undefined;
  let stalledAt: number | undefined;
  let drainingSamples = 0;
  let disposed = false;

  const reset = () => {
    last = undefined;
    stalledAt = undefined;
    drainingSamples = 0;
  };
  const stop = () => {
    if (timer !== undefined) clearInterval(timer);
    timer = undefined;
    reset();
  };
  const sample = () => {
    if (video.paused || video.ended || video.seeking) {
      reset();
      return;
    }
    const time = performance.now();
    const position = video.currentTime;
    let ahead = 0;
    for (let i = 0; i < video.buffered.length; i++) {
      if (video.buffered.start(i) <= position + 0.05 && video.buffered.end(i) > position) {
        ahead = video.buffered.end(i) - position;
        break;
      }
    }
    // An almost finished original does not need a new HLS session.
    if (Number.isFinite(video.duration) && video.duration - position <= Math.max(1, ahead + 0.1)) {
      reset();
      return;
    }
    if (last) {
      const elapsed = (time - last.time) / 1000;
      const advanced = position - last.position;
      if (elapsed > 0 && advanced >= 0 && advanced < 0.1 && video.readyState < 3) {
        stalledAt ??= last.time;
      } else {
        stalledAt = undefined;
      }
      const draining = elapsed > 0 && advanced > 0.1 && ahead < 3 &&
        ahead < last.ahead - elapsed * video.playbackRate * 0.25;
      drainingSamples = draining ? drainingSamples + 1 : 0;
      if ((stalledAt !== undefined && time - stalledAt >= 4000) || drainingSamples >= 2) {
        cleanup();
        onFallback();
        return;
      }
    }
    last = { time, position, ahead };
  };
  const start = () => {
    if (disposed || timer !== undefined || video.paused || video.ended) return;
    reset();
    timer = setInterval(sample, 1000);
  };
  const cleanup = () => {
    if (disposed) return;
    disposed = true;
    stop();
    video.removeEventListener('play', start);
    video.removeEventListener('playing', start);
    video.removeEventListener('pause', stop);
    video.removeEventListener('ended', stop);
    video.removeEventListener('seeking', reset);
  };
  video.addEventListener('play', start);
  video.addEventListener('playing', start);
  video.addEventListener('pause', stop);
  video.addEventListener('ended', stop);
  video.addEventListener('seeking', reset);
  start();
  return cleanup;
};
