# Immich RKMPP verification

Review date: 3 November 2026. Target: Immich 3.3.5 on RK3588, with the source and runtime pinned in `upstream.json`.

The reviewed production service uses native Immich 3.3.5 real-time HLS plus a mounted RKMPP media module. The final package retains native session ownership, prewarming, strict GOPs, buffering, backpressure and idle cleanup.

## Source regressions

54 focused Node tests pass. They cover encoder-start concurrency and cancellation, codec-filtered playlists and authentication, FFmpeg-compatible dimensions and level selection, HDR no-upscale behavior, bounded browser capability caching and HEVC-to-H.264 recovery. Paused recovery is tested against delayed autoplay, including native HLS. Negative controls reproduce the lifecycle and browser regressions against the prior source.

## Hardware checks

An initial candidate passed 22 synthetic scenarios on the actual ROCK 5B+: five resolutions from 480p to 2160p in HEVC and H.264, cold seeks at 1080p and 2160p, software decode with MPP encode, rotation, and Mali/CPU HDR conversion. Every fragment was independently decoded; dimensions, frame counts, keyframes and timelines were checked.

That run confirmed a second compatibility issue: the encoder hardcoded level 5.1 while the master advertised lower levels for small renditions. The HLS-only correction now uses the master’s dimension/frame-rate level calculation; repeated hardware validation with an explicit codec-level assertion is pending.

## Remaining release checks

The complete server/browser image build, upstream focused suites, deployment-script syntax and live browser verification are pending. This document will be updated with the completed results before a release is declared validated.

These are correctness checks and synthetic measurements, not a before/after throughput benchmark. They do not establish every HDR profile, client/browser, network condition or a maximum viewer count. No reliable VPU utilization percentage is available on this host. Private media, credentials, account identifiers and deployment configuration are excluded from this repository.
