# Runtime Auth Unification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Codex Switch display the active account from runtime auth data everywhere, while activating early enough to isolate workspace-specific `CODEX_HOME` before other Codex consumers snapshot auth state.

**Architecture:** Add one shared profile/runtime identity helper and route all active-account UI surfaces through it. Activate the extension on startup instead of `onStartupFinished`, then cover the behavior with UI and manifest regression tests.

**Tech Stack:** TypeScript, VS Code extension API, node:test

---

### Task 1: Centralize Account Identity Resolution

**Files:**
- Create: `src/profile-labels.ts`
- Modify: `src/auth/profile-manager.ts`
- Modify: `src/health/profile-health.ts`

- [ ] Add helper functions for primary label, alias, and full email resolution from saved profiles and runtime sessions.
- [ ] Replace saved-name-only sorting and warning labels with the shared helper so identity stays stable when aliases drift.

### Task 2: Rewire UI Surfaces To Runtime Identity

**Files:**
- Modify: `src/ui/status-bar.ts`
- Modify: `src/ui/profile-tree.ts`
- Modify: `src/ui/tooltip-builder.ts`
- Modify: `src/commands/index.ts`

- [ ] Update active-account rendering in the status bar, sidebar roots/details, tooltip lists, quick picks, and switch notifications to use the shared helper.
- [ ] Preserve saved profile names as secondary aliases instead of the primary identity.

### Task 3: Strengthen Workspace Isolation Timing

**Files:**
- Modify: `package.json`

- [ ] Change extension activation to eager startup so workspace `CODEX_HOME` is injected before other Codex consumers can cache the global auth path.

### Task 4: Add Regression Tests

**Files:**
- Modify: `test/runtimeSession.test.js`
- Modify: `test/packageManifest.test.js`

- [ ] Add assertions that stale saved aliases no longer override runtime email-derived labels in the status bar and profile tree.
- [ ] Add a manifest assertion that the extension activates eagerly at startup.
