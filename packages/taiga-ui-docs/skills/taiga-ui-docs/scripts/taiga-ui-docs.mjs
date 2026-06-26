#!/usr/bin/env node

// Copyright 2024 Acpekt
//
// Licensed under the Apache License, Version 2.0.
// This file reuses and ports logic from @taiga-ui/mcp (Apache-2.0).

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const DEFAULT_SOURCE_URL = "https://taiga-ui.dev/llms-full.txt";
const DEFAULT_TTL_MS = 6 * 60 * 60 * 1000; // 6h
const DEFAULT_CACHE_DIR = path.join(os.homedir(), ".cache", "taiga-ui-docs");
const COMMANDS = ["overview", "list", "example", "migration"];
const CACHE_SOURCE_FILE = "source.txt";
const CACHE_META_FILE = "meta.json";

const GENERIC_SUFFIXES = new Set([
	"component",
	"context",
	"directive",
	"guard",
	"interceptor",
	"module",
	"options",
	"pipe",
	"service",
]);

const OPTION_DEFINITIONS = {
	"source-url": { key: "sourceUrl", expectsValue: true },
	"source-file": { key: "sourceFile", expectsValue: true },
	"cache-dir": { key: "cacheDir", expectsValue: true },
	refresh: { key: "refresh", expectsValue: false },
	"no-cache": { key: "noCache", expectsValue: false },
	"ttl-ms": { key: "ttlMs", expectsValue: true },
	limit: { key: "limit", expectsValue: true },
	offset: { key: "offset", expectsValue: true },
	"max-chars": { key: "maxChars", expectsValue: true },
	output: { key: "output", expectsValue: true },
	force: { key: "force", expectsValue: false },
	pretty: { key: "pretty", expectsValue: false },
	help: { key: "help", expectsValue: false },
};

async function main() {
	const parsed = parseCommandLine(process.argv);

	if (parsed.errors.length) {
		await failWithCode(2, { error: parsed.errors.join("\n") }, parsed.options, {
			helpHint: true,
		});
		return;
	}

	const resolved = normalizeOptions(parsed);

	if (resolved.errors.length) {
		await failWithCode(2, { error: resolved.errors.join("\n") }, resolved.options, {
			helpHint: true,
		});
		return;
	}

	if (resolved.options.help) {
		printHelp();
		process.exit(0);
	}

	const command = resolved.command;

	if (!command) {
		await failWithCode(2, { error: "Missing command." }, resolved.options, {
			helpHint: true,
		});
		return;
	}

	if (!COMMANDS.includes(command)) {
		console.error(`Error: command "${command}" is not supported.`);
		console.error(`Expected one of: ${COMMANDS.join(", ")}.`);
		console.error("Try: node scripts/taiga-ui-docs.mjs --help");
		process.exit(2);
	}

	let sourceDescriptor;

	try {
		const sourceConfig = resolveSourceConfig(resolved.options);
		sourceDescriptor = await loadSource(sourceConfig, resolved.options);
	} catch (error) {
		await failWithCode(
			3,
			{ error: error instanceof Error ? error.message : String(error) },
			resolved.options,
			{ diagnostic: error instanceof Error ? error.message : String(error) },
		);
		return;
	}

	let index;

	try {
		index = parseContent(sourceDescriptor.content, sourceDescriptor.source);
	} catch (error) {
		await failWithCode(
			3,
			{ error: error instanceof Error ? error.message : String(error) },
			resolved.options,
			{ diagnostic: error instanceof Error ? error.message : String(error) },
		);
		return;
	}

	if (command === "overview") {
		const payload = handleOverview(index);
		await emitResult(payload, resolved.options);
		process.exit(0);
		return;
	}

	if (command === "list") {
		const query = resolved.commandArgs.join(" ");
		const payload = handleList(index, query, resolved.options);
		await emitResult(payload, resolved.options);
		process.exit(0);
		return;
	}

	if (command === "example") {
		const names = resolved.commandArgs;
		const validation = validateExampleNames(names);

		if (!validation.ok) {
			await failWithCode(2, { error: validation.error }, resolved.options, {
				helpHint: false,
				diagnostic: validation.error,
			});
			return;
		}

		const payload = handleExample(index, names, resolved.options);
		await emitResult(payload, resolved.options);
		process.exit(0);
		return;
	}

	if (command === "migration") {
		const payload = handleMigration(index);
		const exitCode = payload.error ? 4 : 0;
		await emitResult(payload, resolved.options);
		process.exit(exitCode);
		return;
	}
}

function parseCommandLine(argv) {
	const errors = [];
	const options = {};
	let command = null;
	const commandArgs = [];

	for (let index = 2; index < argv.length; index++) {
		const arg = argv[index];

		if (!arg.startsWith("--")) {
			if (command === null) {
				command = arg;
			} else {
				commandArgs.push(arg);
			}

			continue;
		}

		const raw = arg.slice(2);
		const eqIndex = raw.indexOf("=");
		const name = eqIndex === -1 ? raw : raw.slice(0, eqIndex);
		const value = eqIndex === -1 ? undefined : raw.slice(eqIndex + 1);

		const definition = OPTION_DEFINITIONS[name];

		if (!definition) {
			errors.push(`Unknown option: --${name}`);
			continue;
		}

		if (definition.expectsValue) {
			if (value === undefined) {
				const next = argv[index + 1];

				if (!next || next.startsWith("--")) {
					errors.push(`Option --${name} requires a value.`);
					continue;
				}

				options[definition.key] = next;
				index += 1;
			} else {
				options[definition.key] = value;
			}

			continue;
		}

		if (value === undefined) {
			options[definition.key] = true;
			continue;
		}

		if (value === "true" || value === "false") {
			options[definition.key] = value === "true";
			continue;
		}

		if (value !== undefined) {
			errors.push(`Option --${name} expects a boolean value.`);
		}
	}

	return { command, commandArgs, options, errors };
}

