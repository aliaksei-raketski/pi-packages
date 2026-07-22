#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const UPSTREAM_REPO = 'https://github.com/nrwl/nx-ai-agents-config';
const DEFAULT_REF = '9609810013040356b2d93c0688a50d9078cdc35a';
const PACKAGE_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const TARGET_SKILLS_DIR = path.join(PACKAGE_ROOT, 'skills');
const OVERLAYS_DIR = path.join(PACKAGE_ROOT, 'overlays');
const EXCLUDED_SKILLS = ['monitor-ci'];
const OVERLAY_SKILLS = ['nx-developer', 'nx-docs'];
const STALE_PATTERNS = [
  /\bnx_docs\b/,
  /ci_information/,
  /update_self_healing_fix/,
  /mcp__/,
  /Nx MCP server/,
  /\bMCP\b/,
];

main().catch((error) => {
  console.error(`Fatal: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});

async function main() {
  const requestedRef = process.env.NX_AI_AGENTS_CONFIG_REF || DEFAULT_REF;
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nx-ai-agents-config-'));

  try {
    const checkout = await syncUpstreamSource(tempDir, requestedRef, requestedRef === DEFAULT_REF);
    await copyUpstreamSkills(checkout.repoDir);
    await removeExcludedSkills();
    await applyOverlays();
    await sanitizeVendoredSkills();
    await writeUpstreamMetadata(checkout);
    await validateNoUnsupportedReferences();

    console.log(`Synced Nx Agent Skills to ${checkout.resolvedRef} (${checkout.requestedRef}).`);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

async function syncUpstreamSource(tempDir, requestedRef, allowFallback = false) {
  const cloneDir = path.join(tempDir, 'nx-ai-agents-config');

  run('git', ['clone', '--depth', '1', '--filter=blob:none', UPSTREAM_REPO, cloneDir]);

  let resolvedRef;
  let usedFallback = false;

  try {
    run('git', ['-C', cloneDir, 'checkout', '--quiet', requestedRef]);
    resolvedRef = revParse(cloneDir, 'HEAD');
  } catch {
    try {
      run('git', ['-C', cloneDir, 'fetch', '--depth', '1', 'origin', requestedRef]);
      run('git', ['-C', cloneDir, 'checkout', '--quiet', 'FETCH_HEAD']);
      resolvedRef = revParse(cloneDir, 'HEAD');
      console.error(`Info: checked out requested ref ${requestedRef} after remote fetch.`);
    } catch {
      if (!allowFallback) {
        throw new Error(`Unable to resolve requested ref ${requestedRef}.`);
      }

      usedFallback = true;
      console.error(`Warning: could not resolve ref ${requestedRef}; falling back to origin/main.`);
      run('git', [
        '-C',
        cloneDir,
        'fetch',
        '--depth',
        '1',
        'origin',
        'main:refs/remotes/origin/main',
      ]);
      run('git', ['-C', cloneDir, 'checkout', '--quiet', 'origin/main']);
      resolvedRef = revParse(cloneDir, 'HEAD');
    }
  }

  return {
    repoDir: cloneDir,
    requestedRef,
    resolvedRef,
    usedFallback,
  };
}

async function copyUpstreamSkills(repoDir) {
  const sourceDir = path.join(repoDir, 'skills');

  if (!(await exists(sourceDir))) {
    throw new Error(`Expected upstream skills directory ${sourceDir} not found.`);
  }

  await fs.rm(TARGET_SKILLS_DIR, { recursive: true, force: true });
  await fs.mkdir(path.dirname(TARGET_SKILLS_DIR), { recursive: true });
  await fs.cp(sourceDir, TARGET_SKILLS_DIR, { recursive: true });
}

async function removeExcludedSkills() {
  for (const skill of EXCLUDED_SKILLS) {
    await fs.rm(path.join(TARGET_SKILLS_DIR, skill), { recursive: true, force: true });
  }
}

async function applyOverlays() {
  for (const skill of OVERLAY_SKILLS) {
    const sourceDir = path.join(OVERLAYS_DIR, skill);
    const targetDir = path.join(TARGET_SKILLS_DIR, skill);

    if (!(await exists(sourceDir))) {
      throw new Error(`Expected overlay directory ${sourceDir} not found.`);
    }

    await fs.rm(targetDir, { recursive: true, force: true });
    await fs.cp(sourceDir, targetDir, { recursive: true });
  }
}

async function sanitizeVendoredSkills() {
  const paths = await gatherFiles(TARGET_SKILLS_DIR);

  for (const filePath of paths) {
    if (!isTextResource(filePath)) {
      continue;
    }

    const original = await fs.readFile(filePath, 'utf8');
    const sanitized = original
      .replace(
        /BEFORE calling nx_docs/g,
        'BEFORE using the nx-docs skill or local Nx documentation helper',
      )
      .replace(/\bnx_docs\b/g, 'the nx-docs skill or local Nx documentation helper');

    if (sanitized !== original) {
      await fs.writeFile(filePath, sanitized, 'utf8');
    }
  }
}

async function writeUpstreamMetadata(meta) {
  const timestamp = new Date().toISOString();
  const content = `# Nx Agent Skills upstream sync metadata

Repository: ${UPSTREAM_REPO}
Synced at: ${timestamp}
Requested ref: ${meta.requestedRef}
Synced ref: ${meta.resolvedRef}
Fallback used: ${meta.usedFallback ? 'yes' : 'no'}
Excluded skills:

${EXCLUDED_SKILLS.map((skill) => `- ${skill}`).join('\n')}

Local overlay sources:

${OVERLAY_SKILLS.map((skill) => `- overlays/${skill}/`).join('\n')}
`;

  await fs.writeFile(path.join(TARGET_SKILLS_DIR, 'UPSTREAM.md'), content, 'utf8');
}

async function validateNoUnsupportedReferences() {
  for (const skill of EXCLUDED_SKILLS) {
    if (await exists(path.join(TARGET_SKILLS_DIR, skill))) {
      throw new Error(`Excluded skill still exists after sync: ${skill}`);
    }
  }

  const staleMatches = [];
  const paths = await gatherFiles(TARGET_SKILLS_DIR);

  for (const filePath of paths) {
    if (!isTextResource(filePath)) {
      continue;
    }

    const text = await fs.readFile(filePath, 'utf8');

    for (const pattern of STALE_PATTERNS) {
      if (pattern.test(text)) {
        staleMatches.push(`${path.relative(PACKAGE_ROOT, filePath)}: ${pattern.source}`);
        break;
      }
    }
  }

  if (staleMatches.length > 0) {
    throw new Error(`Found unsupported references in vendored skills:\n${staleMatches.join('\n')}`);
  }

  console.log('Validation passed: no unsupported references found.');
}

async function gatherFiles(root) {
  const results = [];
  const entries = await fs.readdir(root, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(root, entry.name);

    if (entry.isDirectory()) {
      results.push(...(await gatherFiles(fullPath)));
      continue;
    }

    if (entry.isFile()) {
      results.push(fullPath);
    }
  }

  return results;
}

function isTextResource(filePath) {
  return ['.md', '.mjs', '.json'].includes(path.extname(filePath).toLowerCase());
}

function revParse(repoDir, rev) {
  return run('git', ['-C', repoDir, 'rev-parse', rev]);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  if (result.error) {
    throw new Error(result.error.message);
  }

  if (result.status !== 0) {
    const stderr = String(result.stderr || '').trim();
    const prefix = stderr ? `: ${stderr}` : '';
    throw new Error(`${command} ${args.join(' ')} failed with code ${result.status}${prefix}`);
  }

  return String(result.stdout || '').trim();
}

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}
