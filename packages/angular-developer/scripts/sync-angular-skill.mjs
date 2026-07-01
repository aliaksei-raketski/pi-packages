#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const UPSTREAM_REPO = 'https://github.com/angular/skills';
const DEFAULT_REF = '28a90e30bba8cbc9d3a6aab56093e5b9b974bc9e';
const KNOWN_OVERLAY_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'overlays',
  'angular-developer',
);
const PKG_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const TARGET_SKILL_DIR = path.join(PKG_ROOT, 'skills', 'angular-developer');
const TARGET_UPSTREAM_FILE = path.join(TARGET_SKILL_DIR, 'UPSTREAM.md');
const TARGET_DATA_FILE = path.join(TARGET_SKILL_DIR, 'data', 'best-practices.md');
const STALE_PATTERNS = [
  /find_examples/i,
  /get_best_practices/i,
  /search_documentation/i,
  /references\/mcp\.md/i,
  /Angular MCP Server/i,
  /\bMCP\b/i,
];

main().catch((error) => {
  console.error(`Fatal: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});

async function main() {
  const requestedRef = process.env.ANGULAR_SKILLS_REF || DEFAULT_REF;
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'angular-skills-'));

  try {
    const checkout = await syncUpstreamSource(tempDir, requestedRef, requestedRef === DEFAULT_REF);
    await copySkillFromUpstream(checkout.repoDir);
    await applyOverlayAndMetadata(checkout, requestedRef);
    await sanitizeVendoredContent(TARGET_SKILL_DIR);

    await refreshBestPractices(TARGET_SKILL_DIR);
    await validateNoStaleMcpReferences(TARGET_SKILL_DIR);

    console.log(
      `Synced angular-developer skill to ${checkout.resolvedRef} (${checkout.requestedRef}).`,
    );
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

async function syncUpstreamSource(tempDir, requestedRef, allowFallback = false) {
  const cloneDir = path.join(tempDir, 'angular-skills');

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

async function copySkillFromUpstream(repoDir) {
  const sourceDir = path.join(repoDir, 'angular-developer');

  if (!(await exists(sourceDir))) {
    throw new Error(`Expected upstream directory ${sourceDir} not found.`);
  }

  await fs.rm(TARGET_SKILL_DIR, { recursive: true, force: true });
  await fs.mkdir(path.dirname(TARGET_SKILL_DIR), { recursive: true });
  await fs.cp(sourceDir, TARGET_SKILL_DIR, { recursive: true });
}

async function applyOverlayAndMetadata(meta) {
  const skillPath = path.join(TARGET_SKILL_DIR, 'SKILL.md');
  let skillContent = await fs.readFile(skillPath, 'utf8');

  const mcpToolingLine =
    '- **Angular MCP Server**: Available tools, configuration, and experimental features. Read [mcp.md](references/mcp.md)';
  const mcpToolingReplacement =
    '- **Angular documentation helpers**: Use local helper scripts for version-aware best practices and official angular.dev documentation search. Read [docs-helpers.md](references/docs-helpers.md)';

  if (!skillContent.includes(mcpToolingReplacement)) {
    if (!skillContent.includes(mcpToolingLine)) {
      throw new Error('Expected MCP tooling line was not found in upstream SKILL.md.');
    }

    skillContent = skillContent.replace(mcpToolingLine, mcpToolingReplacement);
  }

  const topRule =
    '4. When you need version-aware Angular best practices or official angular.dev documentation search, use the local helper scripts documented in [docs-helpers.md](references/docs-helpers.md).';

  if (!skillContent.includes(topRule)) {
    skillContent = skillContent.replace(
      '\n## Creating New Projects\n',
      `\n${topRule}\n\n## Creating New Projects\n`,
    );

    if (!skillContent.includes(topRule)) {
      throw new Error('Failed to insert local helper rule in SKILL.md.');
    }
  }

  await fs.writeFile(skillPath, skillContent, 'utf8');

  await removeIfExists(path.join(TARGET_SKILL_DIR, 'references', 'mcp.md'));

  const overlayReference = path.join(KNOWN_OVERLAY_PATH, 'references', 'docs-helpers.md');
  await ensureDir(path.join(TARGET_SKILL_DIR, 'references'));
  await fs.copyFile(overlayReference, path.join(TARGET_SKILL_DIR, 'references', 'docs-helpers.md'));

  const overlayScripts = path.join(KNOWN_OVERLAY_PATH, 'scripts');
  const targetScripts = path.join(TARGET_SKILL_DIR, 'scripts');
  await ensureDir(targetScripts);

  const scriptFiles = await fs.readdir(overlayScripts);
  for (const file of scriptFiles) {
    await fs.copyFile(path.join(overlayScripts, file), path.join(targetScripts, file));
  }

  const timestamp = new Date().toISOString();
  const sourceRef = `resolved ref ${meta.resolvedRef}`;

  const upstreamContent = `# Angular Developer upstream sync metadata

Repository: ${UPSTREAM_REPO}
Synced at: ${timestamp}
Requested ref: ${meta.requestedRef}
Synced ref: ${meta.resolvedRef}
Fallback used: ${meta.usedFallback ? 'yes' : 'no'}
Upstream source: ${sourceRef}
Local overlay source: overlays/angular-developer/
`;

  await fs.writeFile(TARGET_UPSTREAM_FILE, upstreamContent, 'utf8');
}