function normalizeOptions(parsed) {
	const errors = [];
	const result = {
		...parsed.options,
		cacheDir: parsed.options.cacheDir
			? path.resolve(process.cwd(), parsed.options.cacheDir)
			: DEFAULT_CACHE_DIR,
		refresh: Boolean(parsed.options.refresh),
		noCache: Boolean(parsed.options.noCache),
		force: Boolean(parsed.options.force),
		pretty: Boolean(parsed.options.pretty),
		help: Boolean(parsed.options.help),
	};

	const ttl = parseInteger(parsed.options.ttlMs, "ttl-ms", 0);
	if (ttl.error) {
		errors.push(ttl.error);
	} else if (ttl.value !== undefined) {
		result.ttlMs = ttl.value;
	} else {
		result.ttlMs = DEFAULT_TTL_MS;
	}

	const limit = parseInteger(parsed.options.limit, "limit", 0, true);
	if (limit.error) {
		errors.push(limit.error);
	} else if (limit.value !== undefined) {
		result.limit = limit.value;
	}

	const offset = parseInteger(parsed.options.offset, "offset", 0, true);
	if (offset.error) {
		errors.push(offset.error);
	} else if (offset.value !== undefined) {
		result.offset = offset.value;
	} else {
		result.offset = 0;
	}

	const maxChars = parseInteger(parsed.options.maxChars, "max-chars", 0, true);
	if (maxChars.error) {
		errors.push(maxChars.error);
	} else {
		result.maxChars = maxChars.value;
	}

	return {
		command: parsed.command,
		commandArgs: parsed.commandArgs,
		options: result,
		errors,
	};
}

function parseInteger(value, name, min, allowEmpty = false) {
	if (value === undefined) {
		if (allowEmpty) {
			return { value: undefined };
		}

		return { value: undefined };
	}

	const raw = String(value).trim();
	if (!raw) {
		return { error: `Option ${name} requires a numeric value.` };
	}

	const parsed = Number.parseInt(raw, 10);

	if (!Number.isFinite(parsed) || `${parsed}` !== raw || parsed < min) {
		return { error: `Option ${name} must be an integer >= ${min}.` };
	}

	return { value: parsed };
}

function resolveSourceConfig(options) {
	const resolvedSourceFile = options.sourceFile ?? process.env.TAIGA_UI_DOCS_SOURCE_FILE;
	const resolvedSourceUrl =
		options.sourceUrl ??
		process.env.TAIGA_UI_DOCS_SOURCE_URL ??
		process.env.SOURCE_URL ??
		DEFAULT_SOURCE_URL;

	return {
		sourceFile: resolvedSourceFile,
		sourceUrl: resolvedSourceUrl,
	};
}

