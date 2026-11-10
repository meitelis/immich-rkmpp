# Implementation status

Updated 10 November 2026. Migrated to pinned Immich 3.4.0 source and runtime.

The codex/memories-playback-3.4 branch ports the Memories browser/server
strategy into Immich's existing authenticated streaming/session infrastructure.
It supersedes the separate draft direct-file Auto approach in PR #3.

Implemented: native hls.js Auto seeded by bounded throughput measurements;
source-video stream-copy Original; shared source presentation grids; independent
AAC audio that survives video-quality changes; non-flushing manual selection;
bounded buffers; RKMPP input pacing; copy/codec failure recovery; internal
cross-API-worker plan retrieval and existing session cleanup.

Original eligibility, audio normalization, native/mobile scope and all remaining
deployment gates are documented in [MEMORIES_PLAYBACK.md](MEMORIES_PLAYBACK.md).
The architecture and handoff documents remain design context, not evidence that
their broader client/device/perceptual acceptance matrix has passed.

The branch is a development candidate. Source tests and software fragment checks
do not validate actual RKMPP pacing/forced-IDR behavior or real browser continuity.
See [verification](../VERIFICATION.md) for completed checks and their limits.
