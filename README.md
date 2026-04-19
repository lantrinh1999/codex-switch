# Codex Switch

Codex Switch is a VS Code extension
for people who work with more than one Codex account, workspace, or environment.
It keeps named profiles, lets you switch them from the UI,
and syncs the selected profile into the auth file
used by the current Codex runtime.

## Why It Exists

Profile switching is easy in simple setups and fragile in real ones.
Team accounts can share account-level fields across different users.
One user can have multiple workspaces.
SSH sessions can be opened from several local clients to one remote host.

This project focuses on those edge cases.
It tries to avoid false duplicate matches
and keep profile state consistent across clients.

## Quick Start

1. Sign in with Codex CLI in the runtime you actually use.
   If you use WSL from Windows and enabled
   `chatgpt.runCodexInWindowsSubsystemForLinux`, run `wsl codex login`.
1. Run `Codex Switch: Manage Profiles`.
1. Import from current `auth.json` or from a selected JSON file.
1. Switch profiles from the status bar, tooltip links, or the manage command.
1. Use `Renew Token` from the profiles sidebar when you want to rotate saved
   tokens without switching accounts.

## How Switching Works

The status bar shows the current active profile.
Switch behavior is configurable:

* `cycle`: switch through all saved profiles in order.
* `toggleLast`: switch between current and previous profile.
* `bestQuota`: switch to the saved profile with the highest remaining quota.

Trigger behavior is also configurable:

* `click`: switch on a single click.
* `doubleClick`: switch only after a double-click.

After a successful switch,
Codex Switch writes the chosen auth data into the active auth file,
so CLI and extension state stay aligned.

Runtime auth is authoritative.
If `auth.json` changes outside the extension and no saved profile matches it,
the UI shows an external runtime session instead of pretending a saved profile
is still active.

## Auth File Resolution

By default, auth is resolved as `<CODEX_HOME>/auth.json`.
If `CODEX_HOME` is not set, the fallback path is `~/.codex/auth.json`.

On Windows, the extension also checks
`chatgpt.runCodexInWindowsSubsystemForLinux`.
If enabled, it resolves and uses the WSL-side `~/.codex/auth.json` path.
If disabled, it uses the Windows-local path.

This prevents importing from one environment and switching in another.

## Profile Matching

Duplicate detection is identity-first.
When available, it matches by user identity fields from auth payloads:
`chatgptUserId`, `userId`, and JWT `sub`.

If identity fields are missing, matching falls back to combinations of
`email`, `accountId`, and default organization/workspace id when present.
If organization id exists only on one side,
profiles are treated as distinct to avoid accidental collapse.

## Storage Modes

`codexSwitch.storageMode` controls where profile data is stored:

* `secretStorage`: tokens are stored in VS Code SecretStorage.
* `remoteFiles`: tokens are stored in a shared remote filesystem location.
* `auto`: uses `remoteFiles` in SSH remote sessions, otherwise
  `secretStorage`.

In `remoteFiles` mode, data lives under `~/.codex-switch/`:

* `profiles.json` stores profile metadata.
* `profiles/<profile-id>.json` stores per-profile auth payloads.
* `active-profile.json` stores shared active-profile state.

Directories are created with `0700`, files with `0600`.

In `secretStorage` mode, profile metadata is still stored in a local
`profiles.json` file under VS Code global storage,
while credentials stay in SecretStorage.

## Runtime Truth

The extension reconciles the current runtime auth file on every refresh.
That runtime state is shown as one of:

* a saved profile match,
* an external/unsaved auth session,
* or no runtime auth.

This avoids the old failure mode where the status bar showed one profile
while Codex was actually using different auth from `auth.json`.

## Runtime Auth Behavior

The current VS Code window uses the runtime auth file that Codex already has
access to, and that runtime file is the source of truth.

In `remoteFiles` mode, `active-profile.json` is only an advisory marker.
If `auth.json` and the marker disagree, `auth.json` wins.

## Recovery

If profile metadata exists but stored auth data is missing,
the extension offers recovery options:

* recover from remote store data (when available),
* import from current `auth.json`,
* or delete the broken profile.

## Configuration

Main settings:

* `codexSwitch.debugLogging`
* `codexSwitch.storageMode` (`auto`, `secretStorage`, `remoteFiles`)
* `codexSwitch.reloadWindowAfterProfileSwitch`
* `codexSwitch.statusBarClickBehavior` (`cycle`, `toggleLast`, or `bestQuota`)
* `codexSwitch.statusBarSwitchTrigger` (`click` or `doubleClick`)
* `codexSwitch.autoRenewTokens`
* `codexSwitch.tokenAutoRenewIntervalMinutes`
* `codexSwitch.quotaRefreshInterval`

The profiles sidebar starts collapsed by default and keeps your expand/collapse
state while health data refreshes. Token auto-renew runs independently from
quota refresh and defaults to every 60 minutes for all saved profiles.

## Security Notes

For local single-client use, `secretStorage` is the safer default.
Use `remoteFiles` only on trusted SSH hosts
where shared profile state is expected.

Sync writes `auth.json` via a temp-file-and-replace flow
to reduce partial write risk.
The extension does not create rotated backup files like `auth.json.bak.*`.
