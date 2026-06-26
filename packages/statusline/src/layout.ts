import { truncateToWidth, visibleWidth } from "./ansi-utils.ts";

export type LayoutLine = string[];
export type StatuslineLayout = LayoutLine[];

export const RESERVED_SPACER_TOKEN = "spacer";

export function normalizeLayout(raw: unknown): StatuslineLayout | null {
	if (!Array.isArray(raw)) {
		return null;
	}

	if (raw.length === 0) {
		return [[]];
	}

	let isNested: boolean | null = null;
	const flat: string[] = [];
	const nested: StatuslineLayout = [];

	for (const tokenOrLine of raw) {
		if (typeof tokenOrLine === "string") {
			if (isNested === true) {
				return null;
			}
			isNested = false;
			flat.push(tokenOrLine);
			continue;
		}

		if (Array.isArray(tokenOrLine)) {
			if (isNested === false) {
				return null;
			}
			isNested = true;
			const line: string[] = [];
			for (const token of tokenOrLine) {
				if (typeof token !== "string") {
					return null;
				}
				line.push(token);
			}
			nested.push(line);
			continue;
		}

		return null;
	}

	if (isNested === null) {
		return [[]];
	}

	if (isNested) {
		return nested;
	}

	return [flat];
}

function allocateSpacing(total: number, slotCount: number): number[] {
	if (slotCount <= 0 || total <= 0) {
		return Array(slotCount).fill(0);
	}

	if (slotCount === 2) {
		const left = Math.floor(total / 2);
		return [left, total - left];
	}

	const base = Math.floor(total / slotCount);
	const remainder = total % slotCount;
	const result = Array(slotCount).fill(base);
	for (let i = 0; i < remainder; i++) {
		result[i] += 1;
	}
	return result;
}

function getLineSegments(
	layoutLine: LayoutLine,
	itemText: (key: string) => string | undefined,
	separator: string,
): string[] {
	const segments: string[] = [];
	let current: string[] = [];

	for (const token of layoutLine) {
		if (token === RESERVED_SPACER_TOKEN) {
			segments.push(current.join(separator));
			current = [];
			continue;
		}

		const text = itemText(token);
		if (text !== undefined && text.length > 0) {
			current.push(text);
		}
	}

	segments.push(current.join(separator));
	return segments;
}

function getLineContentWidth(
	layoutLine: LayoutLine,
	itemText: (key: string) => string | undefined,
	separator: string,
): number {
	const segments = getLineSegments(layoutLine, itemText, separator);
	return segments.reduce((sum, segment) => sum + visibleWidth(segment), 0);
}

function getOrderedTokens(layout: StatuslineLayout): string[] {
	const tokens: string[] = [];
	for (const line of layout) {
		for (const token of line) {
			if (token !== RESERVED_SPACER_TOKEN) {
				tokens.push(token);
			}
		}
	}
	return tokens;
}

export function renderLayoutLine(
	layoutLine: LayoutLine,
	itemText: (key: string) => string | undefined,
	separator: string,
	width: number,
): string {
	if (width <= 0) {
		return "";
	}

	const segments = getLineSegments(layoutLine, itemText, separator);
	const visibleSegments = segments.filter((segment) => visibleWidth(segment) > 0);

	if (visibleSegments.length === 0) {
		return "";
	}

	const spacerCount = Math.max(0, visibleSegments.length - 1);
	const totalContentWidth = visibleSegments.reduce((sum, segment) => sum + visibleWidth(segment), 0);
	const remaining = width - totalContentWidth;
	const spaces = allocateSpacing(remaining, spacerCount);

	let rendered = "";
	for (let i = 0; i < visibleSegments.length; i++) {
		rendered += visibleSegments[i] ?? "";
		if (i < spaces.length) {
			rendered += " ".repeat(Math.max(0, spaces[i] ?? 0));
		}
	}

	return truncateToWidth(rendered, width);
}

export function renderLayoutLines(
	layout: StatuslineLayout,
	itemText: (key: string) => string | undefined,
	separator: string,
	width: number,
): string[] {
	if (width <= 0) {
		return layout.map(() => "");
	}

	const shouldFallback = layout.some((line) => getLineContentWidth(line, itemText, separator) > width);
	if (shouldFallback) {
		return getOrderedTokens(layout)
			.map((token) => itemText(token))
			.filter((text): text is string => typeof text === "string" && text.length > 0)
			.map((text) => truncateToWidth(text, width));
	}

	return layout
		.map((line) => renderLayoutLine(line, itemText, separator, width))
		.filter((line) => visibleWidth(line) > 0);
}

