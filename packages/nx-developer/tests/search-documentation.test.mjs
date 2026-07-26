import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { fetchBoundedText } from '../skills/nx-docs/scripts/bounded-fetch.mjs';

const execFileAsync = promisify(execFile);
const script = new URL('../skills/nx-docs/scripts/search-documentation.mjs', import.meta.url);
let server;
let origin;

beforeAll(async () => {
  server = createServer((request, response) => {
    if (request.url === '/slow') {
      setTimeout(() => {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end('{}');
      }, 200);
      return;
    }
    if (request.url === '/large') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('x'.repeat(4_096));
      return;
    }
    if (request.url === '/redirect') {
      response.writeHead(302, { location: '/valid' });
      response.end();
      return;
    }
    if (request.url === '/valid') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{"ok":true}');
      return;
    }
    if (request.url === '/malformed-json') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{not-json');
      return;
    }
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end('<html><main>unterminated');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected TCP server address.');
  origin = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
});

describe('bounded documentation fetches', () => {
  it('enforces a request deadline', async () => {
    await expect(
      fetchBoundedText(`${origin}/slow`, {}, { timeoutMs: 20, maxBytes: 1_024 }),
    ).rejects.toThrow(/timed out/u);
  });

  it('rejects a streamed body beyond the byte cap', async () => {
    await expect(
      fetchBoundedText(`${origin}/large`, {}, { timeoutMs: 1_000, maxBytes: 100 }),
    ).rejects.toThrow(/exceeds 100 bytes/u);
  });

  it('follows bounded redirects and validates the final content type', async () => {
    const result = await fetchBoundedText(
      `${origin}/redirect`,
      {},
      {
        timeoutMs: 1_000,
        maxBytes: 1_024,
        maxRedirects: 1,
        acceptedContentTypes: ['application/json'],
      },
    );
    expect(result.text).toBe('{"ok":true}');

    await expect(
      fetchBoundedText(
        `${origin}/malformed-html`,
        {},
        { acceptedContentTypes: ['application/json'] },
      ),
    ).rejects.toThrow(/Unexpected Content-Type text\/html/u);
  });

  it('reports malformed JSON from the Nx endpoint', async () => {
    await expect(
      execFileAsync(process.execPath, [script.pathname, 'test query'], {
        env: { ...process.env, PI_NX_DOCS_ENDPOINT: `${origin}/malformed-json` },
      }),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining('malformed JSON'),
    });
  });
});
