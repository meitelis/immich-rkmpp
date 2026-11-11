# Codex handoff — start here

This document records the broader design handoff. The repository now also contains a version-pinned implementation; read [implementation status](IMPLEMENTATION_STATUS.md) and [verification](../VERIFICATION.md) first. Develop remaining features incrementally against the current source.

1. Audit the pinned Immich upstream server, web and native player source before writing patches. Document exact files/functions, version compatibility and any already-existing adaptive features.
2. Audit memories-rkmpp separately; classify ideas into reusable RKMPP/FFmpeg concepts, player algorithms, and Memories-specific code that must not be copied.
3. Validate baseline Immich RKMPP transcoding first. Prefer minimal upstream-compatible changes and avoid replacing existing functionality without measurements.
4. Implement small reviewable increments with tests: metadata/codec detection; throughput estimation; ABR decision logic; HLS delivery if necessary; independent audio; safe source fallback; browser integration; mobile separately.
5. Never claim seamless audio or successful hardware decode without playback traces, segment inspection and real-device tests.
6. Produce a version-pinned Docker/Portainer deployment recipe and a rollback plan only after tests.

Review questions:
- Is multi-rendition HLS already supported by this Immich version, or must it be built?
- Which streaming routes and authentication semantics can be reused safely?
- Is independent AAC audio feasible in current player on web and mobile?
- Can direct playback throughput be measured without costly duplicate downloads?
- Does an on-demand ladder overload one RK3588 when several viewers stream simultaneously?
- Which known RKMPP pixel-format/HDR paths fail and what is the safe fallback?

References:
- https://github.com/meitelis/memories-rkmpp/pull/5 (draft, unverified)
- https://docs.immich.app/features/hardware-transcoding/
- https://docs.immich.app/administration/system-settings/
