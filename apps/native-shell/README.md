# Gaia Native Shell

Native SDK desktop shell for the existing Gaia dashboard. This app hosts the
dashboard in a system WebView and leaves run data on the public local Gaia API
used by `LocalGaiaServerApi`.

## Prerequisites

- Install repo dependencies from the workspace root with `pnpm install`.
- Install Zig `0.16.0` before running native build, test, or launch commands.
- Use the workspace-local Native SDK CLI from this package. Do not install a
  global CLI for Gaia development.

```sh
pnpm --filter @gaia/native-shell native:doctor
```

`native:doctor` validates `app.zon` and platform support. It can report a
missing Zig toolchain while still validating the manifest.

## Development

Start the local Gaia server separately. The shell does not auto-start a server,
daemonize Gaia, or supervise a background process.

```sh
pnpm gaia server --port 8765
```

Launch the Native SDK shell and dashboard dev server:

```sh
pnpm --filter @gaia/native-shell native:dev
```

The Native SDK dev flow reads `app.zon`, starts
`pnpm --filter @gaia/dashboard dev -- --strictPort`, waits for
`http://127.0.0.1:3000/`, and launches the native WebView with
`NATIVE_SDK_FRONTEND_URL`. If port 3000 is occupied, the shell dev flow fails
instead of silently attaching to the wrong dashboard URL.

At launch, the shell performs one explicit health check against the configured
local Gaia server and exposes the result in native window chrome:
`Local API online` or `Local API unavailable`. The shell does not retry in the
background; start or restart the server explicitly, then relaunch the shell or
use the dashboard's own refresh affordance.

The status check defaults to `http://127.0.0.1:8765/health`. Override the
checked server with `GAIA_NATIVE_SERVER_URL`, or with `VITE_GAIA_SERVER_URL`
when matching the dashboard dev proxy target. The dashboard itself continues to
call Gaia through `/gaia-api`, which the dashboard dev server proxies to
`http://127.0.0.1:8765`.

## Native Commands

```sh
pnpm --filter @gaia/native-shell check
pnpm --filter @gaia/native-shell native:build
pnpm --filter @gaia/native-shell native:test
```

The package scripts use the workspace-local `@native-sdk/cli`. The generated
Zig build also defaults `-Dnative-sdk-path` to `node_modules/@native-sdk/cli`
inside this workspace package.

## Desktop Chrome And Bridge

The shell declares a small desktop command catalog in `app.zon`:

- `gaia.focus-dashboard` focuses the dashboard window.
- `gaia.show-native-status` opens a native status dialog when the current
  platform supports message dialogs. Unsupported hosts report the Native SDK
  error name in the bridge status instead of silently pretending success.

The same command ids are available from the native Gaia menu and app-level
shortcuts. The bridge exposes one app-defined status command:

```js
await window.zero.invoke("gaia.native.status", {});
```

That command returns only small JSON-safe shell metadata: platform, web engine,
the native command catalog, whether Gaia data crosses the bridge, and the last
native command event. Gaia run data, graph data, artifacts, activity, health,
and streams stay on `LocalGaiaServerApi`.

The built-in bridge policy is default-deny and explicitly allows only:

- `native-sdk.command.invoke`
- `native-sdk.command.list`
- `native-sdk.platform.supports`

Filesystem, OS URL/path, clipboard, credentials, and dialog built-ins are not
available through the bridge.

## Static Assets Status

Native SDK requires `frontend.dist` to be a local manifest-relative asset
directory. The manifest currently names `dist` as the future package asset
directory, but GAIA-78 does not populate it.

Gaia's current TanStack Start dashboard build is not a plain static bundle. As
of this slice, `pnpm --filter @gaia/dashboard build` emits:

- `apps/dashboard/dist/client/assets/*`
- `apps/dashboard/dist/server/server.js`

It does not emit `apps/dashboard/dist/client/index.html`, and Native SDK also
rejects `..` segments in `frontend.dist`, so the shell cannot honestly claim
production bundled-dashboard packaging yet. GAIA-78 therefore uses the
dev/server-backed path. A later packaging slice can add a TanStack adapter,
static export, or explicit asset-copy step when that is an explicit
requirement.

## Security Boundary

This app declares WebView, JavaScript bridge, menu, shortcut, and dialog
capabilities for the narrow desktop shell affordances above. It does not read
`.gaia`, does not expose broad filesystem or OS bridge commands, and does not
introduce a server lifecycle manager.

Allowed navigation origins are intentionally narrow:

- `zero://app`
- `zero://inline`
- `http://127.0.0.1:3000`
- `http://localhost:3000`
- the configured dashboard origin
- the configured local server origin

External links are denied by default.

## Web Engines

The shell defaults to the system WebView. On macOS, Native SDK can use Chromium
through CEF when that becomes a real need:

```sh
pnpm --filter @gaia/native-shell exec native cef install
pnpm --filter @gaia/native-shell native:build -- -Dplatform=macos -Dweb-engine=chromium
```
