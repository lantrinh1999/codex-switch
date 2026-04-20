# Workspace-Specific CODEX_HOME Toggle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a default-on workspace-specific `CODEX_HOME` toggle that is controllable from Settings and the Profiles panel.

**Architecture:** Make `ProfileManager` treat workspace-specific `CODEX_HOME` as a configuration-driven runtime mode, then let extension activation react live to config changes by swapping the process environment and rebuilding file watchers. Surface the mode in the panel with explicit enable/disable actions and keep copy-path visible only while the mode is on.

**Tech Stack:** TypeScript, VS Code extension API, node:test

---

### Task 1: Add The Setting And Runtime Switch

**Files:**
- Modify: `package.json`
- Modify: `package.nls.json`
- Modify: `src/auth/profile-manager.ts`
- Modify: `src/extension.ts`

- [ ] Add `codexSwitch.workspaceSpecificCodexHome` as a default-on setting and read it from runtime path resolution.
- [ ] Apply or restore `CODEX_HOME` live during activation and on relevant config changes.
- [ ] Rebuild auth file watchers whenever the runtime auth path source changes.

### Task 2: Add Panel Controls

**Files:**
- Modify: `package.json`
- Modify: `src/commands/index.ts`
- Modify: `l10n/bundle.l10n.json`

- [ ] Contribute explicit enable/disable commands in the Profiles view header.
- [ ] Persist panel toggles back into the workspace setting.
- [ ] Hide the copy-path action unless workspace-specific mode is enabled.

### Task 3: Add Regression Coverage

**Files:**
- Modify: `test/packageManifest.test.js`
- Modify: `test/sidebarIntegration.test.js`
- Modify: `test/extensionActivation.test.js`

- [ ] Assert the new setting contribution and the view-title command wiring.
- [ ] Verify panel commands update the setting and keep copy-path behavior consistent.
- [ ] Verify activation/config changes switch the runtime `CODEX_HOME` environment live.