async function loadSource(config, runtimeOptions = {}) {
	const cacheEnabled = !runtimeOptions.noCache;
	const cacheDir = runtimeOptions.cacheDir || DEFAULT_CACHE_DIR;

	if (config.sourceFile) {
		const sourcePath = path.resolve(process.cwd(), config.sourceFile);
		let content = "";

		try {
			content = await fs.readFile(sourcePath, "utf8");
		} catch (error) {
			throw new Error(
				`Failed to read source file ${sourcePath}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}

		if (!content.trim()) {
			throw new Error(`Source file ${sourcePath} is empty.`);
		}

		return {
			source: {
				type: "file",
				value: sourcePath,
				sourceUrl: sourcePath,
				cached: false,
				loadedAt: Date.now(),
			},
			content,
		};
	}

	const sourceUrl = config.sourceUrl;

	if (!sourceUrl) {
		throw new Error("No source URL configured for remote load.");
	}

	if (!runtimeOptions.refresh && cacheEnabled) {
		const cached = await loadCachedSource(sourceUrl, cacheDir, runtimeOptions.ttlMs);

		if (cached) {
			return {
				source: {
					type: "remote",
					value: sourceUrl,
					sourceUrl,
					cached: true,
					loadedAt: cached.loadedAt,
				},
				content: cached.content,
			};
		}
	}

	let response;

	try {
		response = await fetch(sourceUrl);
	} catch (error) {
		throw new Error(
			`Network error fetching documentation source: ${error instanceof Error ? error.message : String(error)}`,
		);
	}

	if (!response.ok) {
		throw new Error(
			`Failed to fetch documentation (HTTP ${response.status} ${response.statusText}) from ${sourceUrl}`,
		);
	}

	const content = await response.text();

	if (!content.trim()) {
		throw new Error(`Fetched documentation from ${sourceUrl} is empty.`);
	}

	const loadedAt = Date.now();

	if (cacheEnabled) {
		await saveCachedSource(sourceUrl, content, cacheDir, loadedAt);
	}

	return {
		source: {
			type: "remote",
			value: sourceUrl,
			sourceUrl,
			cached: false,
			loadedAt,
		},
		content,
	};
}

async function loadCachedSource(sourceUrl, cacheDir, ttlMs) {
	try {
		const [metaText, sourceText] = await Promise.all([
			fs.readFile(path.join(cacheDir, CACHE_META_FILE), "utf8"),
			fs.readFile(path.join(cacheDir, CACHE_SOURCE_FILE), "utf8"),
		]);

		const meta = JSON.parse(metaText);

		if (meta.sourceUrl !== sourceUrl) {
			return null;
		}

		const loadedAt = Number(meta.loadedAt);

		if (!Number.isFinite(loadedAt)) {
			return null;
		}

		if (Date.now() - loadedAt > ttlMs) {
			return null;
		}

		if (!sourceText.trim()) {
			return null;
		}

		return { content: sourceText, loadedAt };
	} catch {
		return null;
	}
}

async function saveCachedSource(sourceUrl, content, cacheDir, loadedAt) {
	try {
		await fs.mkdir(cacheDir, { recursive: true });
		await Promise.all([
			fs.writeFile(path.join(cacheDir, CACHE_SOURCE_FILE), content, "utf8"),
			fs.writeFile(
				path.join(cacheDir, CACHE_META_FILE),
				JSON.stringify({ sourceUrl, loadedAt }),
				"utf8",
			),
		]);
	} catch {
		// Cache errors are non-fatal; command can still work.
	}
}

function parseContent(rawContent, source) {
	if (!rawContent.trim()) {
		throw new Error("parseContent: rawContent is empty");
	}

	const headerContent = extractHeaderContent(rawContent);
	const migrationGuideContent = extractMigrationGuideContent(rawContent);
	const lines = rawContent.split(/\r?\n/);
	const componentsStartLine = findComponentsSectionStart(rawContent);
	const headerIndices = [];

	for (let lineIndex = componentsStartLine; lineIndex < lines.length; lineIndex++) {
		const line = lines[lineIndex];

		if (!line) {
			continue;
		}

		const headerMatch = /^#\s+(\S.*)$/.exec(line);

		if (headerMatch?.[1]) {
			headerIndices.push({
				line: lineIndex,
				title: headerMatch[1].trim(),
			});
		}
	}

	const sections = headerIndices.map((header, index) => {
		const start = header.line;
		const end = headerIndices[index + 1]?.line ?? lines.length;
		const sectionContent = lines.slice(start, end).join("\n");
		const metadata = extractSectionMeta(sectionContent);

		return {
			id: header.title,
			title: header.title,
			content: sectionContent,
			package: metadata.package,
			kind: metadata.kind,
		};
	});

	return {
		source,
		overview: headerContent,
		migrationGuide: migrationGuideContent,
		sections,
	};
}

function extractSectionMeta(text) {
	let packageValue;
	let kind;

	const packageMatch = /\*\*Package\*\*:\s*`([^`]+)`/i.exec(text);
	if (packageMatch?.[1]) {
		packageValue = packageMatch[1];
	}

	const typeMatch = /\*\*Type\*\*:\s*([^\n]+)/i.exec(text);
	if (typeMatch?.[1]) {
		kind = typeMatch[1].trim();
	}

	return { package: packageValue, kind };
}

function extractHeaderContent(rawContent) {
	const lines = rawContent.split(/\r?\n/);
	const headerLines = [];

	for (const line of lines) {
		if (/^#\s+components\//.test(line)) {
			break;
		}

		headerLines.push(line);
	}

	return headerLines.join("\n").trim();
}

function findComponentsSectionStart(rawContent) {
	const lines = rawContent.split(/\r?\n/);

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];

		if (line && /^#\s+components\//.test(line)) {
			return i;
		}
	}

	return lines.length;
}

function parseHeaderSections(headerContent) {
	const lines = headerContent.split(/\r?\n/);
	const sections = [];
	const title = "Taiga UI - Complete Documentation";

	const sectionIndices = [];

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];

		if (!line) {
			continue;
		}

		const h1Match = /^#\s+([^#]\S.*)$/.exec(line);

		if (h1Match?.[1]) {
			sectionIndices.push({
				line: i,
				title: h1Match[1].trim(),
			});
		}
	}

	for (let i = 0; i < sectionIndices.length; i++) {
		const currentSection = sectionIndices[i];

		if (!currentSection) {
			continue;
		}

		const start = currentSection.line;
		const end = sectionIndices[i + 1]?.line ?? lines.length;
		const sectionContent = lines.slice(start, end).join("\n");
		const parsedSection = parseHeaderSection(sectionContent);

		sections.push(parsedSection);
	}

	const compactedSections = sections.map((section) => {
		const hasMarkdownSubsections = section.subsections.some((subsection) =>
			subsection.title.endsWith(".md"),
		);

		return hasMarkdownSubsections
			? {
					...section,
					subsections: section.subsections.map((subsection) => {
						const redundantSingleCodeSection =
							subsection.content.length === 0 &&
							!subsection.items?.length &&
							subsection.sections?.length === 1 &&
							subsection.sections[0]?.section === subsection.title &&
							Boolean(subsection.sections[0].code);

						return redundantSingleCodeSection
							? {
									title: subsection.title,
									content: [subsection.sections?.[0]?.code ?? ""],
								}
							: subsection;
					}),
				}
			: section;
	});

	return {
		title,
		sections: compactedSections,
	};
}

function extractCodeBlocks(content) {
	const codeBlocks = [];
	const lines = content.split("\n");
	let inCodeBlock = false;
	let currentLang = "";
	let currentCode = [];

	for (const line of lines) {
		if (line.startsWith("```")) {
			if (inCodeBlock) {
				codeBlocks.push({
					language: currentLang,
					code: currentCode.join("\n").trim(),
				});
				currentCode = [];
				inCodeBlock = false;
			} else {
				currentLang = line.slice(3).trim() || "plaintext";
				inCodeBlock = true;
			}

			continue;
		}

		if (inCodeBlock) {
			currentCode.push(line);
		}
	}

	return codeBlocks;
}

function extractPlainContent(content) {
	const lines = content.split("\n");
	const plainLines = [];
	let inCodeBlock = false;

	for (const line of lines) {
		if (line.startsWith("```")) {
			inCodeBlock = !inCodeBlock;
			continue;
		}

		if (inCodeBlock) {
			continue;
		}

		if (!line.trim()) {
			continue;
		}

		if (/^#{1,6}\s+/.test(line)) {
			continue;
		}

		if (/^-{3,}\s*$/.test(line)) {
			continue;
		}

		if (line.includes("**Critical**:") || line.includes("**Auto-generated**:")) {
			continue;
		}

		let cleaned = line.replace(/^>\s*/, "").trim();
		cleaned = cleaned.replaceAll(/\*\*([^*]+)\*\*/g, "$1");
		cleaned = cleaned.replaceAll(/\*([^*]+)\*/g, "$1");
		cleaned = cleaned.replaceAll(/`([^`]+)`/g, "$1");

		if (cleaned) {
			plainLines.push(cleaned);
		}
	}

	return plainLines;
}

function parseHeaderSection(content) {
	const lines = content.split("\n");
	const subsections = [];
	const description = [];
	const criticalNotices = [];
	let title = "";

	const headings = [];

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];

		if (!line) {
			continue;
		}

		const h1Match = /^#\s+([^#]\S.*)$/.exec(line);

		if (h1Match?.[1] && !title) {
			title = h1Match[1].trim();
			headings.push({ line: i, level: 1, title: h1Match[1].trim() });
			continue;
		}

		const hMatch = /^(#{2,6})\s+(\S.*)$/.exec(line);

		if (hMatch?.[1] && hMatch[2]) {
			headings.push({
				line: i,
				level: hMatch[1].length,
				title: hMatch[2].trim(),
			});

			continue;
		}

		const boldMatch = /^\*\*(.+):\*\*$/.exec(line);

		if (boldMatch?.[1]) {
			headings.push({
				line: i,
				level: 2,
				title: `${boldMatch[1].trim()}:`,
			});

			continue;
		}

		if (line.startsWith("> **Critical**:")) {
			const notice = line.replace(/^>\s*\*\*Critical\*\*:\s*/, "").trim();

			if (notice) {
				criticalNotices.push(notice);
			}
		}
	}

	if (headings.length > 0 && headings[0]) {
		const firstSubsectionLine = headings.find((h) => h.level > 1)?.line;
		const descEnd = firstSubsectionLine ?? lines.length;
		const descContent = lines.slice(headings[0].line + 1, descEnd).join("\n");

		description.push(...extractPlainContent(descContent));
	}

	let currentSubsection = null;
	let currentItem = null;
	let currentGroup = null;

	const pushCurrentItem = () => {
		if (!currentItem || !currentSubsection) {
			return;
		}

		if (
			currentItem.content.length > 0 ||
			currentItem.code ||
			(currentItem.sections && currentItem.sections.length > 0)
		) {
			currentSubsection.items = currentSubsection.items || [];
			currentSubsection.items.push(currentItem);
		}

		currentItem = null;
	};

	const pushCurrentGroup = () => {
		if (!currentGroup || !currentSubsection) {
			return;
		}

		if (
			currentGroup.content.length > 0 ||
			(currentGroup.sections && currentGroup.sections.length > 0)
		) {
			currentSubsection.items = currentSubsection.items || [];
			currentSubsection.items.push(currentGroup);
		}

		currentGroup = null;
	};

	const addSectionToItem = (item, sectionItem, plainContent) => {
		item.sections = item.sections || [];
		item.sections.push(sectionItem);

		if (plainContent.length > 0) {
			item.content.push(...plainContent);
		}
	};

	for (let i = 1; i < headings.length; i++) {
		const current = headings[i];

		if (!current) {
			continue;
		}

		const start = current.line;
		const end = headings[i + 1]?.line ?? lines.length;
		const subsectionContent = lines.slice(start + 1, end).join("\n");

		if (current.level === 2 && !current.title.endsWith(":")) {
			pushCurrentItem();
			pushCurrentGroup();

			if (currentSubsection) {
				if (
					currentSubsection.content.length > 0 ||
					(currentSubsection.sections && currentSubsection.sections.length > 0) ||
					(currentSubsection.items && currentSubsection.items.length > 0)
				) {
					subsections.push(currentSubsection);
				}
			}

			const [block] = extractCodeBlocks(subsectionContent);
			const subsectionSections = block
				? [
						{
							section: current.title,
							code: block.code,
						},
					]
				: [];

			currentSubsection = {
				title: current.title,
				content: extractPlainContent(subsectionContent),
				sections: subsectionSections,
				items: [],
			};

			continue;
		}

		if (current.level === 3 && !current.title.endsWith(":")) {
			const plainContent = extractPlainContent(subsectionContent);
			const codeBlocks = extractCodeBlocks(subsectionContent);
			const code = codeBlocks.length > 0 ? codeBlocks[0]?.code : undefined;

			if (currentGroup && currentSubsection) {
				const sectionItem = {
					section: current.title,
					code,
				};

				currentGroup.sections = currentGroup.sections || [];
				currentGroup.sections.push(sectionItem);

				if (plainContent.length > 0) {
					currentGroup.content.push(...plainContent);
				}

				continue;
			}

			pushCurrentItem();

			currentItem = {
				title: current.title,
				content: plainContent,
				...(code ? { code } : {}),
				sections: [],
			};

			continue;
		}

		if (current.title.endsWith(":")) {
			const codeBlocks = extractCodeBlocks(subsectionContent);
			const code = codeBlocks.length > 0 ? codeBlocks[0]?.code : undefined;
			const plainContent = extractPlainContent(subsectionContent);
			const nextHeading = headings[i + 1];

			if (currentSubsection && !currentItem && nextHeading?.level === 3) {
				pushCurrentGroup();

				currentGroup = {
					title: current.title.replace(/:\s*$/, ""),
					content: plainContent,
					...(code ? { code } : {}),
					sections: [],
				};
				currentItem = null;

				continue;
			}

			const sectionItem = {
				section: current.title,
				code,
			};

			if (currentItem) {
				addSectionToItem(currentItem, sectionItem, plainContent);
				continue;
			}

			if (currentSubsection) {
				currentSubsection.sections = currentSubsection.sections || [];
				currentSubsection.sections.push(sectionItem);
				continue;
			}

			subsections.push({
				title: current.title,
				content: plainContent,
				sections: code ? [sectionItem] : undefined,
			});

			continue;
		}

		pushCurrentItem();
		pushCurrentGroup();

		if (currentSubsection) {
			subsections.push(currentSubsection);
			currentSubsection = null;
		}

		const plainContent = extractPlainContent(subsectionContent);
		const codeBlocks = extractCodeBlocks(subsectionContent);

		subsections.push({
			title: current.title,
			content: plainContent,
			sections:
				codeBlocks.length > 0 ? [{ section: current.title, code: codeBlocks[0]?.code }] : undefined,
		});
	}

	pushCurrentItem();
	pushCurrentGroup();

	if (currentSubsection) {
		if (
			currentSubsection.content.length > 0 ||
			(currentSubsection.sections && currentSubsection.sections.length > 0) ||
			(currentSubsection.items && currentSubsection.items.length > 0)
		) {
			subsections.push(currentSubsection);
		}
	}

	if (subsections.length === 0 && headings.length === 1 && headings[0]) {
		const contentAfterTitle = lines.slice(headings[0].line + 1).join("\n");
		const codeBlocks = extractCodeBlocks(contentAfterTitle);

		if (codeBlocks.length > 0 && codeBlocks[0]) {
			subsections.push({
				title: "",
				content: [codeBlocks[0].code],
			});
		}
	}

	const descriptionText = description.join("\n");

	return {
		title,
		description: descriptionText || "",
		criticalNotices,
		subsections,
	};
}

function extractMigrationGuideContent(rawContent) {
	if (!rawContent.trim()) {
		return undefined;
	}

	const lines = rawContent.split(/\r?\n/);
	let startIndex = -1;
	let endIndex = lines.length;
	const migrationGuideRegex = /^#\s+Migration\s+Guide/i;
	const componentsRegex = /^#\s+components\//;

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];

		if (!line) {
			continue;
		}

		if (line === "---" && migrationGuideRegex.exec(lines[i + 1] ?? "")) {
			startIndex = i;
			continue;
		}

		if (startIndex !== -1 && componentsRegex.exec(line)) {
			endIndex = i;
			break;
		}
	}

	return startIndex === -1 ? undefined : lines.slice(startIndex, endIndex).join("\n").trim();
}

function parseMigrationGuide(migrationContent) {
	const lines = migrationContent.split(/\r?\n/);
	let title = "Migration Guide";
	const introduction = [];
	const sections = [];
	let currentSection = null;
	let currentSubsection = null;
	let inCodeBlock = false;
	let inHtmlComment = false;
	let currentCode = [];

	const appendCode = (code) => {
		if (currentSubsection) {
			currentSubsection.codeBlocks = currentSubsection.codeBlocks || [];
			currentSubsection.codeBlocks.push(code);

			return;
		}

		if (currentSection) {
			currentSection.codeBlocks = currentSection.codeBlocks || [];
			currentSection.codeBlocks.push(code);
		}
	};

	const pushCurrentSubsection = () => {
		if (!currentSubsection || !currentSection) {
			return;
		}

		if (
			currentSubsection.content.length > 0 ||
			(currentSubsection.codeBlocks && currentSubsection.codeBlocks.length > 0)
		) {
			currentSection.subsections = currentSection.subsections || [];
			currentSection.subsections.push(currentSubsection);
		}

		currentSubsection = null;
	};

	const pushCurrentSection = () => {
		if (!currentSection) {
			return;
		}

		pushCurrentSubsection();

		if (
			currentSection.content.length > 0 ||
			(currentSection.codeBlocks && currentSection.codeBlocks.length > 0) ||
			(currentSection.subsections && currentSection.subsections.length > 0)
		) {
			sections.push(currentSection);
		}

		currentSection = null;
	};

	for (const line of lines) {
		if (line.startsWith("```")) {
			if (inCodeBlock) {
				inCodeBlock = false;

				const code = currentCode.join("\n");

				if (code || currentCode.length > 0) {
					appendCode(code);
				}

				currentCode = [];
			} else {
				inCodeBlock = true;
			}

			continue;
		}

		if (inCodeBlock) {
			currentCode.push(line);
			continue;
		}

		if (inHtmlComment) {
			if (line.includes("-->")) {
				inHtmlComment = false;
			}

			continue;
		}

		if (line.startsWith("<!--")) {
			inHtmlComment = !line.includes("-->");
			continue;
		}

		if (!line || line === "---") {
			continue;
		}

		const h1Match = /^# ([^#\n]+)$/.exec(line);
		if (h1Match?.[1]) {
			pushCurrentSection();
			title = h1Match[1].trim();
			continue;
		}

		const h2Match = /^## ([^#\n]+)$/.exec(line);
		if (h2Match?.[1]) {
			pushCurrentSection();

			currentSection = {
				title: h2Match[1].trim(),
				content: [],
			};

			continue;
		}

		const h3Match = /^### ([^#\n]+)$/.exec(line);
		if (h3Match?.[1]) {
			pushCurrentSubsection();

			currentSubsection = {
				title: h3Match[1].trim(),
				content: [],
			};

			continue;
		}

		if (line.startsWith(">")) {
			const cleaned = line.replace(/^>\s*/, "").trim();

			if (!cleaned) {
				continue;
			}

			if (currentSubsection) {
				currentSubsection.content.push(cleaned);
			} else if (currentSection) {
				currentSection.content.push(cleaned);
			} else {
				introduction.push(cleaned);
			}

			continue;
		}

		if (line.startsWith("- ")) {
			const cleaned = line.slice(2).trim();

			if (!cleaned) {
				continue;
			}

			const item = `- ${cleaned}`;

			if (currentSubsection) {
				currentSubsection.content.push(item);
			} else if (currentSection) {
				currentSection.content.push(item);
			} else {
				introduction.push(item);
			}

			continue;
		}

		if (line.startsWith("---")) {
			continue;
		}

		const cleaned = line.trim();

		if (cleaned) {
			if (currentSubsection) {
				currentSubsection.content.push(cleaned);
			} else if (currentSection) {
				currentSection.content.push(cleaned);
			} else {
				introduction.push(cleaned);
			}
		}
	}

	if (inCodeBlock && currentCode.length > 0) {
		appendCode(currentCode.join("\n"));
	}

	pushCurrentSubsection();
	pushCurrentSection();

	return {
		title,
		introduction,
		sections,
	};
}

