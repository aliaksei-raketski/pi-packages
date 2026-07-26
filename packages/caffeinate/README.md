# @aliaksei-raketski/pi-caffeinate

Keeps the computer awake while Pi is active, has queued messages, or has pending continuation gates.

## Install

```bash
pi install npm:@aliaksei-raketski/pi-caffeinate
```

The extension supports macOS, Linux, WSL, and Windows. It uses the platform's native inhibitor when available, with Linux fallbacks. If no candidate works, it reports an unavailable status and does not continuously respawn processes.

## Commands

```text
/caffeinate
/caffeinate status
/caffeinate start
/caffeinate stop
/caffeinate enable
/caffeinate disable
/caffeinate display
/caffeinate sleep
/caffeinate quiet on|off
/caffeinate help
```

`stop` is a temporary override. The next agent start, newly acquired continuation gate, or `start` command enables automatic holding again. Menu and notification feedback requires Pi's dialog-capable UI; direct routes still work in print and JSON modes.

## Settings

User settings are stored at `getAgentDir()/pi-caffeinate.json` (normally `~/.pi/pi-caffeinate.json`):

```json
{
  "enabled": true,
  "mode": "display",
  "quiet": false
}
```

Invalid or unreadable files are protected and replaced in memory with defaults. Settings commands will not overwrite a protected file; fix or remove it and reload Pi first. Valid saves preserve unknown fields and use a queued atomic rename. Project-local settings are never read.

## Statusline

When `@aliaksei-raketski/pi-statusline` is installed, the default layout includes a `☕ caffeinate` item. It reports `awake`, `awake · N waiting`, or `caffeinate unavailable` with active, waiting, and error colors. Quiet mode suppresses routine inhibitor start/release notifications only; warnings, command feedback, and structured status remain visible.

Caffeinate observes the continuation-gate protocol but never acquires gates or resumes work. Agent settling does not release the inhibitor while a gate remains. Shutdown always releases processes owned by the current Pi session.
