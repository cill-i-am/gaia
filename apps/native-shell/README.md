# Gaia Native Shell

Native SDK desktop shell for the existing Gaia dashboard. This app hosts the
dashboard in a system WebView and leaves run data on the public local Gaia API
used by `LocalGaiaServerApi`.

## Prerequisites

- Install repo dependencies from the workspace root with
  `pnpm install --frozen-lockfile`.
- Install Zig `0.16.0` for direct `zig build ...` workflows and for hosts where
  the Native SDK CLI cannot supply the build toolchain. On this macOS worker,
  the workspace-local CLI can build and test the shell, while `native:doctor`
  still reports `zig` as missing from `PATH`.
- Use the workspace-local Native SDK CLI from this package. Do not install a
  global CLI for Gaia development.

```sh
pnpm --filter @gaia/native-shell native:doctor
```

`native:doctor` validates `app.zon`, WebView availability, signing/notary tools,
and optional platform support. Treat a missing `zig` report as a toolchain setup
warning unless the build or test command also fails.

## Supported Modes

| Mode | Command | Current status |
| --- | --- | --- |
| Manifest/toolchain check | `pnpm --filter @gaia/native-shell check` | Supported. Runs `native doctor --manifest app.zon`. |
| Native shell tests | `pnpm --filter @gaia/native-shell native:test` | Supported. Runs the Native SDK/Zig test loop. |
| Release binary build | `pnpm --filter @gaia/native-shell native:build` | Supported. Produces `apps/native-shell/zig-out/bin/gaia-native-shell`. |
| Dev server shell | `pnpm --filter @gaia/native-shell native:dev` | Supported when the dashboard dev port is free and the local Gaia server is started explicitly. |
| Local package artifact | `pnpm --filter @gaia/native-shell native:package:macos` | Partial. Creates a macOS `.app` artifact after `native:build`, but the artifact does not contain a runnable bundled dashboard until `dist/index.html` exists. |

## Development

Start the local Gaia server separately. The shell does not auto-start a server,
daemonize Gaia, or supervise a background process.

```sh
pnpm gaia server --port 8765
```

If the `gaia` bin is missing immediately after a fresh install, build the server
and CLI once, then retry:

```sh
pnpm --filter @gaia/server build
pnpm --filter @gaia/cli build
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

## Smoke Verification

Run these from a fresh checkout after installing dependencies:

```sh
pnpm --filter @gaia/native-shell check
pnpm --filter @gaia/native-shell native:test
pnpm --filter @gaia/native-shell native:build
```

For the interactive dev path:

```sh
pnpm gaia server --port 8765
pnpm --filter @gaia/native-shell native:dev
```

Expected behavior:

- the native window title says `Local API online` when the server health route
  responds;
- the title says `Local API unavailable` when no local server is running;
- dashboard data still loads through the dashboard's `/gaia-api` proxy and
  `LocalGaiaServerApi`, not through the Native SDK bridge;
- port `3000` conflicts fail loudly because the dashboard dev command uses
  `--strictPort`.

## Native Commands

```sh
pnpm --filter @gaia/native-shell check
pnpm --filter @gaia/native-shell native:build
pnpm --filter @gaia/native-shell native:package:macos
pnpm --filter @gaia/native-shell native:test
```

The package scripts use the workspace-local `@native-sdk/cli`. `native build`
forwards `-D...` options to the underlying Zig build, so platform and web-engine
overrides stay explicit:

```sh
pnpm --filter @gaia/native-shell native:build -- -Dplatform=macos
pnpm --filter @gaia/native-shell native:build -- -Dplatform=macos -Dweb-engine=chromium
```

The generated Zig build defaults `-Dnative-sdk-path` to
`node_modules/@native-sdk/cli` inside this workspace package.

`native:package:macos` is intentionally present as the local packaging
entrypoint, but it is not an accepted production packaging path yet. It calls
Native SDK packaging against `zig-out/bin/gaia-native-shell` and `--assets dist`,
so run `native:build` first. The command can create a macOS `.app` bundle even
when the asset directory is absent, but that artifact is only a shell package. A
runnable bundled dashboard still requires a local `apps/native-shell/dist`
directory containing directly hostable frontend assets, including `index.html`.
Gaia does not currently produce that directory.

If you need to exercise the Zig package step directly, install Zig and run
`zig build package` from `apps/native-shell`. It has the same bundled-dashboard
asset requirement.

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

Bridge payloads are deliberately small. Native SDK caps WebView bridge messages
at 16 KiB and handler results at 12 KiB, which matches Gaia's policy that run
data, graph data, artifacts, activity, health, and streams must stay on the
public HTTP/SSE API.

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

Current local packaging smoke can create
`apps/native-shell/zig-out/package/gaia-native-shell.app`, but inspection shows
`Contents/Resources/dist/index.html` is absent. The narrow future packaging
adapter should produce:

- `apps/native-shell/dist/index.html`;
- all referenced dashboard assets under `apps/native-shell/dist/assets/...`;
- a production API base decision that still uses the public Gaia server API and
  does not read `.gaia` directly from the native app.

Signing, notarized installers, DMGs, auto-updates, mobile packaging, and broad
cross-platform parity are outside this slice.

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

The runtime security policy also adds the configured dashboard origin and local
server origin at startup. Keep those values exact local origins; do not add
wildcards for contributor convenience.

## Web Engines

The shell defaults to the system WebView. On macOS, Native SDK can use Chromium
through CEF when that becomes a real need:

```sh
pnpm --filter @gaia/native-shell exec native cef install
pnpm --filter @gaia/native-shell native:build -- -Dplatform=macos -Dweb-engine=chromium
```

CEF payloads are generated under `apps/native-shell/third_party/cef/` and should
not be committed. Chromium packaging is a later opt-in path, not the default
Gaia contributor workflow.

## Generated Output And Cleanup

The following paths are generated and cleanup-safe:

- `.gaia/`
- `.turbo/`
- `dist/`
- `.zig-cache/`
- `zig-out/`
- `apps/native-shell/third_party/cef/`

Clean native-shell build output with:

```sh
rm -rf apps/native-shell/.zig-cache apps/native-shell/zig-out apps/native-shell/dist apps/native-shell/third_party/cef
```

Clean broader repo-local generated state after smoke testing with:

```sh
find apps packages \
  -path '*/node_modules' -prune -o \
  \( -name .gaia -o -name .turbo -o -name dist -o -name zig-out -o -name .zig-cache -o -path apps/native-shell/third_party/cef \) \
  -type d -prune -exec rm -rf {} +
```

Do not delete `node_modules/` as part of normal native-shell cleanup.
