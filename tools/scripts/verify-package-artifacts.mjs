import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const workspaceRoot = join(dirname(fileURLToPath(import.meta.url)), '../..');
const packagesRoot = join(workspaceRoot, 'packages');

function collectRelativePackageRefs(value, refs = new Set()) {
  if (!value) {
    return refs;
  }

  if (typeof value === 'string') {
    if (value.startsWith('./') && !value.includes('*')) {
      refs.add(value.slice(2).replace(/\\/g, '/').replace(/\/$/, ''));
    }

    return refs;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      collectRelativePackageRefs(item, refs);
    }

    return refs;
  }

  if (typeof value === 'object') {
    for (const item of Object.values(value)) {
      collectRelativePackageRefs(item, refs);
    }
  }

  return refs;
}

function inferLicenseIdentifier(licenseText) {
  if (/Apache License\s+Version 2\.0/iu.test(licenseText)) return 'Apache-2.0';
  if (/^MIT License\s*$/imu.test(licenseText)) return 'MIT';
  return undefined;
}

function parsePackOutput(stdout, packageName) {
  const trimmed = stdout.trim();

  try {
    return JSON.parse(trimmed);
  } catch (error) {
    const jsonStart = trimmed.indexOf('[');
    const jsonEnd = trimmed.lastIndexOf(']');

    if (jsonStart >= 0 && jsonEnd > jsonStart) {
      return JSON.parse(trimmed.slice(jsonStart, jsonEnd + 1));
    }

    throw new Error(`Failed to parse npm pack JSON for ${packageName}: ${error.message}`);
  }
}

const failures = [];
let checked = 0;

for (const entry of readdirSync(packagesRoot, { withFileTypes: true })) {
  if (!entry.isDirectory()) {
    continue;
  }

  const packageDir = join(packagesRoot, entry.name);
  const packageJsonPath = join(packageDir, 'package.json');

  if (!existsSync(packageJsonPath)) {
    continue;
  }

  let packageJson;
  try {
    packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
  } catch (error) {
    failures.push({
      packageName: entry.name,
      message: `invalid package.json: ${error instanceof Error ? error.message : String(error)}`,
    });
    continue;
  }

  if (packageJson.private) {
    continue;
  }

  checked += 1;

  const referencedArtifacts = new Set();
  collectRelativePackageRefs(packageJson.main, referencedArtifacts);
  collectRelativePackageRefs(packageJson.module, referencedArtifacts);
  collectRelativePackageRefs(packageJson.types, referencedArtifacts);
  collectRelativePackageRefs(packageJson.bin, referencedArtifacts);
  collectRelativePackageRefs(packageJson.exports, referencedArtifacts);

  const pack = spawnSync('npm', ['pack', '--dry-run', '--json'], {
    cwd: packageDir,
    encoding: 'utf8',
  });

  if (pack.status !== 0) {
    failures.push({
      packageName: packageJson.name ?? entry.name,
      message: `npm pack --dry-run failed:\n${pack.stderr || pack.stdout}`,
    });
    continue;
  }

  const packOutput = parsePackOutput(pack.stdout, packageJson.name ?? entry.name);
  const packedFiles = new Set((packOutput[0]?.files ?? []).map((file) => file.path));
  const missing = [...referencedArtifacts].filter((artifact) => !packedFiles.has(artifact));

  if (missing.length > 0) {
    failures.push({
      packageName: packageJson.name ?? entry.name,
      message: `tarball is missing package.json artifact reference(s): ${missing.join(', ')}`,
    });
  }

  const licensePath = join(packageDir, 'LICENSE');
  if (packedFiles.has('LICENSE') && existsSync(licensePath)) {
    const shippedLicense = inferLicenseIdentifier(readFileSync(licensePath, 'utf8'));
    if (!shippedLicense) {
      failures.push({
        packageName: packageJson.name ?? entry.name,
        message: 'could not identify the SPDX license represented by LICENSE',
      });
    } else if (packageJson.license !== shippedLicense) {
      failures.push({
        packageName: packageJson.name ?? entry.name,
        message: `package.json license ${packageJson.license ?? '(missing)'} does not match shipped ${shippedLicense} LICENSE`,
      });
    }

    if (shippedLicense === 'Apache-2.0' && !packedFiles.has('NOTICE')) {
      failures.push({
        packageName: packageJson.name ?? entry.name,
        message: 'Apache-2.0 package tarball is missing NOTICE attribution',
      });
    }
  }
}

if (failures.length > 0) {
  for (const failure of failures) {
    process.stderr.write(
      `::error title=${failure.packageName}::${failure.message.replaceAll('\n', '%0A')}\n`,
    );
    process.stderr.write(`${failure.packageName}: ${failure.message}\n`);
  }

  process.exit(1);
}

process.stdout.write(`Verified publish artifacts for ${checked} package(s).\n`);
