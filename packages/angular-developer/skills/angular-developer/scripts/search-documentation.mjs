#!/usr/bin/env node

const APP_ID = 'L1XWT2UJ7F';
const API_KEY = 'dfca7ed184db27927a512e5c6668b968';
const ENDPOINT = `https://${APP_ID}-dsn.algolia.net/1/indexes/*/queries`;

const SEARCH_ATTRIBUTES = [
  'hierarchy.lvl0',
  'hierarchy.lvl1',
  'hierarchy.lvl2',
  'hierarchy.lvl3',
  'hierarchy.lvl4',
  'hierarchy.lvl5',
  'hierarchy.lvl6',
  'content',
  'type',
  'url',
];

const MIN_VERSION = 17;
const KNOWN_LATEST_VERSION = 22;
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 20;
const CONTENT_MAX_LENGTH = 20_000;

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

  const query = parsed.query.trim();
  if (!query) {
    console.error('Error: query is required.');
    console.error('Use --help for usage.');
    process.exit(2);
  }

  const version = parsed.version ?? KNOWN_LATEST_VERSION;
  const result = await searchWithFallback(query, version, parsed.limit, parsed.includeTopContent);

  const payload = {
    searchedVersion: result.version,
    results: result.results,
  };

  if (parsed.json) {
    const output = parsed.pretty ? JSON.stringify(payload, null, 2) : JSON.stringify(payload);
    process.stdout.write(output);
    return;
  }

  printMarkdown(query, result.version, result.results);
}

function parseArguments(argv) {
  const parsed = {
    queryParts: [],
    version: null,
    limit: DEFAULT_LIMIT,
    includeTopContent: false,
    json: false,
    pretty: false,
    help: false,
    errors: [],
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (!arg.startsWith('--')) {
      parsed.queryParts.push(arg);
      continue;
    }

    if (arg === '--include-top-content') {
      parsed.includeTopContent = true;
      continue;
    }

    if (arg === '--json') {
      parsed.json = true;
      continue;
    }

    if (arg === '--pretty') {
      parsed.pretty = true;
      continue;
    }

    if (arg === '--help') {
      parsed.help = true;
      continue;
    }

    if (arg === '--version' || arg === '--limit') {
      const value = argv[i + 1];
      if (!value || value.startsWith('--')) {
        parsed.errors.push(`Option ${arg} requires a value.`);
        continue;
      }

      if (arg === '--version') {
        const parsedVersion = Number.parseInt(value, 10);
        if (!Number.isInteger(parsedVersion) || parsedVersion < MIN_VERSION) {
          parsed.errors.push(`Option --version must be an integer >= ${MIN_VERSION}.`);
        } else {
          parsed.version = parsedVersion;
        }
      }

      if (arg === '--limit') {
        const parsedLimit = Number.parseInt(value, 10);
        if (!Number.isInteger(parsedLimit) || parsedLimit < 1) {
          parsed.errors.push('Option --limit must be an integer >= 1.');
        } else {
          parsed.limit = clampLimit(parsedLimit);
        }
      }

      i += 1;
      continue;
    }

    if (arg.startsWith('--version=')) {
      const raw = arg.slice('--version='.length);
      const parsedVersion = Number.parseInt(raw, 10);
      if (!Number.isInteger(parsedVersion) || parsedVersion < MIN_VERSION) {
        parsed.errors.push(`Option --version must be an integer >= ${MIN_VERSION}.`);
      } else {
        parsed.version = parsedVersion;
      }
      continue;
    }

    if (arg.startsWith('--limit=')) {
      const raw = arg.slice('--limit='.length);
      const parsedLimit = Number.parseInt(raw, 10);
      if (!Number.isInteger(parsedLimit) || parsedLimit < 1) {
        parsed.errors.push('Option --limit must be an integer >= 1.');
      } else {
        parsed.limit = clampLimit(parsedLimit);
      }
      continue;
    }

    parsed.errors.push(`Unknown option: ${arg}`);
  }

  return {
    ...parsed,
    query: parsed.queryParts.join(' '),
  };
}

async function searchWithFallback(query, requestedVersion, limit, includeTopContent) {
  try {
    const result = await queryDocs(requestedVersion, query, limit);

    if (includeTopContent) {
      await enrichTopResultContent(result.hits);
    }

    return { version: requestedVersion, results: result.hits };
  } catch (error) {
    if (requestedVersion > KNOWN_LATEST_VERSION) {
      console.error(
        `Warning: angular_v${requestedVersion} search unavailable (${error instanceof Error ? error.message : String(error)}). Falling back to angular_v${KNOWN_LATEST_VERSION}.`,
      );
      const fallback = await queryDocs(KNOWN_LATEST_VERSION, query, limit);

      if (includeTopContent) {
        await enrichTopResultContent(fallback.hits);
      }

      return { version: KNOWN_LATEST_VERSION, results: fallback.hits };
    }

    throw error;
  }
}

