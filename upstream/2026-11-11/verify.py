import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile

def git(repo, *args):
    return subprocess.run(['git', '-C', str(repo), *args], check=True, capture_output=True, text=True).stdout.strip()

root = Path(__file__).resolve().parent
manifest = json.loads((root / 'manifest.json').read_text())
checkout = Path(sys.argv[1]).resolve()
if git(checkout, 'rev-parse', 'HEAD') != manifest['upstream_commit']:
    raise SystemExit('Checkout must be at upstream_commit from manifest.json')
for name, expected in manifest['checksums'].items():
    if hashlib.sha256((root / name).read_bytes()).hexdigest() != expected:
        raise SystemExit('Checksum mismatch: ' + name)
with tempfile.TemporaryDirectory(prefix='upstream-review-') as tmp:
    git(checkout, 'clone', '--quiet', '--shared', '--no-checkout', str(checkout), tmp)
    git(tmp, 'checkout', '--quiet', manifest['upstream_commit'])
    for name in manifest['series']:
        git(tmp, 'apply', '--check', '--index', str(root / name))
        git(tmp, 'apply', '--index', str(root / name))
    if git(tmp, 'write-tree') != manifest['result_tree']:
        raise SystemExit('Result tree mismatch')
print('Checksums and sequential patch replay verified; supplied checkout unchanged.')
