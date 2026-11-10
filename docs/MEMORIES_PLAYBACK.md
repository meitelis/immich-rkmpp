# Memories playback port

Development image: `local/immich-server:rkmpp-3.4.0-r4-memories`.
This is a coordinated server + web change on pinned Immich 3.4.0. It replaces
the draft direct-file Auto policy with one adaptive HLS playback path.

## Playback behavior

- A bounded same-origin probe runs in parallel with indexed source metadata.
  Its conservative bandwidth estimate seeds native hls.js Auto. The separate
  lowest-rendition startup bandwidth test is disabled, so fast links need not
  cold-start 480p before selecting high quality.
  An affordable supported Original is explicitly seeded for the first load so
  native codec-tier preference cannot select an unnecessary encoded alternative.
  Subsequent loads remain under native Auto control.
- A compatible Original is a video stream-copy rendition in the same master.
  It has the source codec/profile and original dimensions; FFmpeg remuxes video
  packets without decoding, scaling or encoding them. Original does not imply
  a byte-identical container or unmodified audio.
- Encoded renditions and Original share one video presentation grid, including
  open-GOP leading-picture boundaries. Cold copy seeks use decoder-entry PTS;
  encoded seeks decode from the preceding entry when required and trim to the
  requested presentation boundary. Copied fragments preserve composition offsets.
- One independent 192 kbps stereo/48 kHz AAC stream is shared across all video
  qualities. It is normalized/padded through the picture's duration and is not
  restarted when video quality changes. Additional adaptive audio profiles and
  source-AAC copying are not part of this port.
- Manual resolution changes select future fragment loads without clearing the
  playable buffer. Returning to Auto releases the manual pin. A visible change
  can take up to the retained buffer; it is not promised to be instant.
- Quality entries show their advertised HLS bandwidth beside the resolution
  (for example, `1080p · 4.2 Mbps`). This is nominal stream bandwidth, including
  shared audio where advertised, rather than a live transfer-speed measurement.
  Eligible Original is always included in Auto; no separate toggle is needed.
- Forward buffer: 18 seconds, maximum 96 MiB; back buffer: 8 seconds. Only
  requested renditions run. Workers use FFmpeg input pacing: rate 1, initial
  burst 18 seconds. The pinned Immich FFmpeg does not support Memories' explicit
  3.5x catch-up ceiling, so that flag is deliberately omitted. Pacing is not a
  throughput guarantee; the FFmpeg/runtime pin remains unchanged.
- Completed transfer timings are separated from pre-first-byte producer waits.
  Two agreeing recent samples plus healthy buffer can correct an underestimated
  bandwidth estimate. Network/online/foreground changes and returning to Auto
  can refresh it; below-top recovery probes are bounded to once per 20 seconds.
- Native hls.js still selects Auto renditions and handles emergency downshifts.
  The pinned hls-video-element's programmatic downgrade notification is prevented
  from silently turning Auto into a manual quality pin.
  Recoverable errors are logged without serializing circular loader data, and
  detaching the player restores both temporary integration hooks.
- Original failure disables copy for that asset session and resumes encoded HLS
  at the remembered time and pause state. Explicit **Play original** remains a
  direct-file override with its existing one-way HLS fallback.

## Eligibility and fallback

The browser explicitly negotiates MSE support for source AVC, HEVC Main, or
HEVC Main10. The server independently validates codec/profile/level, bit depth,
rotation and HDR/Dolby Vision exclusions. Source audio need not be browser-safe
because it uses the shared AAC stream.

A packet-only probe has a 1.5-second deadline and bounded grid size. Original is
omitted if it cannot establish a normalized, increasing video timeline, at least
two keyframes, and segments no longer than six seconds. Unknown bitrates, very
long/dense grids, slow probes and unsupported sources retain encoded HLS.
It never silently encodes a rendition labelled Original.

The new server behavior is requested with `strategy=memories`; native/mobile
clients that do not request it retain the existing muxed HLS protocol and
backpressure. Safari native HLS controls its own buffering and adaptation and
is not established by hls.js tests. Offline transcoding settings are independent.

## Checks and deployment gate

The development PR is **not a production release**. Source tests, real fragment
checks and compilation do not establish the board's paced encoder behavior or
the user's actual browser experience. See [verification](../VERIFICATION.md).

Before deploying to the main server:

1. The exact PR revision must pass the ARM64 server + browser image build and
   real FFmpeg fragment checks in GitHub Actions.
2. On the ROCK 5B+, run the existing isolated hardware runner with `--memories`
   in addition to the applicable HDR/audio/rotation tests. This adds 30-second
   video-only source-grid runs beyond the initial production burst, both hardware
   encoders, and cold seeks. Retain the generated report and candidate image ID.
3. Verify a separate test instance in the actual browser: fast-network Original
   startup, unsupported-source encoded startup, Original/2160p/1080p/480p/Auto
   changes, strong-to-weak-to-strong networking, cold seeks, pause/resume, rapid
   asset navigation, EOF and copied-video failure recovery. Check presented
   dimensions, stalls/dropped frames, audible continuity and A/V drift.
4. When upgrading from 3.3.5, back up the database and save the Portainer stack
   before deploying. Immich 3.4 includes database migrations; reverting the
   server image alone is not a complete downgrade. Keep the machine-learning
   image on the matching 3.4.0 release/flavor. The deployment/rollback scripts
   are for same-version 3.4.0 image replacements only.

Build from this development branch, not the README-only default branch:

```sh
git clone --branch codex/memories-playback-3.4 https://github.com/meitelis/immich-rkmpp.git
cd immich-rkmpp
sh scripts/build.sh
```

Run fragment checks in a disposable container using the candidate image (no
library, database or hardware access needed):

```sh
mkdir -p work/playback-fragments
docker run --rm --entrypoint node \
  -v "$PWD:/source:ro" -v "$PWD/work/playback-fragments:/scratch" -w /source \
  -e IMMICH_FFMPEG_BIN=ffmpeg -e IMMICH_FFPROBE_BIN=ffprobe \
  -e IMMICH_PLAYBACK_SCRATCH=/scratch \
  -e IMMICH_COMPILED_MEDIA=/usr/src/app/server/dist/utils/media.js \
  local/immich-server:rkmpp-3.4.0-r4-memories \
  --test tests/playback-fragments.test.mjs
```

The hardware runner is `scripts/verify-hardware.mjs --scratch /scratch --memories`.
Mount it read-only into a disposable candidate-image container, with a separate
scratch directory and the same MPP/RGA/DRM/DMA heap/Mali/OpenCL mappings as the
existing hardware verification setup. It imports the candidate's compiled
server modules, not a JavaScript bind mount over the running service.

## Attribution

Adapted from memories-rkmpp commit
`d6a9471dfbd3dd721bd67698c062ddcc773e232c`: native Auto/probe/buffer policy,
non-flushing selection, shared-audio design, source presentation grids and
hardware input pacing. Immich authentication, session ownership, internal
worker events and cleanup remain the integration boundary. License notices
are in [NOTICE](../NOTICE) and [LICENSES](../LICENSES/Apache-2.0.txt).
