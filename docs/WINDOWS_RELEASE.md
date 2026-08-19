# Windows release and Authenticode signing

Wealth Atlas Windows releases are prepared with:

```text
npm run release:windows
```

The command always builds the static desktop application, creates the NSIS installer, runs the release checks, generates the SHA-256 file, and prepares the share ZIP and user-facing instructions under the versioned directory `desktop-dist/v<package-version>/`.

## Unsigned readiness

When no signing variables are present, the command deliberately disables certificate auto-discovery and produces an `UNSIGNED` candidate. It must not be described as signed, trusted, or guaranteed safe. Windows SmartScreen and browsers may continue to show an unknown-publisher warning.

## Formal signing

Configure all of these values in the local secure environment before running the release command:

```text
WINDOWS_CERTIFICATE_PATH
WINDOWS_CERTIFICATE_PASSWORD
WINDOWS_TIMESTAMP_URL
WINDOWS_PUBLISHER_NAME
```

- `WINDOWS_CERTIFICATE_PATH` must be an absolute path to a formal `.pfx` or `.p12` Authenticode certificate container.
- `WINDOWS_CERTIFICATE_PASSWORD` must remain in the local secure environment. Do not place it in a command, repository file, README, issue, chat transcript, or build log.
- `WINDOWS_TIMESTAMP_URL` must identify the certificate provider's RFC 3161 timestamp endpoint.
- `WINDOWS_PUBLISHER_NAME` must match the expected certificate subject/publisher.

The release command maps the certificate and password to electron-builder only for the build process. A partial signing configuration fails before packaging. A signed release also fails unless both the application executable and installer report a `Valid` Authenticode signature, the expected publisher, and a timestamp signer.

Run the checks independently with:

```text
npm run release:check
npm run release:test-installed
```

Do not create a release tag until the generated report is reviewed and the user explicitly approves it.

## Local startup diagnostics

Every desktop launch creates these bounded UTF-8 files before the first BrowserWindow loads:

```text
%APPDATA%\Wealth Atlas\logs\main.log
%APPDATA%\Wealth Atlas\logs\renderer.log
%APPDATA%\Wealth Atlas\logs\startup.json
```

They contain application/runtime events and sanitized technical errors only. They are never uploaded and must not contain accounts, balances, transactions, budgets, assets, FX values, or Obsidian content.

Before an app-version update or data migration, the renderer sends the untouched local snapshot to the main process for a local-only backup under `%APPDATA%\Wealth Atlas\backups\<date>-v<app-version>-schema-<schema-version>`. Old backups are never removed automatically.

To collect them on another computer, press `Win + R`, enter `%APPDATA%\Wealth Atlas\logs`, then copy the three files after reproducing the startup error.
### v1.4.4 diagnostic recovery

The startup error page tries the browser clipboard first, then the sandboxed Electron preload bridge. If both are unavailable, it shows a selectable diagnostic text area and can save the same allowlisted technical fields under %APPDATA%\Wealth Atlas\logs\. The saved diagnostic never includes the finance snapshot.

IndexedDB open, blocked, version-change, read, and migration failures remain non-destructive. The application offers retry and backup-location actions; it never performs automatic restore or deletes an older backup. Repeated restarts reuse a verified identical v2 backup created within five minutes instead of creating duplicate folders.
