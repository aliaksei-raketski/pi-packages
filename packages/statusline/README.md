# @aliaksei-raketski/pi-statusline

A Pi extension that replaces the footer statusline with a configurable, multi-line layout.

## Install

```bash
pi install npm:@aliaksei-raketski/pi-statusline
```

## Features

- Custom footer layout with spacer tokens.
- Single-line and multi-line layouts.
- Automatic narrow-terminal fallback to one status item per line.
- Per-token and per-state color control (`muted`, theme names, hex, or 256-color numbers).
- Optional extension statuses from `ctx.ui.setStatus()`:
  - Use explicit `statuses` token to show all extension statuses.
  - Or reference any status key name directly in `layout` to show that extension status only.
- Live updates for model, thinking level, branch, context, and session usage/cost.
- Project-local config is loaded only when the project is trusted.

## Configuration

Configuration is loaded from two files and merged in order:

1. **User config**: `~/.pi/statusline.json`
2. **Project config**: `.<project>/.pi/statusline.json` (only when project is trusted)

Invalid config values are ignored and fall back to defaults, with warnings emitted in the UI.

If no user config exists, statusline will create `~/.pi/statusline.json` with the default configuration on first launch for easy editing.

### Default config

```json
{
	"layout": [
		["branch", "changes"],
		["context", "cache", "cost", "spacer", "model", "thinking"],
		["title"],
		["cwd"],
	],
	"separator": " • ",
	"separatorColor": "dim",
	"prefix": {
		"branch": "",
		"model": "🤖",
		"context": "ctx"
	},
	"colors": {
		"cwd": "muted",
		"branch": { "normal": "accent" },
		"title": "muted",
		"model": "toolTitle",
		"changes": "muted",
		"thinking": {
			"off": "thinkingOff",
			"minimal": "thinkingMinimal",
			"low": "thinkingLow",
			"medium": "thinkingMedium",
			"high": "thinkingHigh",
			"xhigh": "thinkingXhigh"
		},
		"context": {
			"normal": "muted",
			"warning": "warning",
			"full": "error",
			"default": "muted"
		},
		"tokens": "muted",
		"cache": "muted",
		"cost": "muted"
	}
}
```

### Layout

`layout` is either:

- a single array of tokens (single line), or
- an array of arrays (multi-line).

A line can include the reserved token `spacer` to allocate flexible spacing. Note: `separator` is only inserted between tokens inside the same segment, so if you put `spacer` between every token, separators may not be visible.

On narrow terminals, the renderer falls back to one item per line (ordered by layout), using all available width and without segment separators/spacers.
Lines that render to no visible content are omitted automatically (for example an empty `title` line).

Examples:

```json
{ "layout": ["cwd", "branch", "model"] }
```

```json
{
	"layout": [
		["cwd", "model", "thinking"],
		["changes", "title", "context"]
	]
}
```

### Status items

The `layout` array uses the following token names:

- `cwd` — current working directory, shortened with `~` for your home directory.
- `model` — current model name (model id only, e.g. `gpt-4.1`), or `unknown` if unavailable.
- `thinking` — current thinking level from Pi: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`.
- `branch` — current git branch from footer context.
- `changes` — git changes summary with counts: `!<conflicts> +<staged> ~<unstaged> ?<untracked> ↑<ahead> ↓<behind>` (only non-zero parts are shown; untracked files are counted per-file).
- `title` — current session name (`ctx.sessionManager.getSessionName()`) if set.
- `tokens` — total message tokens seen so far as `<input>↑ <output>↓`.
- `context` — context usage: `<percent>%/<contextWindow>` (for example `52.5%/128k`) and optional state (`normal`, `warning`, `full`) based on percent.
- `cache` — cache usage: `<cacheRead>/<cacheWrite> <percent>%` using branch history assistant usage.
- `cost` — accumulated usage cost shown as `$<value>`.

`statuses` is rendered when `statuses` is explicitly in `layout`.

You can also include any status key directly (for example `my_extension`); if another extension sets it via `ctx.ui.setStatus("my_extension", "...")`, it will be rendered in that slot.

### Colors

- `colors` values can be theme tokens (e.g. `muted`, `warning`, `accent`),
  hex colors (e.g. `#8aadf4`), 256 colors (`0`-`255`), or `""` for no color.
- For stateful items (`thinking`, `context`) you can pass an object keyed by state:

```json
{
	"colors": {
		"thinking": {
			"off": "dim",
			"minimal": "muted",
			"low": "warning",
			"medium": "accent",
			"high": "error",
			"xhigh": "error"
		},
		"context": {
			"normal": "muted",
			"warning": "warning",
			"full": "error",
			"default": "muted"
		}
	}
}
```

For unknown states, `default` is used as fallback, then built-in defaults are used.

For `separator`, use `separator` or `separatorColor` to control token separators and their color.

## Development

Tests live in `packages/statusline/test`:

```bash
npm test
```

To try locally:

```bash
pi -e ./packages/statusline
```