function constructComponentsList(sections, query = "") {
	const normalizedQuery = query.toLowerCase().replace(/^tui/, "");

	return sections
		.filter((section) => !normalizedQuery || section.id.toLowerCase().includes(normalizedQuery))
		.map((section) => {
			const idParts = section.id.split("/");
			const name = idParts[idParts.length - 1] ?? section.id;
			const category = idParts[0] ?? "";

			return {
				id: section.id,
				name,
				category,
				package: section.package ?? null,
				type: section.kind ?? null,
			};
		});
}

function normalizeToKebab(name) {
	const stripped = name.replace(/^[Tt]ui[-_]?/, "");

	return stripped.replaceAll(/([a-z])([A-Z])/g, "$1-$2").toLowerCase();
}

function findSection(name, sections) {
	const stripped = name.replace(/^[Tt]ui[-_]?/, "");
	const kebab = normalizeToKebab(name);

	const kebabParts = kebab.split("-").filter(Boolean);
	const lastWordCandidate = kebabParts.length > 1 ? (kebabParts[kebabParts.length - 1] ?? "") : "";
	const lastWord = GENERIC_SUFFIXES.has(lastWordCandidate) ? "" : lastWordCandidate;

	const pascalCase = (stripped || name)
		.toLowerCase()
		.split(/[-_\s]+/)
		.filter(Boolean)
		.map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
		.join("");

	const tuiVariant = pascalCase.startsWith("Tui") ? pascalCase : `Tui${pascalCase}`;

	const variants = [
		name.toLowerCase(),
		stripped.toLowerCase(),
		kebab,
		lastWord,
		pascalCase.toLowerCase(),
		tuiVariant.toLowerCase(),
	].filter(Boolean);

	const prepared = sections.map((section) => ({
		section,
		id: section.id.toLowerCase(),
		segment: section.id.split("/").pop()?.toLowerCase() ?? "",
	}));

	for (const variant of variants) {
		const match = prepared.find((item) => item.id === variant);

		if (match) {
			return match.section;
		}
	}

	for (const variant of variants) {
		const match = prepared.find((item) => item.segment === variant);

		if (match) {
			return match.section;
		}
	}

	for (const variant of variants) {
		const match = prepared.find((item) => item.id.endsWith(`/${variant}`));

		if (match) {
			return match.section;
		}
	}

	for (const variant of variants) {
		const match = prepared.find((item) => item.id.includes(variant));

		if (match) {
			return match.section;
		}
	}

	return undefined;
}

