# Technical review handoff — 11 November 2026

Source: merged `meitelis/immich-rkmpp` main at `3d82c85b3696f384dc39a8a8a13d9df2a563c558`, including PR #5 at `9d072a5f2ff3e05b528cf0d47a64fb7f11d7c248`.
Target: `immich-app/immich` main at `3b2f4642882189260d11fb529bbf8b9021a075ff`.

This is an internal technical inventory, not an upstream PR title, description or submission. Upstream's [contribution policy](https://github.com/immich-app/immich/blob/main/CONTRIBUTING.md#use-of-generative-ai) rejects LLM-generated PRs and requires human communication. The human contributor must review and understand the implementation and write any submission themselves. No upstream issue, PR, comment or discussion was created.

## Source extraction

`0001-playback-source-review.diff` extracts the merged overlay changes into native `server/` and `web/` paths. It excludes custom Docker/Compose files, runtime pins, deployment scripts, historical plans and the package's test harness. Existing upstream HLS and DTO spec changes within the overlays are included.

The source was three-way merged from v3.4.0 onto current main. Two conflicts were resolved for this review candidate:

- Preserve upstream removal of manual header parsing in `VideoStreamController`; keep the strategy argument. This retains upstream global validation and avoids a stale `ZodValidationException` reference.
- Remove the obsolete eager manager `init()` call because the custom capability manager queries real rendition metadata lazily and has no `init()` method.

The candidate also preserves newer QSV/VA-API NV12 tone-mapping fixes and the newer Svelte keyboard-shortcut attachment syntax. These are absent from the pinned release overlays; copying overlays over current main would regress them.

## Hardware scope

Mainline already supports RKMPP. This work is not a request to add RK3588 support from scratch. Candidate improvements include rendition dimensions/codec levels, hardware-frame tone mapping and asynchronous encoder startup/cancellation. Review each independently and keep hardware-specific behavior inside the RKMPP path.

Original remuxing, one shared AAC timeline, capability negotiation, bandwidth probing, manual quality controls and native hls.js Auto are a separate browser/server feature. The `strategy=memories` path is a protocol opt-in, not a hardware check; its pacing and timeline behavior can run with other encoders too. Calling this entire patch "RK3588-only" would be inaccurate. A hardware-only submission needs those cross-platform changes removed or split out. Mobile clients keep the old path unless they opt in.

The source diff spans 19 files (1,840 insertions and 200 deletions). It is a review reference and should not be submitted as one broad upstream change. Maintainers ask for focused PRs and prior discussion for larger changes.

## Validation record

- PR #5 was retargeted from `codex/memories-playback-strategy` to this repository's `main` and merged as `3d82c85`. Both source/build workflow runs on its final head succeeded, including [the ARM64 run](https://github.com/meitelis/immich-rkmpp/actions/runs/42944095669).
- Local custom-source suite: 121 passed, zero failed, three real-FFmpeg tests skipped because matching FFmpeg/compiled-media inputs were not supplied. These results apply to the merged custom source, not the resolved current-main candidate.
- The native diff passed whitespace checks and replayed on a fresh exact-target checkout, producing the Git tree in `manifest.json`.
- `mise`, the upstream toolchain/dependencies and Docker are absent here. No current-main TypeScript/Svelte build, upstream server suite, code generation or native browser test is claimed.

## Required work before any human submission

- Select one focused change and review whether current main still needs it. Keep CPU, QSV, VA-API, CUDA and mobile behavior covered as well as RKMPP.
- Move relevant custom harness cases into upstream Vitest/controller/browser suites. Patch replay does not establish correctness.
- Run upstream build/lint/test tasks through mise. New endpoints/query DTOs need typed schemas, endpoint/controller coverage and `mise //:open-api`; do not hand-edit generated clients.
- Review browser/server API use against the typed SDK, translation keys, upstream naming and the rule against adding code comments. Existing overlay comments and direct helper requests need cleanup for a native contribution.
- Capture RK3588 evidence for the exact selected commits: startup, seeks, codec switching, cancellation, concurrent streams, HDR and audio. Capture unaffected behavior on other backends.
- For the larger playback feature, obtain maintainer agreement on API shape, shared-audio protocol, copy-grid eligibility and rollout before investing in a submission.
- A human must understand and explain every proposed change and comply with the upstream AI policy. This handoff does not bypass that requirement.

## Inspect safely

Run `python3 verify.py /path/to/clean/immich-checkout` at the exact target commit. Verification uses a temporary clone and leaves the supplied checkout and services untouched. The patch is for review and can be applied manually on an isolated branch with `git apply --index`.

`meitelis/immich-rkmpp` is a standalone packaging repository. An upstream PR needs a real fork of `immich-app/immich` with upstream ancestry and the selected native-source changes, not this packaging repository's main branch.
