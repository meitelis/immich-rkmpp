#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { cp, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const upstream = JSON.parse(await readFile(path.join(root, 'upstream.json'), 'utf8'));
if (!/@sha256:[0-9a-f]{64}$/.test(upstream.runtimeImage) || !/^[0-9a-f]{40}$/.test(upstream.commit)) {
  throw new Error('Invalid pinned runtime digest or source commit');
}
const target = path.resolve(process.argv[2] ?? path.join(root, 'work/upstream'));
const dockerfile = await readFile(path.join(root, 'Dockerfile.rkmpp'), 'utf8');
if (!dockerfile.includes('FROM ' + upstream.runtimeImage + ' AS rkmpp') ||
    !dockerfile.includes('cc.immich-rkmpp.upstream-revision="' + upstream.commit + '"')) {
  throw new Error('Dockerfile and upstream.json pins differ; update and review them together');
}

function git(args, cwd) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (result.status !== 0) throw new Error(result.stderr || 'git ' + args[0] + ' failed');
  return result.stdout.trim();
}
if (existsSync(target)) throw new Error('Destination already exists: ' + target + '. Choose a new destination to preserve existing work.');
await mkdir(path.dirname(target), { recursive: true });
git(['clone', '--depth', '1', '--branch', upstream.tag, upstream.repository, target]);
if (git(['rev-parse', 'HEAD'], target) !== upstream.commit) throw new Error('Upstream tag moved; expected pinned commit');
const manifest = JSON.parse(await readFile(path.join(target, 'package.json'), 'utf8'));
if (manifest.version !== upstream.version || manifest.packageManager !== 'pnpm@11.27.1') {
  throw new Error('Unexpected upstream version or package manager');
}
await cp(path.join(root, 'overlays'), target, { recursive: true });
await cp(path.join(root, 'Dockerfile.rkmpp'), path.join(target, 'Dockerfile.rkmpp'));
await cp(path.join(root, 'NOTICE'), path.join(target, 'RKMPP_NOTICE'));
await cp(path.join(root, 'LICENSES'), path.join(target, 'RKMPP_LICENSES'), { recursive: true });
console.log('Prepared Immich ' + upstream.version + ' at ' + target);
console.log('Build: docker build -f "' + path.join(target, 'Dockerfile.rkmpp') +
  '" -t local/immich-server:rkmpp-' + upstream.version + '-r4-memories "' + target + '"');
