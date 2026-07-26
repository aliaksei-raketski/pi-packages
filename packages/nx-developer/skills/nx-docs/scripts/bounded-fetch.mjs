const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const SENSITIVE_REDIRECT_HEADERS = [
  'authorization',
  'cookie',
  'proxy-authorization',
  'x-algolia-api-key',
  'x-algolia-application-id',
];

export async function fetchBoundedText(url, init = {}, options = {}) {
  const timeoutMs = options.timeoutMs ?? 15_000;
  const maxBytes = options.maxBytes ?? 2 * 1024 * 1024;
  const maxRedirects = options.maxRedirects ?? 3;
  const acceptedContentTypes = options.acceptedContentTypes ?? [];
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  timeout.unref?.();

  try {
    let currentUrl = validateHttpUrl(url);
    let request = { ...init, headers: new Headers(init.headers), signal: controller.signal };

    for (let redirects = 0; ; redirects += 1) {
      const response = await fetch(currentUrl, { ...request, redirect: 'manual' });
      if (!REDIRECT_STATUSES.has(response.status)) {
        validateContentType(response, acceptedContentTypes);
        return {
          response,
          text: await readBoundedText(response, maxBytes),
          url: currentUrl.href,
        };
      }

      await response.body?.cancel();
      if (redirects >= maxRedirects) {
        throw new Error(`Too many redirects fetching ${url}.`);
      }
      const location = response.headers.get('location');
      if (!location) throw new Error(`Redirect from ${currentUrl.href} has no Location header.`);

      const nextUrl = validateHttpUrl(new URL(location, currentUrl));
      if (nextUrl.origin !== currentUrl.origin) {
        const headers = new Headers(request.headers);
        for (const header of SENSITIVE_REDIRECT_HEADERS) headers.delete(header);
        request = { ...request, headers };
      }
      if (response.status === 303) {
        const headers = new Headers(request.headers);
        headers.delete('content-length');
        headers.delete('content-type');
        request = { ...request, method: 'GET', body: undefined, headers };
      }
      currentUrl = nextUrl;
    }
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(`Request timed out after ${timeoutMs}ms while fetching ${url}.`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export async function readBoundedText(response, maxBytes) {
  const contentLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    await response.body?.cancel();
    throw new Error(`Response body exceeds ${maxBytes} bytes.`);
  }
  if (!response.body) return '';

  const reader = response.body.getReader();
  const chunks = [];
  let totalBytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel();
        throw new Error(`Response body exceeds ${maxBytes} bytes.`);
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, totalBytes).toString('utf8');
}

function validateContentType(response, acceptedContentTypes) {
  if (!response.ok || acceptedContentTypes.length === 0) return;
  const contentType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
  if (!contentType || !acceptedContentTypes.some((type) => contentType === type)) {
    throw new Error(
      `Unexpected Content-Type ${contentType || '(missing)'}; expected ${acceptedContentTypes.join(', ')}.`,
    );
  }
}

function validateHttpUrl(value) {
  let url;
  try {
    url = value instanceof URL ? value : new URL(value);
  } catch (error) {
    throw new Error(`Invalid URL: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`Unsupported URL protocol: ${url.protocol}`);
  }
  return url;
}
