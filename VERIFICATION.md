# Immich RKMPP verification

Review date: 4 November 2026. Target: Immich 3.3.5 on RK3588, with the source and runtime pinned in `upstream.json`.

The original service used native Immich 3.3.5 real-time HLS plus a mounted RKMPP media module. The package now builds its server and browser overlays into one runtime image, retaining native session ownership, prewarming, strict GOPs, buffering, backpressure and idle cleanup.

## Source regressions

78 focused Node tests pass. They cover encoder-start concurrency and cancellation, codec-filtered playlists and authentication, FFmpeg-compatible dimensions and level selection, HDR no-upscale behavior, bounded browser capability caching and HEVC-to-H.264 recovery. Follow-up coverage includes conservative AAC-copy decisions, one audio probe per session, cold-seek packet trimming, explicit Original playback with adaptive fallback, direct-monitor cleanup, quality-switch hints and controller rebinding. Paused recovery is tested against delayed autoplay, including native HLS. Negative controls reproduce the lifecycle, browser and copied-audio regressions against prior source.

## Hardware checks

The built R2 image passed 34 synthetic scenarios on the actual ROCK 5B+: five resolutions from 480p to 2160p in HEVC and H.264, cold seeks at 1080p and 2160p, software decode with MPP encode, rotation, Mali/CPU HDR conversion, full-size 10-bit SDR, a source below the minimum ladder size, copied mono/stereo AAC and PCM/FLAC conversion. Each video fragment was independently decoded; dimensions, frame counts, keyframes, codec levels and timelines were checked. Copied audio retained source payload hashes and timestamps; audio was strictly decoded and checked for boundary alignment and continuity.

Negative hardware testing caught copied AAC preroll at cold seeks: six scenarios began audio at zero while video began at two seconds. Dropping only copied packets before the exact shared GOP boundary corrected all six failures. The corrected isolated run passed 26/26, followed by the complete 34/34 compiled-image matrix without a replacement media-module bind mount. Initial playback preserves source priming; offline conversion is unchanged.

## Remaining release checks

The complete R2 build passed server TypeScript, 98 focused upstream tests, Svelte, browser TypeScript and both production builds. R2 was deployed with explicit approval and is healthy; the effective configuration changed only the image. Media volumes, the anonymous data volume and hardware devices were preserved. Live checks reached actual 3840×2160 with RKMPP decode/encode, RGA and copied AAC. Selecting Original retained a paused position and released the encoder.

Browser checks then exposed a media-chrome control-store race after replacing HLS with a native video: the video loaded but Play and the clock disconnected. R3 adds guarded rebinding after the DOM mutation batch. Its two source regressions pass; the full R3 browser build and repeated live control checks are pending. R3 has no backend or FFmpeg changes; the R2 hardware matrix applies to that backend.

These are correctness checks and synthetic measurements, not a before/after throughput benchmark. They do not establish every HDR profile, client/browser, network condition or a maximum viewer count. No reliable VPU utilization percentage is available on this host. Private media, credentials, account identifiers and deployment configuration are excluded from this repository.
