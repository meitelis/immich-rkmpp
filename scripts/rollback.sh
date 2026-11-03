#!/bin/sh
set -eu
usage() { echo 'Usage: sh scripts/rollback.sh --state-dir PRIVATE_DEPLOYMENT_BACKUP'; }
fail() { echo "Error: $*" >&2; exit 1; }
case "${1:-}" in
    -h|--help) usage; exit 0 ;;
    --state-dir) [ "$#" -eq 2 ] || { usage >&2; exit 1; }; directory=$2 ;;
    *) usage >&2; exit 1 ;;
esac
directory=$(CDPATH= cd -- "$directory" && pwd -P)
state=$directory/state.json
[ -f "$state" ] && [ -f "$directory/compose.previous.json" ] && [ -f "$directory/rollback.image.yml" ] || fail 'Incomplete rollback state'
command -v python3 >/dev/null || fail 'Python 3 is required'
python3 - "$state" <<'PY'
import json,re,sys
with open(sys.argv[1], encoding='utf8') as handle:
    state = json.load(handle)
directory = state.get('projectDirectory')
if (state.get('schemaVersion') != 1 or
    not re.fullmatch(r'[a-z0-9][a-z0-9_-]*', str(state.get('project', ''))) or
    not isinstance(directory, str) or not directory.startswith('/') or '\n' in directory or
    not re.fullmatch(r'sha256:[0-9a-f]{64}', str(state.get('previousImageId', '')))):
    raise SystemExit('Invalid rollback state')
PY
field() { python3 -c 'import json,sys; print(json.load(open(sys.argv[1],encoding="utf8"))[sys.argv[2]])' "$state" "$1"; }
project=$(field project)
project_directory=$(field projectDirectory)
image=$(field previousImageId)
docker image inspect "$image" >/dev/null
docker compose --project-directory "$project_directory" -p "$project" \
    -f "$directory/compose.previous.json" -f "$directory/rollback.image.yml" \
    up -d --no-deps --wait --wait-timeout 180 immich-server
echo 'Previous Immich server restored. Restore your pre-change Compose source too before any future stack redeploy.'
