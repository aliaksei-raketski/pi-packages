import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const script = new URL(
  '../skills/angular-developer/scripts/search-documentation.mjs',
  import.meta.url,
);
let server;
let endpoint;

beforeAll(async () => {
  server = createServer((request, response) => {
    if (request.url === '/html') {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end('<html><main>unterminated');
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end('{not-json');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected TCP server address.');
  endpoint = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
});

describe('Angular documentation search network validation', () => {
  it('reports malformed JSON', async () => {
    await expect(runSearch(endpoint)).rejects.toMatchObject({
      stderr: expect.stringContaining('malformed JSON'),
    });
  });

  it('rejects an HTML response where JSON is required', async () => {
    await expect(runSearch(`${endpoint}/html`)).rejects.toMatchObject({
      stderr: expect.stringContaining('Unexpected Content-Type text/html'),
    });
  });
});

function runSearch(url) {
  return execFileAsync(process.execPath, [script.pathname, '--version', '22', 'signals'], {
    env: { ...process.env, PI_ANGULAR_DOCS_ENDPOINT: url },
  });
}
