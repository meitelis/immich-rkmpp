#!/bin/sh
# Update an existing Immich server only; keep its database, media and settings.
set -eu
umask 077
usage() {
    echo 'Usage: sh scripts/deploy.sh --compose-file FILE --rollback-compose-file PRE_CHANGE_BACKUP --project NAME [--backup-dir DIR] [--project-directory DIR] [--dry-run]'
}
fail() { echo "Error: $*" >&2; exit 1; }
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
compose_file= previous_file= project= project_directory=
dry_run=0
backup_dir=$PWD/immich-rkmpp-backups
while [ "$#" -gt 0 ]; do
    case "$1" in
        --compose-file|--rollback-compose-file|--project|--backup-dir|--project-directory)
            [ "$#" -ge 2 ] || fail "Missing value for $1"
            case "$1" in
                --compose-file) compose_file=$2 ;; --rollback-compose-file) previous_file=$2 ;;
                --project) project=$2 ;; --backup-dir) backup_dir=$2 ;; --project-directory) project_directory=$2 ;;
            esac
            shift 2 ;;
        --dry-run) dry_run=1; shift ;;
        -h|--help) usage; exit 0 ;;
        *) usage >&2; fail "Unknown argument: $1" ;;
    esac
done
[ -f "$compose_file" ] && [ -f "$previous_file" ] && [ -n "$project" ] || { usage >&2; exit 1; }
case "$project" in -*|*[!a-z0-9_-]*) fail 'Invalid existing Compose project name' ;; esac
command -v python3 >/dev/null || fail 'Python 3 is required'
compose_file=$(python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$compose_file")
previous_file=$(python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$previous_file")
[ "$compose_file" != "$previous_file" ] || fail 'Provide a separate pre-change Compose backup'
[ -n "$project_directory" ] || project_directory=$(dirname -- "$compose_file")
project_directory=$(CDPATH= cd -- "$project_directory" && pwd -P)
compose() { docker compose --project-directory "$project_directory" -p "$project" -f "$compose_file" "$@"; }
engine=$(compose ps -q immich-server)
case "$engine" in ''|-*|*[!A-Za-z0-9_.-]*) fail 'Expected exactly one existing immich-server container' ;; esac
old_version=$(docker inspect --format '{{index .Config.Labels "cc.immich-rkmpp.upstream-version"}}' "$engine")
if [ "$old_version" = '<no value>' ] || [ -z "$old_version" ]; then
    old_version=$(docker inspect --format '{{index .Config.Labels "org.opencontainers.image.version"}}' "$engine")
fi
case "$old_version" in 3.3.5|v3.3.5|3.3.5-rkmpp-*) ;; *) fail "Existing server is $old_version; this package supports only 3.3.5" ;; esac
old_image=$(docker inspect --format '{{.Image}}' "$engine")
mkdir -p -- "$backup_dir"
backup_dir=$(CDPATH= cd -- "$backup_dir" && pwd -P)
run=$(mktemp -d "$backup_dir/deploy-$(date -u +%Y%m%dT%H%M%SZ).XXXXXXXX")
# Resolved configs contain credentials; their private directory is retained for
# rollback and must never be committed or published.
compose config --format json > "$run/compose.candidate.json"
docker compose --project-directory "$project_directory" -p "$project" -f "$previous_file" config --format json > "$run/compose.previous.json"
image=$(python3 - "$run/compose.candidate.json" <<'PY'
import json,re,sys
with open(sys.argv[1], encoding='utf8') as handle:
    service = json.load(handle).get('services', {}).get('immich-server', {})
image = service.get('image', '')
if not re.fullmatch(r'[A-Za-z0-9_./:@-]+', image) or image.startswith('-'):
    raise SystemExit('Missing or invalid immich-server image')
protected_paths = ['/usr/src/app/server/dist', '/build/www']
for volume in service.get('volumes', []):
    target = str(volume.get('target', '')).rstrip('/') or '/'
    if target == '/' or any(target == directory or target.startswith(directory + '/') or directory.startswith(target + '/') for directory in protected_paths):
        raise SystemExit('Remove the old compiled-code/web bind mount before deploying: ' + target)
print(image)
PY
)
version=$(docker image inspect --format '{{index .Config.Labels "cc.immich-rkmpp.upstream-version"}}' "$image")
[ "$version" = 3.3.5 ] || fail 'The configured image is not a built Immich RKMPP 3.3.5 release'
[ "$(docker image inspect --format '{{.Architecture}}' "$image")" = arm64 ] || fail 'The deployment image must be built for ARM64'
printf 'services:\n  immich-server:\n    image: "%s"\n    pull_policy: never\n' "$old_image" > "$run/rollback.image.yml"
python3 - "$run" "$project" "$project_directory" "$old_image" "$image" "$compose_file" <<'PY'
import datetime,json,os,sys
directory,project,project_directory,previous_image,image,source_compose = sys.argv[1:]
state = {
    'schemaVersion': 1, 'createdAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
    'project': project, 'projectDirectory': project_directory,
    'previousImageId': previous_image, 'image': image, 'sourceCompose': source_compose,
}
filename = os.path.join(directory, 'state.json')
with open(filename, 'w', encoding='utf8') as handle:
    json.dump(state, handle, indent=2)
    handle.write('\n')
os.chmod(filename, 0o600)
PY
printf 'Rollback state: %s\n' "$run"
if [ "$dry_run" = 1 ]; then
    echo 'Preflight passed. No containers were recreated; private rollback state is retained.'
    exit 0
fi
if ! compose up -d --no-deps --wait --wait-timeout 180 immich-server; then
    echo 'Deployment failed; restoring the previous server image and configuration.' >&2
    sh "$script_dir/rollback.sh" --state-dir "$run" || echo "Automatic rollback failed; inspect $run before retrying." >&2
    exit 1
fi
printf 'Immich RKMPP is healthy. Image: %s\nRollback state: %s\n' "$image" "$run"
