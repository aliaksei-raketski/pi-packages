import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const script = new URL('../skills/taiga-ui-docs/scripts/taiga-ui-docs.mjs', import.meta.url);
const directories = [];
let server;
let sourceUrl;
let offline = false;

beforeAll(async () => {
  server = createServer((_request, response) => {
    if (offline) {
      response.writeHead(503, { 'content-type': 'text/plain' });
      response.end('offline');
      return;
    }
    response.writeHead(200, { 'content-type': 'text/plain' });
    response.end('# Taiga UI\n\n# Components\n\n# Button\nA button component.\n');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected TCP server address.');
  sourceUrl = `http://127.0.0.1:${address.port}/source`;
});

afterAll(async () => {
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  await Promise.all(
    directories.map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('Taiga UI documentation cache', () => {
  it('commits concurrent cache writes atomically and falls back offline', async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), 'taiga-docs-cache-'));
    directories.push(cacheDir);

    await Promise.all([runOverview(cacheDir, true), runOverview(cacheDir, true)]);

    const cache = JSON.parse(await readFile(join(cacheDir, 'meta.json'), 'utf8'));
    expect(cache.sourceUrl).toBe(sourceUrl);
    expect(cache.content).toContain('# Button');
    expect((await readdir(cacheDir)).filter((name) => name.endsWith('.tmp'))).toEqual([]);

    offline = true;
    const { stdout } = await runOverview(cacheDir, true);
    expect(JSON.parse(stdout).sourceUrl).toBe(sourceUrl);
  });
});

function runOverview(cacheDir, refresh) {
  const args = [script.pathname, 'overview', '--source-url', sourceUrl, '--cache-dir', cacheDir];
  if (refresh) args.push('--refresh');
  return execFileAsync(process.execPath, args, {
    env: {
      ...process.env,
      PI_DOCS_FETCH_TIMEOUT_MS: '1000',
      PI_DOCS_MAX_RESPONSE_BYTES: '100000',
    },
  });
}
