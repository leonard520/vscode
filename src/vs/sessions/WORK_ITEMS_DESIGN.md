# Work Items Feature — Implemented Design Snapshot

> **Status**: Implemented
> **Scope**: Agents Window (`src/vs/sessions/`)
> **Last Updated**: 2026-04-28

---

## Table of Contents

1. [Overview](#1-overview)
2. [Implemented Architecture](#2-implemented-architecture)
3. [Module Map](#3-module-map)
4. [Data Model and Persistence](#4-data-model-and-persistence)
5. [Service Behavior](#5-service-behavior)
6. [UI Integration](#6-ui-integration)
7. [GitHub Integration](#7-github-integration)
8. [Session Restore and Reconciliation](#8-session-restore-and-reconciliation)
9. [Notable Differences from the Initial Draft](#9-notable-differences-from-the-initial-draft)
10. [Revision History](#10-revision-history)

---

## 1. Overview

The Agents Window now ships with a work-item-centric workflow. A work item is the durable unit the sidebar manages, while agent sessions remain the durable conversation primitive owned by the sessions subsystem.

The implemented feature has three primary goals:

- Replace the sidebar's session-first list with a work-items view organized by priority and status.
- Allow a single work item to own multiple agent sessions, including archived history.
- Keep the rest of the Agents Window aligned with the selected work item, especially the chat header, session tabs, titlebar label, and workspace context.

This document describes the code that exists today. It is not a proposal.

---

## 2. Implemented Architecture

### 2.1 Runtime layout

```
┌──────────┬─────────────────────────────────────────────┬──────────────────┐
│ Sidebar  │ Chat Bar                                    │ Auxiliary Bar    │
│          │                                             │                  │
│ Work     │ Chat composite strip                        │ Changes / Files  │
│ Items    │ Session tab bar (when multi-session)        │ and other views  │
│ View     │ Active chat view or New Session view        │                  │
└──────────┴─────────────────────────────────────────────┴──────────────────┘
```

The work-items system spans four layers inside `vs/sessions`:

- A persisted service layer under `services/workItems/`.
- Sidebar UI under `contrib/workItems/browser/`.
- Chat/title/workspace integrations in existing sessions contributions.
- GitHub-backed configuration and issue actions wired through the work-item menus.

### 2.2 Ownership model

The implementation keeps `ISession` and `ISessionsManagementService` as the canonical session system. `IWorkItemService` adds a second, independent ownership model on top:

- `WorkItemService` stores work-item metadata plus a list of owned session IDs.
- The active work item is observable and drives sidebar selection, chat alignment, workspace fallback, and title rendering.
- Session replacement and late provider restore are handled inside `WorkItemService` so the rest of the UI can consume resolved `IWorkItem.sessions` directly.

This means the work-item feature is an orchestration layer, not a fork of the sessions subsystem.

---

## 3. Module Map

### 3.1 Services

| File | Responsibility |
|------|----------------|
| `services/workItems/common/workItem.ts` | Shared enums and interfaces for persisted and reactive work-item models |
| `services/workItems/common/workItemService.ts` | `IWorkItemService` contract for CRUD, active selection, and session association |
| `services/workItems/browser/workItemService.ts` | Stateful implementation, persistence, context keys, restore, and session reconciliation |
| `services/workItems/common/githubConfig.ts` | `IWorkItemGitHubConfigService` contract for configured GitHub repositories |
| `services/workItems/browser/githubConfigService.ts` | Profile-scoped GitHub repository configuration backed by storage and `IGitHubService` |

### 3.2 Sidebar work-items UI

| File | Responsibility |
|------|----------------|
| `contrib/workItems/browser/workItems.contribution.ts` | Registers the sidebar container and default Work Items view |
| `contrib/workItems/browser/workItemsView.ts` | `FilterViewPane` wrapper, filter widget, and badge updates |
| `contrib/workItems/browser/workItemsList.ts` | Tree rendering, section grouping, filter logic, context menus, drag-and-drop, and row affordances |
| `contrib/workItems/browser/workItemsActions.ts` | Command surface for create/edit/delete, GitHub linking, working directory, status, priority, and new session |
| `contrib/workItems/browser/sessionTabBar.ts` | Horizontal per-work-item session tab strip shown above chat content |

### 3.3 Cross-feature integrations

| File | Responsibility |
|------|----------------|
| `browser/parts/chatBarPart.ts` | Inserts the session tab bar into the chat bar and relayouts when it appears or hides |
| `contrib/chat/browser/newChatViewPane.ts` | Shows the work-item title in the new-session header and demotes the workspace picker to secondary metadata |
| `contrib/chat/browser/sessionWorkspacePicker.ts` | Uses the active work-item title in the picker ARIA label |
| `contrib/sessions/browser/sessionsTitleBarWidget.ts` | Prefers the active work-item title over the active session title |
| `contrib/workspace/browser/workspaceFolderManagement.ts` | Falls back to `activeWorkItem.workingDirectory` when the active session has not resolved a workspace |
| `common/contextkeys.ts` | Declares work-item context keys consumed by menus and overlays |
| `browser/menus.ts` | Declares work-item-specific menu IDs |

### 3.4 Tests that anchor behavior

The current implementation is exercised by targeted tests under:

- `services/workItems/test/browser/workItemService.test.ts`
- `contrib/workItems/test/browser/sessionTabBar.test.ts`
- `contrib/workItems/test/browser/workItemsList.test.ts`
- `contrib/chat/test/browser/newChatViewPane.test.ts`
- `contrib/chat/test/browser/sessionWorkspacePicker.test.ts`
- `contrib/sessions/test/browser/sessionsTitleBarWidget.test.ts`
- `contrib/workspace/test/browser/workspaceFolderManagement.test.ts`

---

## 4. Data Model and Persistence

### 4.1 Core model

`IWorkItemData` is the serialized profile-scoped record. It contains:

- Stable metadata: `id`, `title`, `description`, `status`, `priority`, `labels`, `linkedIssue`, `workingDirectory`, `createdAt`, `updatedAt`.
- Session ownership: `sessionIds`.
- Session restore preference: `activeSessionId`.

`IWorkItem` is the reactive model the UI consumes. It exposes observables for all mutable fields and resolves `sessionIds` into `sessions: IObservable<readonly ISession[]>`.

### 4.2 Storage keys

The browser implementation persists to profile storage:

| Key | Meaning |
|-----|---------|
| `workItems.data` | Serialized `IWorkItemData[]` |
| `workItems.activeId` | Active work-item ID |
| `workItems.githubRepos` | Configured GitHub repositories for issue linking/creation |

### 4.3 Session identity rules

Work items do not duplicate session payloads. They retain only identity and preference information:

- `sessionIds` tracks every owned session, including historical IDs that may still need reconciliation.
- `activeSessionId` records the history tab the user explicitly chose for that work item.
- `sessions` is rebuilt by joining `sessionIds` against `ISessionsManagementService.getSessions()` and an internal pending-session map.

This design allows the work-item layer to survive session replacement while leaving actual transcript and provider state in the sessions subsystem.

---

## 5. Service Behavior

### 5.1 Public service surface

`IWorkItemService` currently supports:

- CRUD for work items.
- `activeWorkItem` as an observable selection source.
- Explicit session association via `addSession` and `removeSession`.
- Per-work-item preferred-history tracking via `setPreferredSessionForWorkItem`.
- Work-item-scoped session creation via `createSessionForWorkItem`.

### 5.2 Active work item as the orchestration source

The implemented behavior treats the selected work item as a major UI driver:

- Sidebar selection mirrors `activeWorkItem`.
- Context keys are rebound from the active work item's linked issue, working directory, status, priority, and session count.
- Chat restoration logic may reopen the work item's preferred session if the global active session drifts.
- Titlebar and new-session UI read the active work-item title directly.

### 5.3 Context keys

The service binds these keys in `common/contextkeys.ts`:

- `workItem.hasActive`
- `workItem.hasLinkedIssue`
- `workItem.hasWorkingDirectory`
- `workItem.status`
- `workItem.priority`
- `workItem.sessionCount`

These keys power toolbar items, context-menu enablement, and row-scoped overlays in the list.

### 5.4 Work-item-scoped session creation

`createSessionForWorkItem`:

1. Ensures the requested work item is active.
2. Reads the current provider from `ISessionsManagementService.activeProviderId`.
3. Uses the work item's `workingDirectory` when available, otherwise creates an untitled workspace URI.
4. Calls `createNewSession` on the sessions service.
5. Adds the new session to a pending-session map and associates its ID with the work item immediately.

This preserves tab-strip responsiveness before the provider-backed session fully resolves.

---

## 6. UI Integration

### 6.1 Sidebar container and view

The sidebar contribution is fully implemented:

- Container ID: `agentic.workbench.view.workItemsContainer`
- View ID: `sessions.workbench.view.workItemsView`
- Default location: sidebar, enabled only for the Sessions window
- Title menu: `Menus.WorkItemsViewTitle`
- Open command: `Cmd/Ctrl+Shift+W`

The work-items view is a `FilterViewPane`, not a bespoke custom pane. Filtering is built into the standard viewpane filter widget.

### 6.2 Work-items list behavior

`WorkItemsList` renders a `WorkbenchObjectTree` with these concrete behaviors:

- Sections: `Focus`, `Up Next`, `Backlog`, `Closed`.
- Sorting: newest `updatedAt` first within each section.
- Filtering: title, labels, status, priority, and linked-issue owner/repo/number.
- Selection: clicking a row activates the work item.
- Context menu: uses overlay context keys derived from the clicked row.
- Drag-and-drop: moving onto a priority section reprioritizes; moving into `Closed` closes the item; dropping a closed item into an active section reopens it.

Each row shows the current implemented affordances:

- Status icon.
- Work-item title.
- Toolbar from `Menus.WorkItemToolbar`.
- Linked issue badge.
- Session count summary.
- Working-directory basename.
- Up to two labels plus overflow badge.
- Relative updated time.
- Hover with work-item description.
- Unread dot when any owned session is unread.

### 6.3 Session tab bar

`SessionTabBar` is now part of `ChatBarPart`. It is not a standalone picker control in the center pane body.

Implemented behavior:

- Hidden when there is no active work item.
- Hidden when there are fewer than two visible sessions and no archived sessions.
- Shown when the active work item owns multiple non-archived sessions, or when archived sessions exist and can be toggled into view.
- Supports creating a new session from the trailing add button.
- Supports archiving and restoring sessions inline.
- Persists tab choice by calling `setPreferredSessionForWorkItem` before opening the clicked session.

`ChatBarPart` reserves vertical space for this tab bar and relayouts whenever its visibility changes.

### 6.4 New-session header

`newChatViewPane.ts` now makes work items visible in the new-session composition flow:

- If no work item is active, the header keeps the workspace-first messaging.
- If a work item is active, its title becomes the primary header label.
- If both a work item and a workspace are present, the workspace picker is rendered as secondary metadata rather than being fused into the title.

This keeps the work item visually dominant while still exposing where the next session will run.

### 6.5 Titlebar label

`SessionsTitleBarWidget` now resolves its label by preference order:

1. Active work-item title
2. Active session title
3. `"New Session"`

The titlebar therefore remains aligned with the selected work item even while provider session titles change underneath it.

### 6.6 Workspace fallback

`WorkspaceFolderManagementContribution` uses the active session workspace when available, but falls back to `activeWorkItem.workingDirectory` when session workspace metadata has not resolved yet.

This is important during restore and early new-session flows because workspace-scoped UI should still show the selected work item's directory.

---

## 7. GitHub Integration

The GitHub portion of the feature is implemented as action-driven enhancement, not as a dedicated sidebar sub-system.

### 7.1 Configured repositories

`WorkItemGitHubConfigService` persists a list of configured repositories and validates additions through `IGitHubService`.

### 7.2 Supported actions

`workItemsActions.ts` currently provides:

- Create work item
- Edit work item metadata
- Close / reopen work item
- Change priority
- Set working directory
- Link an existing GitHub issue
- Create a GitHub issue from the work item
- Open the linked issue in the browser
- Create a new agent session for the work item
- Delete work item
- Configure GitHub repositories

### 7.3 Synchronization behavior

When linking or creating an issue, the implementation updates the work item directly with GitHub-derived fields:

- `title`
- `description`
- `labels`
- `status`
- `linkedIssue`

Closing or reopening a linked work item also propagates the issue state back through `IGitHubService.updateIssue`.

---

## 8. Session Restore and Reconciliation

This is the most important area where the current implementation diverges from the initial draft.

### 8.1 Pending-session tracking

Freshly created sessions are inserted into `_pendingSessions` immediately so the work item can reference them before the provider settles or replaces the temporary session.

### 8.2 Replacement handling

When `ISessionsManagementService.onDidReplaceSession` fires, `WorkItemService`:

- Rewrites owned session IDs from the temporary ID to the committed ID.
- Preserves `activeSessionId` when the replaced session was preferred.
- Re-resolves `IWorkItem.sessions`.
- Persists the updated work-item records.

### 8.3 Startup restore alignment

When persisted work items load before provider sessions arrive, the service later realigns them by:

- Resolving exact session ID matches first.
- Reconciling legacy untitled session IDs against committed sessions using a binding key derived from the session ID prefix.
- Restricting reconciliation to sessions in the same working directory.
- Refusing to attach a candidate session that is already owned by another work item.

### 8.4 Preferred-session reopening

If the active work item owns sessions but the globally active session is not one of them, `WorkItemService` reopens the work item's preferred session unless the UI is explicitly in the global new-session state (`IsNewChatSessionContext`).

This preserves two distinct behaviors:

- Normal work-item browsing should snap back to that work item's chosen history.
- The explicit `New Session` flow may temporarily diverge from work-item history.

### 8.5 Active-session remembering

Whenever the active session belongs to the active work item, the service records it as that work item's preferred session. This allows restore to return to the user-selected history tab instead of simply picking the newest session.

---

## 9. Notable Differences from the Initial Draft

The original draft is stale in several important ways. The current implementation differs as follows:

1. The feature is no longer a proposal. The document should describe existing services and UI, not prospective modules.
2. `ISessionsManagementService` was not extended to become work-item-aware. The work-item layer remains additive.
3. The center-pane multi-session experience is implemented as a chat-bar tab strip, including archive/restore behavior, rather than as a generic session picker concept.
4. Restore logic is more sophisticated than the initial draft: it now includes pending-session tracking, replacement migration, preferred-history persistence, and cross-work-item ownership guards.
5. Workspace and title integrations are part of the feature. The selected work item now influences the titlebar label, new-session header, workspace picker accessibility label, and workspace-folder fallback.
6. The sidebar implementation is a grouped tree with filtering, unread state, and drag-and-drop reprioritization, not just a flat list replacement.
7. The earlier reference to auxiliary-bar `CI Checks` is not representative of the current work-item implementation and should not be treated as part of this design.

---

## 10. Revision History

| Date | Author | Notes |
|------|--------|-------|
| 2026-04-24 | Design | Initial design draft |
| 2026-04-28 | Architect | Rewrote the document to match the implemented work-items architecture, restore behavior, and UI integrations in `src/vs/sessions` |

