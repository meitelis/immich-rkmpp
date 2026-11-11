#!/bin/sh
set -eu
usage() { echo 'Usage: sh scripts/build.sh [--image IMAGE] [--source-dir NEW_DIRECTORY]'; }
fail() { echo "Error: $*" >&2; exit 1; }
root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd -P)
image=local/immich-server:rkmpp-3.4.0-r4-memories
source_dir=$root/work/source-$(date -u +%Y%m%dT%H%M%SZ)-$$
while [ "$#" -gt 0 ]; do
    case "$1" in
        --image|--source-dir)
            [ "$#" -ge 2 ] || fail "Missing value for $1"
            case "$1" in --image) image=$2 ;; *) source_dir=$2 ;; esac
            shift 2 ;;
        -h|--help) usage; exit 0 ;;
        *) usage >&2; fail "Unknown argument: $1" ;;
    esac
done
case "$image" in ''|-*|*[!A-Za-z0-9_./:-]*) fail 'Invalid tagged image name' ;; esac
docker version >/dev/null
revision=$(git -C "$root" rev-parse --verify HEAD 2>/dev/null || printf local)
if command -v node >/dev/null && node -e 'if(Number(process.versions.node.split(".")[0])<24)process.exit(1)' 2>/dev/null; then
    command -v git >/dev/null || fail 'Git is required with host Node.js source preparation'
    node "$root/scripts/prepare-source.mjs" "$source_dir"
else
    command -v python3 >/dev/null || fail 'Install Python 3 or Node.js 24 for source preparation'
    [ ! -e "$source_dir" ] && [ ! -L "$source_dir" ] || fail 'Source destination already exists; choose a new directory'
    source_name=$(basename -- "$source_dir")
    case "$source_name" in ''|.|..) fail 'Choose a named source directory' ;; esac
    source_parent=$(dirname -- "$source_dir")
    mkdir -p -- "$source_parent"
    source_parent=$(CDPATH= cd -- "$source_parent" && pwd -P)
    source_dir=$source_parent/$source_name
    case "$root:$source_parent" in *'
'*) fail 'Build paths must not contain newlines' ;; esac
    case "$root" in *:*) fail 'Container source preparation does not support colons in paths' ;; esac
    case "$source_parent" in /|*:*) fail 'Choose a non-root source parent without colons' ;; esac
    builder=$(python3 - "$root/Dockerfile.rkmpp" <<'PY'
import re,sys
with open(sys.argv[1], encoding='utf8') as handle:
    first = handle.readline().strip()
match = re.fullmatch(r'FROM (ghcr[.]io/immich-app/base-server-dev:[^ ]+@sha256:[0-9a-f]{64}) AS builder', first)
if not match:
    raise SystemExit('Missing pinned official source-preparation image')
print(match[1])
PY
)
    # A disposable build utility supplies Node/Git; the runtime gains no helper
    # service or host Docker socket. The package itself is mounted read-only.
    docker run --rm --user "$(id -u):$(id -g)" --env HOME=/tmp \
        --volume "$root:/package:ro" --volume "$source_parent:/source" \
        --entrypoint node "$builder" --input-type=module -e '
            import { spawnSync } from "node:child_process";
            import { pathToFileURL } from "node:url";
            if (Number(process.versions.node.split(".")[0]) < 24) throw new Error("Pinned build image needs Node.js 24 or newer");
            if (spawnSync("git", ["--version"], { stdio: "ignore" }).status !== 0) throw new Error("Pinned build image needs Git; alternatively install Node.js 24 on the host");
            const [script, target] = process.argv.slice(1);
            process.argv = [process.execPath, script, target];
            await import(pathToFileURL(script).href);
        ' /package/scripts/prepare-source.mjs "/source/$source_name"
fi
docker build -f "$source_dir/Dockerfile.rkmpp" -t "$image" \
    --build-arg "RKMPP_REVISION=$revision" \
    --build-arg 'IMMICH_BUILD=rkmpp-3.4.0-r4-memories' "$source_dir"
printf 'Built image: %s\nPrepared source: %s\n' "$image" "$source_dir"
