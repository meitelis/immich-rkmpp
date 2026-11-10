# Immich 3.4.0 port — 10 November 2026

Candidate: `local/immich-server:rkmpp-3.4.0-r4-memories`, built from the
official 3.4.0 source and matching pinned runtime. Upstream event, image,
public-config, import and FaceEditor changes are preserved. The quality menu
adds advertised bitrate labels and always includes eligible Original in Auto.

Local validation: 106 source/controller regressions, three real H.264/HEVC/AAC
fragment cases, server/web TypeScript, Svelte diagnostics and both production
builds pass. The actual Media Chrome 4.19.3 menu renders the new resolution,
Original and bitrate labels without console errors in an isolated browser
preview. Targeted upstream tests pass 95/98 on Windows; the remaining three
compare Linux paths. The ARM64 CI result on the PR is authoritative.

The user reports smooth playback and resolution switching on the corrected
3.3.5 image. The 3.4.0 candidate still needs on-board and live playback checks.
Upgrading from 3.3.5 runs upstream database migrations: back up the database and
stack before deployment; replacing the image alone does not undo migrations.

---

# Memories strategy port on 3.3.5 — 10 November 2026

Development candidate: rkmpp-3.3.5-r4-memories. This changes the server and
browser pipeline; the historical R2/R3 results below are not validation of it.

Local Windows checks:

- Focused source/policy/lifecycle/controller regressions pass, including the
  actual hls.js 1.7.3 startup controller and subsequent native downshifts.
  There are 107 passing source checks; three real-FFmpeg cases are opt-in and
  were also run separately with the binaries and compiled media module below.
- Real FFmpeg H.264 B-frame and HEVC open-GOP remuxes pass full/cold fragment
  decode, exact raw MP4 presentation ranges and original video payload hashes.
- Real shared AAC passes padding through a short source's tail and cold seeks.
- Server TypeScript, Svelte diagnostics and browser TypeScript pass.
- The server production build passes.
- The web production build passes (existing upstream chunk/wasm warnings).
- The upstream targeted server suite passes 95/98 locally; three expected
  Linux-path command snapshots differ only by Windows path separators. The
  ARM64/Linux CI run is authoritative for those three snapshots.

GitHub Actions builds the pinned ARM64 server and browser image, runs the full
targeted upstream server suites and real fragment checks with the candidate's
FFmpeg. Its exact revision/result must be checked on the PR.

The first ARM64 candidate built successfully and passed all 98 targeted server
tests. Runtime fragment checks caught the bundled FFmpeg's missing
readrate_catchup option. The port uses its supported readrate 1 / initial burst
18 options and does not change the pinned FFmpeg or runtime dependencies.

The user ran the SDR hardware matrix on commit 85d2f745: 34/34 passed,
including paced/source-grid/cold-seek cases. Mali/HDR was not exercised.
The user then deployed that candidate; live browser inspection found an empty
media source and `Failed to construct 'URL': Invalid URL` before HLS startup.
The new preparation helper incorrectly required an absolute master URL, while
Immich's production URL builder normally returns `/api/assets/...`.

The fix resolves both preparation and probe/metadata endpoint URLs against the
browser location. Three regressions use the production URL-builder functions
with root-relative, subpath and absolute API bases; the two relative cases fail
before the fix and pass after it. Authentication and codec query parameters
are checked. No server, FFmpeg or hardware behavior changes in this fix.

Still required: repeat actual-browser startup after deploying the URL fix, then
fast/slow/network-change/quality-switch/seek/pause/EOF acceptance, with audible
continuity and A/V drift checks. The fix has not been deployed by the agent.
See [the deployment gate](docs/MEMORIES_PLAYBACK.md).

---

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
