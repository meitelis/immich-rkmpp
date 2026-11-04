# Immich RKMPP

A pinned, rebuildable RK3588 customization for **Immich 3.3.5**, with hardware HEVC/H.265 and H.264 real-time playback. The custom server and browser are built into one Immich runtime image. No compiled JavaScript bind mount is needed.

Immich 3.3.5 already includes RKMPP and real-time HLS. This project preserves that engine and its buffering, prewarming and idle management. The overlays fix encoder startup races, rendition sizing and HDR surface conversion, add browser capability checks and a one-time H.264 retry, preserve verified compatible AAC, and support explicit Original playback with adaptive fallback.

The exact upstream source commit and official runtime digest are in [upstream.json](upstream.json). Source preparation verifies both pins. This package supports that version only; applying its files to another Immich version is unsupported. It is independent of the official Immich project and licensed under AGPL-3.0.

## Build

Use an ARM64 Linux build host with Docker, Git and Python 3. Host Node.js is optional: if Node.js 24 or newer is available, source preparation uses it; otherwise one disposable container from the pinned official build image supplies Node and Git. No host npm or pnpm installation is needed. The RK3588 device interfaces are needed for hardware verification and playback, not for compiling the image. Docker BuildKit is optional.

```sh
git clone https://github.com/meitelis/immich-rkmpp.git
cd immich-rkmpp
sh scripts/build.sh
```

The build creates `local/immich-server:rkmpp-3.3.5-r3`. It fetches a fresh pinned upstream checkout under `work/`, applies the overlays, checks the server and browser, and compiles both. The runtime reuses the matching official image's dependencies, FFmpeg, CLI and core plugins. It does not rebuild unrelated Immich CLI or plugin binaries. A container used for source preparation is removed when it finishes; it adds no ongoing runtime service.

For another tag or source destination:

```sh
sh scripts/build.sh --image local/immich-server:rkmpp-3.3.5-r3 \
  --source-dir /path/to/new/immich-source
```

An existing destination is refused to protect other work. Retain the resulting image or export it with `docker save` for another compatible ARM64 Docker host. The CI workflow builds and tests the image; it does not publish a prebuilt registry image.

## Deploy into an existing Immich stack

Start from the existing, working Immich 3.3.5 Compose stack. Keep its database, Redis, media and plugin volumes, machine-learning service, network, environment and application settings. Keep the normal Immich database and media backups as well.

Deployment and rollback require Docker Compose and Python 3 only; Node.js, npm and pnpm are not required on the Radxa.

1. Save a copy of the Compose file **before editing it**, such as `docker-compose.yml.before-rkmpp`.
2. Change only the `immich-server` image to `local/immich-server:rkmpp-3.3.5-r3` and set `pull_policy: never` for a locally built image.
3. Remove any old bind mount that replaces `/usr/src/app/server/dist/utils/media.js`, another compiled server file, or `/build/www`. Such a mount would hide the code built into this image. The deployment script refuses these mounts.
4. Retain the RK3588 devices and matching Mali/OpenCL host setup. [compose.override.example.yml](compose.override.example.yml) shows the relevant device and library mappings, but is not a replacement for a complete Immich stack. Compose merges volume entries, so adding this example alone does not remove an old JavaScript mount.
5. Deploy the server using the **existing Compose project name**:

```sh
sh scripts/deploy.sh \
  --compose-file /path/to/immich/docker-compose.yml \
  --rollback-compose-file /path/to/immich/docker-compose.yml.before-rkmpp \
  --project immich \
  --backup-dir /path/to/private/immich-rkmpp-backups
```

The script checks the running version, the new image and its ARM64 architecture. It saves private, resolved rollback configuration and the exact previous image ID, then recreates only `immich-server` and waits for health. Database and machine-learning containers are not restarted. If startup fails, it attempts to restore the previous server. Deployment does not import a new application configuration or issue database commands.

Add `--dry-run` to perform the same preflight and save rollback state without recreating any container.

When the Compose file uses relative paths, the default project directory is the Compose file's directory. Pass `--project-directory /original/stack/directory` when that differs. Use the original project name and original directory when deploying a Portainer-managed stack; preserve the edited Compose source in Portainer too so a later redeploy keeps this image.

The returned rollback directory contains resolved environment values and may contain credentials. Keep it private and outside Git. Do not remove the previous image until the new release is verified.

## Roll back

Use the private state directory printed by `deploy.sh`:

```sh
sh scripts/rollback.sh --state-dir /path/to/private/immich-rkmpp-backups/deploy-TIMESTAMP.SUFFIX
```

This recreates only the server from its previous resolved configuration and exact saved image ID. It does not roll back the database or media. Restore the pre-change Compose source as well before a later Portainer or Compose stack redeploy; the rollback command does not edit that source file.

## Playback configuration

In Immich's administration settings, select RKMPP, enable hardware decoding and real-time transcoding, and enable HEVC and H.264 with the desired resolution ladder. The browser selects an efficient supported codec; it can retry once with an H.264-only master if HEVC decoding fails. Native HLS playback uses the same server-side codec filter for that retry.

[config.example.json](config.example.json) is an illustrative fragment, not a complete configuration or an automatic migration. Offline transcoding policy and accepted stored-video codecs are separate from the real-time ladder. Preserve your existing offline choices rather than replacing the whole configuration with the example.

The host still needs a working RK3588 kernel/media driver and compatible Mali libraries for GPU tone mapping. The container cannot supply a host kernel driver. Supported video retains MPP decode/encode, RGA scaling and Mali tone mapping where available; unsupported inputs can require CPU processing. A reliable utilization percentage and universal click-free or lag-free playback are not claimed.

## Verify

Focused source regressions need Node.js 24 and the pinned test dependency:

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm test
```

The image build also checks server TypeScript, the upstream HLS/transcoding/streaming-DTO suites, Svelte, browser TypeScript and both production builds. [scripts/verify-hardware.mjs](scripts/verify-hardware.mjs) tests generated synthetic HLS fragments on actual Rockchip hardware. Run it in a disposable container with the same devices and libraries and an isolated scratch mount; it does not need your photo library or database.

See [verification](VERIFICATION.md) for completed checks and their limits, and [implementation status](docs/IMPLEMENTATION_STATUS.md) for the boundary between current changes and the broader design proposal. Source tests alone do not establish playback performance on every client.

## Updating Immich

Do not change the underlying Immich tag independently of these overlays. Review the matching upstream changes, update the source/runtime/build pins together, rebuild, and repeat the source, hardware and browser checks. A current official release may make some overlays unnecessary; retain only the fixes still needed.
