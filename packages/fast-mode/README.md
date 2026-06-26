# Pi Fast Extension

A Pi extension that enables fast mode for supported models with one command and shortcut:

- **`/fast`**: toggles fast mode on/off.
- **`F3`**: toggles fast mode on/off.
- No arguments. `/fast` always toggles.

The current model determines what gets injected:

- **Claude Opus 4.6 / 4.7 / 4.8**
  - Adds `speed: "fast"`
  - Adds required header `anthropic-beta: fast-mode-2026-02-01`
- **OpenAI Codex GPT-5.4 / GPT-5.5**
  - Adds `service_tier: "priority"`
  - Requires ChatGPT/OAuth auth (API-key models are skipped)

## Install

```bash
pi install npm:@aliaksei-raketski/pi-fast-mode
# or project-local
pi install -l npm:@aliaksei-raketski/pi-fast-mode
```

Try locally from this repository:

```bash
pi -e ./packages/fast-mode
```

## Behavior

- Start Pi with fast mode enabled:

```bash
pi --fast
```

- Footer status is always visible as one of:

  - `fast on` (accent color)
  - `fast off` (gray)

When fast mode is enabled but the current model is not supported, status stays as:

- `fast on` in gray (so you can see it is enabled, but inactive for current model)

When you switch to a supported model, fast mode is applied automatically if it is enabled.

The fast mode toggle is stored in the current session, so it survives `/reload`, resume, and branch navigation.