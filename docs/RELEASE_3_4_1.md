# Immich RKMPP 3.4.1 — ROCK 5B+ qualification

Date: **15 November 2026**. This document records user-supplied results from the isolated RK3588 test pipeline and the final running image. It does not claim that GitHub CI has independently reproduced the release.

## Provenance

- Official Immich tag: `v3.4.1` (commit `22b95194c80a2f2e6201093916b6c8c3d6d271dd`).
- Official ARM64 runtime pinned to: `ghcr.io/immich-app/immich-server:v3.4.1@sha256:7c489add298fc2f92cda4c777de6462aa206877e04087b815f62c7664af0b53b`.
- Tested image: `local/immich-server:rkmpp-3.4.1-candidate`.
- Tested image ID: `sha256:d5577865d31213fa030b2d4d38554e8a5a4bb8631b2f2304424d1700578c0f72`.
- Previous running image: `local/immich-server:rkmpp-3.4.0-r4-memories-fix5`.

## Observed checks

| Check | Observed result |
|---|---|
| Targeted server Vitest | 98 / 98 |
| Server TypeScript, web Svelte/TypeScript and builds | Passed |
| Initial RK3588 hardware matrix | 14 / 14 |
| Extended RK3588 hardware matrix (including initial cases) | 38 / 38 |
| Original H.264/HEVC remux, cold seek, shared AAC | 3 / 3 |
| Production server container | `healthy` on the candidate tag |
| User playback report | "Looks like it's working" |

The **38-case extended run includes** SDR H.264/HEVC at 480p–2160p, seek, software-decode fallback, Memories-paced encoding and seeks, rotation, AAC/PCM/FLAC audio, full-resolution SDR10 and small-source paths, and both HDR test modes. The 14-case initial matrix is a subset, not 14 additional unique scenarios. Hardware tests used synthetic sources and a disposable container; production playback confirmation is a separate observation.

4K output in the initial run: HEVC 91.42 fps, H.264 94.99 fps, for a short 30-fps synthetic source. This is not a sustained throughput or concurrency guarantee. An HDR mode reporting success does not alone establish that the intended OpenCL/Mali kernel was used on every path.

The playback-fragment test passed all three tests without skipping: H.264 and HEVC Original remux payload/timeline/cold-seek checks, and independent AAC padding/cold-seek clock.

## Acceptance and limitations

The user confirmed their existing `immich_server` ran `local/immich-server:rkmpp-3.4.1-candidate` with Docker health `healthy` and reported that playback appeared to work. A formal network-degradation/recovery matrix, long-duration concurrency stress, measured A/V drift and GPU tonemap-path instrumentation were not recorded. Preserve the prior image **and database backup** before future upgrades.

This GitHub branch pins the upstream version and build inputs to 3.4.1. Its resulting image requires independent CI reproducibility checks; a successful local candidate built from a prepared workspace does not by itself prove a GitHub rebuild is byte-identical. The project does not autonomously deploy production services.
