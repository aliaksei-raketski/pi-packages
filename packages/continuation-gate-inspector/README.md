# @aliaksei-raketski/pi-continuation-gate-inspector

A read-only local Pi inspector for the shared continuation-gate protocol.
It never acquires, releases, renews, persists, or claims producer gates.

Install with:

```sh
pi install npm:@aliaksei-raketski/pi-continuation-gate-inspector
```

Commands:

```text
/gates                 # current-session gates
/gates refresh         # request authoritative producer snapshots
/gates stale           # expired diagnose leases, still blocking
/gates diagnostics     # bounded redacted diagnostics
```

The extension binds the current Pi session on `session_start`, displays
resource and lease details as explicit local diagnostics, and disposes its
registry on shutdown. Telemetry remains redacted and bounded in memory.
