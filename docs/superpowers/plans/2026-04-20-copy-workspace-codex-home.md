# Copy Workspace CODEX_HOME Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a dedicated sidebar header action that copies the workspace-specific `CODEX_HOME` path for the current window.

**Architecture:** Reuse `ProfileManager.getWorkspaceCodexHome()` as the single source of truth, expose it through a dedicated command, and contribute that command to the profiles view title so it is always visible. Cover both manifest wiring and command execution with focused tests.

**Tech Stack:** TypeScript, VS Code extension API, node:test

---

### Task 1: Contribute The Dedicated Sidebar Action

**Files:**
- Modify: `package.json`
- Modify: `package.nls.json`

- [ ] Add a new command contribution named `codex-switch.profile.copyWorkspaceCodexHome` with a copy icon and localized title.
- [ ] Add the command to the `codexSwitchProfiles` `view/title` menu near the existing management actions so the button is always visible.

### Task 2: Implement Clipboard Copy Behavior

**Files:**
- Modify: `src/commands/index.ts`
- Modify: `l10n/bundle.l10n.json`

- [ ] Register the new command and resolve the path from `profileManager.getWorkspaceCodexHome()`.
- [ ] Write the path to the clipboard and show a confirmation message when available.
- [ ] Show an explicit error message when the current window does not have a workspace-specific `CODEX_HOME`.

### Task 3: Add Regression Coverage

**Files:**
- Modify: `test/packageManifest.test.js`
- Modify: `test/sidebarIntegration.test.js`

- [ ] Assert that the profiles view title menu includes the new command in the expected order and that the command uses the copy icon.
- [ ] Add an integration-style command test that verifies the command copies the workspace-specific `CODEX_HOME` path to the clipboard.