async function queryDocs(version, query, limit) {
  const params = new URLSearchParams({
    query,
    attributesToRetrieve: JSON.stringify(SEARCH_ATTRIBUTES),
    hitsPerPage: String(clampLimit(limit)),
  }).toString();

  const response = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Algolia-Application-Id': APP_ID,
      'X-Algolia-API-Key': API_KEY,
    },
    body: JSON.stringify({
      requests: [
        {
          indexName: `angular_v${version}`,
          params,
        },
      ],
    }),
  });

  if (!response.ok) {
    const message = response.statusText || String(response.status);
    const responseText = await safeText(response);
    throw new Error(`HTTP ${response.status} ${message}: ${responseText}`);
  }

  const data = await response.json();
  const result = data?.results?.[0];

  if (!result || !Array.isArray(result.hits)) {
    throw new Error(`Algolia response missing hits for angular_v${version}.`);
  }

  return {
    hits: result.hits.map((hit) => formatHit(hit)),
  };
}

function formatHit(hit) {
  const hierarchy = hit?.hierarchy ?? {};
  const levels = [
    hierarchy.lvl0,
    hierarchy.lvl1,
    hierarchy.lvl2,
    hierarchy.lvl3,
    hierarchy.lvl4,
    hierarchy.lvl5,
    hierarchy.lvl6,
  ].map((value) => (typeof value === 'string' ? value.trim() : ''));

  let title = 'Result';
  let titleIndex = -1;

  for (let i = levels.length - 1; i >= 0; i--) {
    if (levels[i]) {
      title = levels[i];
      titleIndex = i;
      break;
    }
  }

  const breadcrumb = levels.slice(0, titleIndex).filter(Boolean).join(' > ');

  return {
    title,
    breadcrumb,
    url: typeof hit?.url === 'string' ? hit.url : '',
  };
}

async function enrichTopResultContent(results) {
  if (!results || !results.length) {
    return;
  }

  const top = results[0];
  if (!top.url) {
    return;
  }

  let url;
  try {
    url = new URL(top.url);
  } catch {
    return;
  }

  if (url.host !== 'angular.dev' && !url.host.endsWith('.angular.dev')) {
    return;
  }

  try {
    const response = await fetch(top.url);
    if (!response.ok) {
      throw new Error(`${response.status} ${response.statusText}`);
    }

    const html = await response.text();
    top.content = extractMainContent(html);
  } catch (error) {
    console.error(
      `Warning: failed to fetch top result page ${top.url}: ${error instanceof Error ? error.message : String(error)}.`,
    );
  }
}

function extractMainContent(html) {
  const mainMatch = html.match(/<main[\s\S]*?>([\s\S]*?)<\/main>/i);
  const source = mainMatch ? mainMatch[1] : html;

  const withNoScript = source
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ');

  const stripped = withNoScript
    .replace(/<[^>]*>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();

  if (stripped.length > CONTENT_MAX_LENGTH) {
    return `${stripped.slice(0, CONTENT_MAX_LENGTH)}...`;
  }

  return stripped;
}

function clampLimit(value) {
  if (!Number.isInteger(value) || value < 1) {
    return DEFAULT_LIMIT;
  }

  if (value > MAX_LIMIT) {
    return MAX_LIMIT;
  }

  return value;
}

async function safeText(response) {
  try {
    return await response.text();
  } catch {
    return '';
  }
}

function printMarkdown(query, version, results) {
  console.log(`# Angular documentation search: ${query}`);
  console.log(`Version: angular_v${version}`);
  console.log('');

  if (!results.length) {
    console.log('No results found.');
    return;
  }

  for (const item of results) {
    console.log(`## ${item.title}`);
    if (item.breadcrumb) {
      console.log(`Breadcrumb: ${item.breadcrumb}`);
    }
    if (item.url) {
      console.log(item.url);
    }
    if (item.content) {
      console.log('');
      console.log(item.content);
    }
    console.log('');
  }
}

function printHelp() {
  console.log(`
Usage:
  node scripts/search-documentation.mjs "query terms" [--version 22] [--limit 10] [--include-top-content] [--json] [--pretty]

Options:
  --version <major>         Docs major version (minimum ${MIN_VERSION}, default ${KNOWN_LATEST_VERSION}).
  --limit <n>               Max number of results (default 10, clamped to 1-20).
  --include-top-content     Fetch and include the top angular.dev page content.
  --json                    Output JSON only.
  --pretty                  Pretty-print JSON output.
  --help                    Show this help.

Examples:
  node scripts/search-documentation.mjs "signals resource" --version 22 --limit 5
  node scripts/search-documentation.mjs "signal forms validation" --version 22 --include-top-content
`);
}
