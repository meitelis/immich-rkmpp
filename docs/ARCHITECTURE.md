# Immich RKMPP adaptive playback — design draft

Status: **proposal only**. No Immich integration, player hooks, API endpoints, transcoder changes, or deployment code implemented. Do not deploy.

## Objective

Prefer the authenticated original when client support and measured network capacity allow. Otherwise provide adaptive HLS with hardware-accelerated RK3588 video, continuous audio across HLS rendition switches, and the smallest practical interruption on original-to-HLS fallback.

## Boundaries

- Integrate with Immich's existing asset permissions, streaming routes, transcoding jobs, and clients. Never reuse Nextcloud Memories endpoints or authentication.
- Preserve Immich's standard playback as a safe fallback. No database or original-file mutation.
- Web and native mobile playback require separate feasibility studies and implementations.
- Reuse RKMPP/RGA/OpenCL concepts from memories-rkmpp, not its go-vod protocol.
- Avoid unnecessary transcodes; inspect Immich's current RKMPP pipeline first.

## Playback state machine

1. METADATA: get authorized source URL, video/audio codec, container, duration, average and preferably peak/percentile bitrate; determine browser/native compatibility.
2. NETWORK: reuse recent server-specific throughput samples only while fresh and network identity unchanged; otherwise a bounded same-origin authenticated probe, without reading a large original or causing playback delay. If unavailable, conservatively start existing Immich playback.
3. DECIDE: choose original only if compatible and conservative bandwidth budget exceeds estimated source demand; otherwise start an HLS rendition whose advertised bitrate fits the budget. A codec guess or resolution alone must not authorize direct play.
4. DIRECT: sample buffered playable seconds and observed transfer throughput where exposed. Predict starvation using both delivery rate and buffer depletion. Trigger one-way fallback before a stall, preserving playback position and pause state. Do not oscillate between original and HLS during the same session.
5. HLS: use actual rendition bitrates and fragment throughput; downshift promptly when risk rises, upgrade conservatively with hysteresis. Handle variable bitrate, short buffers, seeks, paused playback, and network changes.
6. ERRORS: retain Immich's existing playback route; report structured errors without leaking private asset URLs/tokens.

## Audio continuity

Preferred target: one timestamp-continuous AAC audio rendition shared across independently switchable video renditions, if supported by the selected HLS format and clients. Verify codec parameters, PTS/DTS, segment boundaries, encoder delay and player buffer behavior. Do not assume matching AAC bitrate alone prevents clicks. Keep audio buffer intact on video quality changes; test direct-to-HLS source replacement separately. Do not use fades to hide timestamp bugs.

## RK3588 transcoding

Evaluate MPP decoding, RGA scale/rotate, h264_rkmpp and hevc_rkmpp output, Mali OpenCL HDR10/HLG tone mapping, and safe fallbacks per source. Probe actual frames and decoder/encoder compatibility, especially 10-bit HEVC and format conversions. Never advertise unverified Dolby Vision support. Bound parallel transcodes and memory use on ROCK 5B+ (24 GB RAM). Compare against Immich's upstream RKMPP path.

## Delivery architecture — to decide after source audit

- Compare Immich's existing pretranscoded MP4 delivery with on-demand HLS and cached HLS rendition ladders.
- Identify exact Immich server, web and mobile extension points and version pin.
- Decide TS vs fMP4/CMAF, segment duration, keyframe alignment, HLS playlist generation, token expiry and authorization.
- Define cache eviction, concurrency, request cancellation and cleanup.
- Avoid adding a reverse proxy or public endpoint that bypasses Immich authentication.

## Required validation

See TEST_PLAN.md. No feature should be marked implemented until tested end-to-end.
