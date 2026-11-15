# Implementation status — Immich 3.4.1

**Current as of 15 November 2026.** The Immich RKMPP 3.4.1 release is merged into `main`, not an unmerged prototype. The exact upstream source and runtime image are pinned in [upstream.json](../upstream.json). The tested image and ROCK 5B+ qualification record are in [RELEASE_3_4_1.md](RELEASE_3_4_1.md).

## Implemented on the release branch

- RK3588 real-time H.264/HEVC transcoding via Immich's existing RKMPP framework; encoder startup and teardown race protections.
- Native hls.js Auto with a bounded same-origin startup bandwidth probe, conservative fallback and recovery.
- Authenticated `Original` stream copy for compatible codecs, including supported SDR Main10 HEVC, with presentation-grid validation.
- Independent on-demand rendition producers and one shared compatible AAC timeline, retaining audio across quality changes.
- Scheduled manual resolution switching without unnecessarily flushing the playing fragment.
- RKMPP input pacing, seek handling, quality-independent sessions, correct source dimensions/rotation and supported SDR/HDR paths.

## Verified

The 3.4.1 candidate passed ARM64 CI, the 38-case extended synthetic RK3588 hardware matrix, the dedicated Original/H.264/HEVC/AAC fragment suite, and a successful production health/playback report from the owner. See [the dated evidence](RELEASE_3_4_1.md) for the precise image ID, commands, results and limitations.

## Outside verified scope

Native Android/ExoPlayer behavior, Safari-native HLS, all mobile network transitions, perceptual HDR rendering, all audio-click edge cases and maximum multi-viewer throughput are **not** established. Future upstream Immich versions must be ported, source-reviewed and qualified again before deployment. The older [architecture draft](ARCHITECTURE.md) and [test plan](TEST_PLAN.md) remain design/checklist records, not current deployment instructions.

For builds, safe Portainer updates and rollback, use the [main README](../README.md). Previous 3.4.0 and proposal-era findings remain in [VERIFICATION.md](../VERIFICATION.md).
