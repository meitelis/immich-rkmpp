# Broader validation and acceptance plan

## Baseline
- Pin Immich release/commit, FFmpeg build, Armbian vendor kernel, MPP/RGA/Mali versions and browser/mobile versions.
- Record existing direct playback, Immich transcoded playback, memory, CPU, GPU and bandwidth before changes.

## Media matrix
- H.264/AAC MP4; HEVC 8/10-bit MP4; 4K HDR10/PQ; HLG; rotated videos; variable frame rate; long GOP; unsupported codec; no audio; multichannel audio; non-AAC audio; variable bitrate and bursty scenes.
- Verify frame output, duration, audio/video sync, seek, pause/resume, subtitles if supported, and correct HDR/SDR colors.
- Verify no original asset modification.

## Network matrix
- Stable fast LAN; constrained 2–5 Mbps WAN; sudden drop from fast to slow; fast/slow oscillation; high RTT/jitter; packet loss; Wi-Fi to cellular; complete disconnect/reconnect.
- Measure startup delay, rebuffer count and duration, rendition selection, switching frequency and bytes transferred.
- Validate stale throughput invalidation and missing-metadata fallback.
- Validate direct-to-HLS switch preserves playback time and does not repeatedly bounce.

## Audio
- Check each rendition's AAC codec, channel layout, sample rate, PTS continuity, discontinuities and alignment using ffprobe/ffmpeg.
- Listen and capture audio around 100+ HLS quality switches; test on Chrome/Firefox/Android/iOS as available.
- Record audible clicks, gaps and drift; distinguish HLS switching from original-to-HLS source replacement.

## Safety and robustness
- Unauthorized asset requests, expired auth, range requests, seek storms, aborted connections, repeated retries, simultaneous viewers, server restart and cache eviction.
- Run unit tests for bitrate budgeting, starvation prediction, hysteresis, state transitions and URL authorization.
- Confirm hardware actually used via logs and throughput rather than merely enabled in config.

## Acceptance criteria (targets, not guarantees)
- Zero audible clicks or gaps attributable to ordinary HLS rendition changes in the test matrix.
- No avoidable rebuffer under sustained bandwidth sufficient for the lowest rendition.
- No playback regression compared with stock Immich for unsupported browsers/assets.
- Reproducible deploy/rollback and no security regression.

## Status
This complete matrix remains pending. Specific source, build, hardware and live checks are recorded separately in [verification](../VERIFICATION.md). Do not infer that every acceptance target has been met.
