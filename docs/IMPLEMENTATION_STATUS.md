# Implementation status

Updated: 4 November 2026. Applies to pinned Immich **3.3.5**, upstream commit `8303cb117e197c700332b33b61b45314c9cc5bb4`.

The architecture, handoff and acceptance documents describe a broader proposed playback system. They are planning documents, not a statement that every feature is implemented or that this repository contains only documentation. The implementation in PR #1 and its reviewed follow-up changes have the narrower scope below.

## Existing Immich functionality retained

Immich 3.3.5 already provides authenticated, on-demand real-time HLS with fragmented MP4 segments, HEVC and H.264 renditions from 480p through 2160p, strict keyframe/timestamp handling, seeking, prewarming, backpressure and session cleanup. A session runs its selected rendition; it does not continuously encode the entire ladder. The browser uses hls.js adaptive selection, with native HLS available on supported clients.

The RK3588 deployment supplies MPP devices, RGA and Mali/OpenCL access and preserves the existing full-size NV12 normalization needed by this board. A pinned image packages the server and browser overlays together. Build, guarded deployment and rollback scripts retain the existing application configuration, media and database.

## Reviewed R1 implementation

- Guard overlapping encoder starts, cancellation and session replacement to avoid duplicate or orphan processes.
- Match advertised rendition dimensions and codec levels to actual encoder output; prevent accidental upscaling and retain full-size SDR format normalization.
- Retain Mali HDR conversion with CPU fallback and hardware MPP encoding.
- Query browser capabilities for actual rendition dimensions, bitrate and frame rate, with a bounded cache.
- Retry fatal HEVC compatibility failures once using an authenticated H.264-only master, preserving position and playback state.

These changes have an existing built and deployed R1 baseline. They do not establish the broader proposal's acceptance criteria.

## Follow-up source changes awaiting full validation

- Honour the existing explicit **Play original** choice. On decoder rejection, sustained stalls or a persistently draining buffer, switch once to adaptive HLS while preserving position and paused/playing state. Monitoring stops on pause, end and cleanup and resumes correctly on play.
- Send the real playhead for manual quality-change prewarming and the exact associated media sequence for init requests, using existing Immich request headers.
- Prevent Space on a focused media control from also activating the body playback shortcut.
- Evaluate preserving compatible, moderate-bitrate AAC-LC packets. The audio-copy proposal remains under hardware and timeline testing; it must not be treated as a completed audio-continuity solution.

These additions are source changes, not a claim that the current live image already contains them.

## Still proposed

Automatic original-first selection is implemented on the separate
`feat/auto-original-rkmpp-playback` branch and **awaits full production-build and live-client validation**.
It adds authorized stream metadata, a bounded same-origin throughput probe and
a conservative browser codec/bitrate gate. Unknown or unsafe cases start
existing HLS instead. The existing direct playback monitor supplies one-way
direct-to-HLS fallback; there is no automatic return to the original during
a session. The user can toggle Auto; explicit Original is retained.

Independent shared audio is **not implemented**. Current HLS renditions contain muxed audio; manual quality selection retains the immediate buffer-flushing behavior. Using a non-flushing switch unconditionally could defer a visible change until the existing 30–60 second buffer drains. Shared audio, bounded switching and continuity require further design and real-client verification. No click-free or seamless-switching guarantee is made.

Custom predictive HLS ABR, an automatic speed test, network-change detection and native mobile integration also remain future work. The existing hls.js adaptation remains in use.

## Verification boundary

The earlier R1 baseline passed the full server/browser image build, 98 focused upstream tests, 54 source regressions and 26 synthetic RK3588 hardware scenarios. The current follow-up source suite has **74 passing tests**; a complete rebuild and the additional audio, direct-play and live-browser checks are still pending. Earlier hardware results must not be presented as validation of later source changes.

The comprehensive network/device matrix and audio acceptance targets in the test plan have not been completed. No reliable VPU-utilization percentage or maximum simultaneous-viewer count has been established. Test reports and future status updates must distinguish synthetic hardware checks, source tests and observed playback on actual clients.
