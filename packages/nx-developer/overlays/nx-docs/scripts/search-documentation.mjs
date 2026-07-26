#!/usr/bin/env node

import { fetchBoundedText } from './bounded-fetch.mjs';

const ENDPOINT = process.env.PI_NX_DOCS_ENDPOINT ?? 'https://nx.dev/api/query-ai-embeddings';
const DEFAULT_LIMIT = 4;
const MAX_LIMIT = 15;
const MAX_TOTAL_CONTENT_LENGTH = 20_000;
const MAX_SECTION_CONTENT_LENGTH = 8_000;
const TRUNCATION_MARKER = '\n\n… [truncated]';
const FETCH_TIMEOUT_MS = positiveEnvironmentInteger('PI_DOCS_FETCH_TIMEOUT_MS', 15_000);
const MAX_RESPONSE_BYTES = positiveEnvironmentInteger(
  'PI_DOCS_MAX_RESPONSE_BYTES',
  2 * 1024 * 1024,
);

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

  const results = await searchDocumentation(query, parsed.limit);

  if (parsed.json) {
    const payload = { query, results };
    const output = parsed.pretty ? JSON.stringify(payload, null, 2) : JSON.stringify(payload);
    process.stdout.write(`${output}\n`);
    return;
  }

  printMarkdown(query, results);
}

function parseArguments(argv) {
  const parsed = {
    queryParts: [],
    limit: DEFAULT_LIMIT,
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

    if (arg === '--limit') {
      const value = argv[i + 1];
      if (!value || value.startsWith('--')) {
        parsed.errors.push('Option --limit requires a value.');
      } else {
        setLimit(parsed, value);
        i += 1;
      }
      continue;
    }

    if (arg.startsWith('--limit=')) {
      setLimit(parsed, arg.slice('--limit='.length));
      continue;
    }

    parsed.errors.push(`Unknown option: ${arg}`);
  }

  return {
    ...parsed,
    query: parsed.queryParts.join(' '),
  };
}

function setLimit(parsed, rawValue) {
  const value = Number.parseInt(rawValue, 10);
  if (!Number.isInteger(value) || value < 1) {
    parsed.errors.push('Option --limit must be an integer >= 1.');
    return;
  }

  parsed.limit = clamp(value, 1, MAX_LIMIT);
}

async function searchDocumentation(query, limit) {
  const { response, text } = await fetchBoundedText(
    ENDPOINT,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messages: [{ role: 'user', content: query }],
      }),
    },
    {
      timeoutMs: FETCH_TIMEOUT_MS,
      maxBytes: MAX_RESPONSE_BYTES,
      maxRedirects: 3,
      acceptedContentTypes: ['application/json'],
    },
  );

  if (!response.ok) {
    const message = response.statusText || String(response.status);
    throw new Error(`HTTP ${response.status} ${message}: ${text}`);
  }

  let data;
  try {
    data = JSON.parse(text);
  } catch (error) {
    throw new Error(
      `Nx documentation endpoint returned malformed JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const sections = data?.context?.pageSections;

  if (!Array.isArray(sections)) {
    throw new Error('Nx documentation response missing context.pageSections.');
  }

  const normalized = sections.slice(0, limit).map((section) => normalizeSection(section));
  return applyContentBudget(normalized);
}

function normalizeSection(section) {
  const heading = stringValue(section?.heading) || 'Untitled section';
  const longerHeading = stringValue(section?.longerHeading) || stringValue(section?.longer_heading);
  const slug = stringValue(section?.slug);
  const urlPartial = stringValue(section?.url_partial) || stringValue(section?.url);

  return {
    heading,
    longerHeading,
    content: stringValue(section?.content),
    url: buildUrl(urlPartial, slug),
    slug,
    similarity: typeof section?.similarity === 'number' ? section.similarity : null,
  };
}

function buildUrl(urlPartial, slug) {
  if (!urlPartial) {
    return slug ? `https://nx.dev#${encodeURIComponent(slug)}` : 'https://nx.dev';
  }

  const baseUrl = urlPartial.startsWith('https://') ? urlPartial : `https://nx.dev${urlPartial}`;

  if (!slug || baseUrl.includes('#')) {
    return baseUrl;
  }

  return `${baseUrl}#${encodeURIComponent(slug)}`;
}

function applyContentBudget(sections) {
  let remaining = MAX_TOTAL_CONTENT_LENGTH;
  const cappedSections = [];

  for (const section of sections) {
    const contentLimit = Math.max(0, Math.min(MAX_SECTION_CONTENT_LENGTH, remaining));
    const content = truncate(section.content, contentLimit);
    remaining -= content.length;
    cappedSections.push({ ...section, content });
  }

  return cappedSections;
}

function truncate(content, maxLength) {
  if (!content || maxLength <= 0) {
    return '';
  }

  if (content.length <= maxLength) {
    return content;
  }

  if (maxLength <= TRUNCATION_MARKER.length) {
    return content.slice(0, maxLength);
  }

  return `${content.slice(0, maxLength - TRUNCATION_MARKER.length)}${TRUNCATION_MARKER}`;
}

function positiveEnvironmentInteger(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function stringValue(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function printMarkdown(query, results) {
  console.log(`# Nx documentation search: ${query}`);
  console.log('');

  if (!results.length) {
    console.log('No results found.');
    return;
  }

  for (const [index, result] of results.entries()) {
    console.log(`## ${index + 1}. ${result.heading}`);
    console.log('');

    if (result.longerHeading && result.longerHeading !== result.heading) {
      console.log(`Context: ${result.longerHeading}`);
    }

    console.log(`Source: ${result.url}`);

    if (result.similarity !== null) {
      console.log(`Similarity: ${result.similarity}`);
    }

    if (result.content) {
      console.log('');
      console.log(result.content);
    }

    console.log('');
  }
}

function printHelp() {
  console.log(`
Usage:
  node scripts/search-documentation.mjs "query terms" [--limit 4] [--json] [--pretty]

Options:
  --limit <n>     Max number of sections (default ${DEFAULT_LIMIT}, clamped to 1-${MAX_LIMIT}).
  --json          Output JSON only.
  --pretty        Pretty-print JSON output.
  --help          Show this help.

Examples:
  node scripts/search-documentation.mjs "targetDefaults nx.json" --limit 4
  node scripts/search-documentation.mjs "nx release independent changelog" --limit 5 --json --pretty
`);
}
