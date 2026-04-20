# Copy Workspace CODEX_HOME Design

## Goal

Expose a dedicated, always-visible sidebar action that copies the workspace-specific `CODEX_HOME` path for the current VS Code window.

## Approved Approach

- Add a new command dedicated to copying `profileManager.getWorkspaceCodexHome()`.
- Surface that command as a `view/title` action on `codexSwitchProfiles` so it is visible without opening a context menu or expanding tree items.
- Keep the existing `copyValue` command unchanged for profile detail rows.

## Behavior

- When the workspace-specific `CODEX_HOME` exists, copy it to the clipboard and show a confirmation message containing the copied path.
- When the current window cannot resolve a workspace-specific `CODEX_HOME`, show a clear error message instead of failing silently.

## Scope

- Manifest command contribution and sidebar title menu entry.
- Command registration in `src/commands/index.ts`.
- Base localization strings for the new command title and runtime messages.
- Focused regression coverage for manifest wiring and command execution.