function suggestSections(query, sections) {
	const kebab = normalizeToKebab(query);

	const parts = kebab.split("-").filter((part) => !GENERIC_SUFFIXES.has(part) && part.length > 1);

	const normalizedQuery = (parts.join("-") || kebab || query).toLowerCase();

	const results = [];

	for (const section of sections) {
		const idLower = section.id.toLowerCase();
		const matchIndex = idLower.indexOf(normalizedQuery);

		if (matchIndex !== -1) {
			results.push({
				id: section.id,
				score: matchIndex * 10 + Math.abs(idLower.length - normalizedQuery.length),
			});
		}
	}

	return results.sort((a, b) => a.score - b.score).map((item) => item.id);
}

function extractContentSnippets(section) {
	const text = section.content || "";
	const trimmed = text.trim();

	if (!trimmed) {
		return [];
	}

	const cleaned = trimmed
		.split(/\r?\n/)
		.map((line) => line.replace(/^#{1,6}\s*/, ""))
		.join("\n")
		.trim();

	return cleaned ? [cleaned] : [];
}

function paginateText(text, { offset = 0, maxChars }) {
	const totalChars = text.length;
	const safeOffset = Math.max(0, Math.min(offset, totalChars));

	if (!Number.isFinite(maxChars)) {
		return {
			content: text.slice(safeOffset),
			page: {
				offset: safeOffset,
				maxChars: null,
				returnedChars: totalChars - safeOffset,
				totalChars,
				truncated: false,
				nextOffset: null,
			},
		};
	}

	const end = Math.min(safeOffset + maxChars, totalChars);

	return {
		content: text.slice(safeOffset, end),
		page: {
			offset: safeOffset,
			maxChars,
			returnedChars: end - safeOffset,
			totalChars,
			truncated: end < totalChars,
			nextOffset: end < totalChars ? end : null,
		},
	};
}

function validateExampleNames(names) {
	if (!names.length) {
		return { ok: false, error: "At least one component name is required for example." };
	}

	for (const name of names) {
		if (name.length < 2) {
			return {
				ok: false,
				error: `Example name must have at least 2 characters: "${name}"`,
			};
		}
	}

	return { ok: true };
}

function handleOverview(index) {
	const headerInfo = index.overview
		? parseHeaderSections(index.overview)
		: {
				title: "Taiga UI - Complete Documentation",
				sections: [],
			};

	const mappedSections = headerInfo.sections.map((section) => {
		const sectionData = {
			title: section.title,
			criticalNotices: section.criticalNotices,
			subsections: section.subsections.map((subsection) => {
				const subsectionData = {
					title: subsection.title,
					content: subsection.content,
				};

				if (subsection.sections && subsection.sections.length > 0) {
					subsectionData.sections = subsection.sections;
				}

				if (subsection.items && subsection.items.length > 0) {
					subsectionData.items = subsection.items.map((item) => {
						const itemData = {
							title: item.title,
							content: item.content,
						};

						if (item.code) {
							itemData.code = item.code;
						}

						if (item.sections && item.sections.length > 0) {
							itemData.sections = item.sections;
						}

						return itemData;
					});
				}

				return subsectionData;
			}),
		};

		if (section.description) {
			sectionData.description = section.description;
		}

		return sectionData;
	});

	return {
		title: headerInfo.title,
		sections: mappedSections,
		totalComponents: index.sections.length,
		sourceUrl: index.source.sourceUrl,
	};
}

function handleList(index, query, options) {
	const items = constructComponentsList(index.sections, query);
	const offset = options.offset ?? 0;
	const limit = options.limit;

	const returnedItems =
		typeof limit === "number" ? items.slice(offset, offset + limit) : items.slice(offset);

	if (typeof limit !== "number" && offset === 0) {
		return { items: returnedItems };
	}

	return {
		items: returnedItems,
		total: items.length,
		returned: returnedItems.length,
		offset,
		limit: limit ?? null,
	};
}

function handleExample(index, names, options) {
	const results = [];
	let matched = 0;

	for (const queryName of names) {
		const section = findSection(queryName, index.sections);

		if (!section) {
			results.push({
				query: queryName,
				suggestions: suggestSections(queryName, index.sections),
			});

			continue;
		}

		matched += 1;

		const snippets = extractContentSnippets(section);
		const found = {
			query: queryName,
			id: section.id,
			package: section.package ?? null,
			type: section.kind ?? null,
		};

		if (snippets[0]) {
			if (typeof options.maxChars === "number") {
				const paginated = paginateText(snippets[0], {
					offset: options.offset ?? 0,
					maxChars: options.maxChars,
				});

				found.content = [paginated.content];
				found.page = paginated.page;
			} else {
				found.content = snippets;
			}
		}

		results.push(found);
	}

	return {
		results,
		matched,
	};
}

function handleMigration(index) {
	if (!index.migrationGuide?.trim()) {
		return {
			error:
				"Migration Guide is not available. Ensure the source file contains the Migration Guide section.",
		};
	}

	const parsed = parseMigrationGuide(index.migrationGuide);

	return {
		title: parsed.title,
		introduction: parsed.introduction,
		sections: parsed.sections.map((section) => {
			const sectionData = {
				title: section.title,
				content: section.content,
			};

			if (section.codeBlocks && section.codeBlocks.length > 0) {
				sectionData.codeBlocks = section.codeBlocks;
			}

			if (section.subsections && section.subsections.length > 0) {
				sectionData.subsections = section.subsections.map((subsection) => {
					const subsectionData = {
						title: subsection.title,
						content: subsection.content,
					};

					if (subsection.codeBlocks && subsection.codeBlocks.length > 0) {
						subsectionData.codeBlocks = subsection.codeBlocks;
					}

					return subsectionData;
				});
			}

			return sectionData;
		}),
	};
}

async function emitResult(payload, options) {
	const pretty = Boolean(options.pretty);
	const serialized = JSON.stringify(payload, null, pretty ? 2 : 0);

	if (options.output) {
		const outputPath = path.resolve(process.cwd(), options.output);

		if (!options.force) {
			try {
				await fs.access(outputPath);
				await failWithCode(
					5,
					{
						error: `Output file already exists. Use --force to overwrite: ${outputPath}`,
					},
					options,
				);
				return;
			} catch {
				// Continue.
			}
		}

		try {
			await fs.mkdir(path.dirname(outputPath), { recursive: true });
			await fs.writeFile(outputPath, serialized, "utf8");

			const summary = {
				output: outputPath,
				bytes: Buffer.from(serialized, "utf8").byteLength,
				pretty,
			};

			console.log(JSON.stringify(summary, null, pretty ? 2 : 0));
			return;
		} catch (error) {
			await failWithCode(
				5,
				{
					error: `Failed to write output file ${outputPath}: ${
						error instanceof Error ? error.message : String(error)
					}`,
				},
				options,
			);
		}

		return;
	}

	console.log(serialized);
}

async function failWithCode(code, payload, options = {}, context = {}) {
	if (!context.noStdout && payload !== undefined) {
		const pretty = Boolean(options.pretty);
		console.log(JSON.stringify(payload, null, pretty ? 2 : 0));
	}

	const diagnostic = context.diagnostic ?? payload?.error;

	if (diagnostic) {
		console.error(diagnostic);
	}

	if (!context.noStdout && code === 2 && context.helpHint) {
		console.error("Try: node scripts/taiga-ui-docs.mjs --help");
	}

	process.exit(code);
}

function printHelp() {
	console.log(`Usage:
  node scripts/taiga-ui-docs.mjs overview [options]
  node scripts/taiga-ui-docs.mjs list [query] [options]
  node scripts/taiga-ui-docs.mjs example <name...> [options]
  node scripts/taiga-ui-docs.mjs migration [options]

Description:
  Fetches/parses Taiga UI llms-full.txt and returns JSON equivalent to the Taiga UI MCP docs tools.

Options:
  --source-url <url>     Docs source URL. Also supports --source-url=<url>.
  --source-file <path>   Read docs from local file.
  --refresh              Force remote refetch.
  --no-cache             Disable cache for this run.
  --cache-dir <path>     Override cache directory.
  --ttl-ms <n>           Cache TTL in ms. Default: 21600000.
  --limit <n>            Limit list results. Default: no limit.
  --offset <n>           Offset for list/content pagination. Default: 0.
  --max-chars <n>        Max chars returned for large example content. Default: full content.
  --output <file>        Write full JSON to file; stdout contains JSON file summary.
  --force                Overwrite --output file if it exists.
  --pretty               Pretty-print JSON.
  --help                 Show help.

Environment:
  TAIGA_UI_DOCS_SOURCE_FILE  Local docs source file.
  TAIGA_UI_DOCS_SOURCE_URL   Docs source URL.
  SOURCE_URL                 Docs source URL, compatible with @taiga-ui/mcp.

Exit codes:
  0 success, including example queries with zero matches
  2 invalid arguments
  3 source fetch/read/cache error
  4 requested documentation section is unavailable, e.g. missing migration guide
  5 output file error

Examples:
  node scripts/taiga-ui-docs.mjs overview --pretty
  node scripts/taiga-ui-docs.mjs list button --limit 100 --pretty
  node scripts/taiga-ui-docs.mjs example Button --max-chars 24000 --pretty
  node scripts/taiga-ui-docs.mjs example TuiInput --offset 24000 --max-chars 24000 --pretty
  node scripts/taiga-ui-docs.mjs migration --pretty`);
}

main().catch((error) => {
	console.error(error?.stack || String(error));
	process.exit(1);
});
