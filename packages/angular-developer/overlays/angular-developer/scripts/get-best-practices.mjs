#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';

const MAX_BEST_PRACTICES_BYTES = 1_048_576;
const BUILTIN_FALLBACK = `Bundled Angular best-practices guidance is unavailable in this workspace.\n\nTo get version-aware guidance, run this script from an Angular workspace with @angular/core installed and accessible via Node resolution.`;

main().catch((error) => {
  console.error(`Fatal: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});

async function main() {
  const parsed = parseArguments(process.argv.slice(2));

  if (parsed.help) {
    printHelp();
    process.exit(0);
  }

  if (parsed.errors.length > 0) {
    console.error(parsed.errors.join('\n'));
    console.error('Use --help for usage.');
    process.exit(2);
  }

  const workspacePath = parsed.workspacePath || null;
  const source = await resolveSource(workspacePath);

  const payload = {
    source: source.source,
    content: source.content,
  };

  if (parsed.json) {
    const json = parsed.pretty ? JSON.stringify(payload, null, 2) : JSON.stringify(payload);
    process.stdout.write(json);
    return;
  }

  console.log(`<!-- Source: ${payload.source} -->`);
  console.log('');
  console.log((payload.content || '').trimEnd());
}

function parseArguments(argv) {
  const result = {
    workspacePath: null,
    json: false,
    pretty: false,
    help: false,
    errors: [],
  };

  const positional = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }

    if (arg === '--json') {
      result.json = true;
      continue;
    }

    if (arg === '--pretty') {
      result.pretty = true;
      continue;
    }

    if (arg === '--help') {
      result.help = true;
      continue;
    }

    if (arg.startsWith('--')) {
      result.errors.push(`Unknown option: ${arg}`);
      continue;
    }
  }

  if (positional.length > 0) {
    result.workspacePath = positional[0];
  }

  return result;
}

async function resolveSource(workspacePath) {
  if (workspacePath) {
    try {
      const workspaceRoot = await resolveWorkspaceFromInput(path.resolve(workspacePath));

      if (!workspaceRoot) {
        console.error(
          `Warning: could not locate an Angular workspace at "${workspacePath}". Falling back to bundled best-practices.md.`,
        );
      } else {
        try {
          const source = await loadWorkspaceBestPractices(workspaceRoot);
          return source;
        } catch (error) {
          console.error(
            `Warning: failed to read workspace-specific best practices from ${workspaceRoot}: ${error instanceof Error ? error.message : String(error)}. Falling back to bundled best-practices.md.`,
          );
        }
      }
    } catch (error) {
      console.error(
        `Warning: failed to locate workspace from ${workspacePath}: ${error instanceof Error ? error.message : String(error)}. Falling back to bundled best-practices.md.`,
      );
    }
  } else {
    const workspaceRoot = await findWorkspaceFromCwd(process.cwd());

    if (workspaceRoot) {
      try {
        const source = await loadWorkspaceBestPractices(workspaceRoot);
        return source;
      } catch (error) {
        console.error(
          `Warning: failed to read workspace-specific best practices from ${workspaceRoot}: ${error instanceof Error ? error.message : String(error)}. Falling back to bundled best-practices.md.`,
        );
      }
    }
  }

  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const fallbackPath = path.join(path.dirname(scriptDir), 'data', 'best-practices.md');
  try {
    const content = await fs.readFile(fallbackPath, 'utf8');
    return { source: 'bundled best-practices fallback', content };
  } catch (error) {
    console.error(
      `Warning: bundled fallback not found at ${fallbackPath}: ${error instanceof Error ? error.message : String(error)}.`,
    );
    return { source: 'built-in fallback', content: BUILTIN_FALLBACK };
  }
}

async function loadWorkspaceBestPractices(workspaceRoot) {
  const packageJsonPath = path.join(workspaceRoot, 'package.json');
  const probePath = path.join(workspaceRoot, '.pi-scripts-probe.mjs');
  const requireBase = (await fileExists(packageJsonPath)) ? packageJsonPath : probePath;
  const require = createRequire(pathToFileURL(requireBase).href);

  const corePackageJsonPath = require.resolve('@angular/core/package.json');
  const corePackageJson = JSON.parse(await fs.readFile(corePackageJsonPath, 'utf8'));

  const bestPracticesMeta = corePackageJson.angular?.bestPractices;

  if (
    !bestPracticesMeta ||
    bestPracticesMeta.format !== 'markdown' ||
    typeof bestPracticesMeta.path !== 'string'
  ) {
    throw new Error('Unsupported Angular best-practices metadata format.');
  }

  const packageDirectory = path.dirname(corePackageJsonPath);
  const bestPracticesPath = path.resolve(packageDirectory, bestPracticesMeta.path);

  const rel = path.relative(packageDirectory, bestPracticesPath);
  if (rel.startsWith('..') || rel.startsWith(path.sep) || path.isAbsolute(bestPracticesMeta.path)) {
    throw new Error('Best-practices path does not stay within @angular/core package directory.');
  }

  const stats = await fs.stat(bestPracticesPath);
  if (!stats.isFile()) {
    throw new Error(`Best-practices path is not a file: ${bestPracticesPath}`);
  }

  if (stats.size > MAX_BEST_PRACTICES_BYTES) {
    throw new Error(`Best-practices file is too large (${stats.size} bytes).`);
  }

  const content = await fs.readFile(bestPracticesPath, 'utf8');
  if (!content.trim()) {
    throw new Error(`Best-practices file is empty: ${bestPracticesPath}`);
  }

  return {
    source: `framework version ${corePackageJson.version}`,
    content,
  };
}

async function resolveWorkspaceFromInput(inputPath) {
  const stats = await fs.stat(inputPath);

  if (stats.isFile()) {
    if (path.basename(inputPath) === 'angular.json') {
      return path.dirname(inputPath);
    }

    throw new Error('Provided file path is not angular.json.');
  }

  if (stats.isDirectory()) {
    const candidate = path.join(inputPath, 'angular.json');
    if (await isFile(candidate)) {
      return inputPath;
    }
    throw new Error('No angular.json found at the provided directory.');
  }

  throw new Error('Provided workspace path is neither a file nor directory.');
}

async function findWorkspaceFromCwd(startDir) {
  let current = path.resolve(startDir);

  for (;;) {
    const candidate = path.join(current, 'angular.json');
    if (await isFile(candidate)) {
      return current;
    }

    const parent = path.dirname(current);
    if (parent === current) {
      return null;
    }

    current = parent;
  }
}

async function isFile(candidate) {
  try {
    return (await fs.stat(candidate)).isFile();
  } catch {
    return false;
  }
}

async function fileExists(candidate) {
  try {
    await fs.access(candidate);
    return true;
  } catch {
    return false;
  }
}

function printHelp() {
  console.log(`
Usage:
  node scripts/get-best-practices.mjs [workspacePath] [--json] [--pretty] [--help]

Arguments:
  workspacePath   Optional Angular workspace directory or angular.json file path.

Options:
  --json        Output JSON only.
  --pretty      Pretty-print JSON output.
  --help        Show this help.

Output:
  Default: markdown with a source comment on top.
  JSON:  { source, content }
`);
}
