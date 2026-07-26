import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const skillPath = resolve(packageRoot, 'skills/goal-writer/SKILL.md');
const skill = readFileSync(skillPath, 'utf8');
const packageJson = JSON.parse(readFileSync(resolve(packageRoot, 'package.json'), 'utf8')) as {
  pi?: { skills?: string[] };
  files?: string[];
};

describe('goal-writer skill contract', () => {
  it('has valid frontmatter and all six completion-contract parts', () => {
    expect(skill).toMatch(/^---\nname: goal-writer\ndescription: .+\nlicense: MIT\n---/);
    for (const part of [
      '**Outcome**',
      '**Verification surface**',
      '**Constraints**',
      '**Boundaries**',
      '**Iteration policy**',
      '**Blocked stop condition**',
    ]) {
      expect(skill).toContain(part);
    }
  });

  it('requires pasteable evidence-based current package syntax', () => {
    expect(skill).toContain('one pasteable `/goal` command');
    expect(skill).toContain('/goal --tokens 50k');
    expect(skill).toContain('/goal --time 30m');
    expect(skill).toContain('/goal --tokens 50k --time 1.5h');
    expect(skill).toContain('evidence-ledger checklist');
    expect(skill).toContain('proxy evidence');
    expect(skill).not.toContain('pi-goal-writer');
  });

  it('is exposed through package metadata and packed files', () => {
    expect(packageJson.pi?.skills).toContain('./skills');
    expect(packageJson.files).toContain('skills');
    const output = execFileSync('npm', ['pack', '--dry-run', '--json'], {
      cwd: packageRoot,
      encoding: 'utf8',
      timeout: 60_000,
    });
    const packed = JSON.parse(output) as Array<{ files: Array<{ path: string }> }>;
    expect(packed[0]?.files.map((file) => file.path)).toContain('skills/goal-writer/SKILL.md');
  }, 70_000);
});