async function sanitizeVendoredContent(skillDir) {
  const e2eReference = path.join(skillDir, 'references', 'e2e-testing.md');
  if (await exists(e2eReference)) {
    const content = await fs.readFile(e2eReference, 'utf8');
    const sanitized = content.replace(/ng-devtools-mcp/g, 'ng-devtools');
    if (sanitized !== content) {
      await fs.writeFile(e2eReference, sanitized, 'utf8');
    }
  }
}

async function refreshBestPractices(skillDir) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'angular-core-'));
  try {
    const packResult = run('npm', ['pack', '@angular/core@latest', '--silent', '--json'], {
      cwd: tempDir,
    });
    const packEntries = JSON.parse(packResult);

    if (!Array.isArray(packEntries) || !packEntries.length) {
      throw new Error('npm pack output did not contain package metadata.');
    }

    const entry = packEntries[0];
    if (typeof entry.filename !== 'string') {
      throw new Error('npm pack output missing filename.');
    }

    const tarballPath = path.join(tempDir, entry.filename);
    const packageJsonText = run('tar', ['-xOf', tarballPath, 'package/package.json']);
    const packageJson = JSON.parse(packageJsonText);

    const bestPractices = packageJson?.angular?.bestPractices;
    if (
      !bestPractices ||
      bestPractices.format !== 'markdown' ||
      typeof bestPractices.path !== 'string'
    ) {
      throw new Error('Invalid @angular/core best-practices metadata.');
    }

    const normalizedPath = normalizePackagePath(bestPractices.path);
    const markdownText = run('tar', ['-xOf', tarballPath, `package/${normalizedPath}`]);

    await ensureDir(path.join(skillDir, 'data'));
    await fs.writeFile(TARGET_DATA_FILE, markdownText, 'utf8');
    console.log(
      `Updated data/best-practices.md from ${packageJson.version ?? 'latest @angular/core'}.`,
    );
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

function normalizePackagePath(rawPath) {
  const normalized = path.posix.normalize(rawPath.replace(/^\/+/, ''));

  if (
    normalized.startsWith('../') ||
    normalized.includes('/../') ||
    path.posix.isAbsolute(normalized)
  ) {
    throw new Error(`Unsafe best-practices path in package metadata: ${rawPath}`);
  }

  return normalized;
}

async function validateNoStaleMcpReferences(skillDir) {
  const staleMatches = [];

  const paths = await gatherFiles(skillDir);
  for (const filePath of paths) {
    const ext = path.extname(filePath).toLowerCase();
    if (!['.md', '.mjs', '.json'].includes(ext)) {
      continue;
    }

    const text = await fs.readFile(filePath, 'utf8');

    for (const pattern of STALE_PATTERNS) {
      if (pattern.test(text)) {
        staleMatches.push(`${path.relative(PKG_ROOT, filePath)}: ${pattern.source}`);
        break;
      }
    }
  }

  if (staleMatches.length > 0) {
    throw new Error(`Found stale MCP references in vendored skill:\n${staleMatches.join('\n')}`);
  }

  console.log('Validation passed: no stale MCP references found.');
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

function revParse(repoDir, rev) {
  return run('git', ['-C', repoDir, 'rev-parse', rev]);
}

function run(command, args, options = {}) {
  const { cwd } = options;
  const result = spawnSync(command, args, {
    cwd,
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

async function removeIfExists(target) {
  await fs.rm(target, { recursive: true, force: true });
}

async function ensureDir(target) {
  await fs.mkdir(target, { recursive: true });
}
