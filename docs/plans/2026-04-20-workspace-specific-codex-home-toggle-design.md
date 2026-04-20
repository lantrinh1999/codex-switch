# Workspace-Specific CODEX_HOME Toggle Design

## Goal

Allow users to turn workspace-specific `CODEX_HOME` isolation on or off from both Settings and the Profiles panel, while keeping the default behavior enabled.

## Approved Behavior

- Add a new boolean setting, `codexSwitch.workspaceSpecificCodexHome`, with default `true`.
- Use that setting to decide whether runtime auth resolves through the workspace storage `.codex` directory or the inherited/shared `CODEX_HOME`.
- Expose panel controls in the `Profiles` view header:
  - `Enable Workspace-Specific CODEX_HOME` when the setting is off.
  - `Disable Workspace-Specific CODEX_HOME` when the setting is on.
  - Keep `Copy Workspace CODEX_HOME` visible only when the setting is on.

## Runtime Rules

- Enabling the setting applies the workspace-specific `CODEX_HOME` immediately and seeds the workspace `auth.json` from the inherited runtime auth path when needed.
- Disabling the setting restores the inherited `CODEX_HOME` environment for the current window immediately.
- File watchers must be recreated when the setting changes so runtime auth refreshes continue to watch the correct path.

## Scope

- Manifest configuration and view-title command contributions.
- Runtime path resolution in `ProfileManager`.
- Activation/config-change environment handling in `extension.ts`.
- Panel commands and focused tests for manifest wiring and live config behavior.
