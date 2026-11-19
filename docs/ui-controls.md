# UI controls: names, ids and classes

This file exists so a person and an agent can name the same thing. See also
[AGENTS.md](../AGENTS.md) → _Naming a control_.

Every control in the chat UI has **one human name** — the text of its hover tooltip and its
`aria-label` — and that name is also its DOM **`id`**:

| You say                      | The screen shows            | The DOM carries              |
| ---------------------------- | --------------------------- | ---------------------------- |
| "the **Pi packages** button" | `Pi packages` on hover      | `id="pi-packages"`           |
| "#preferences-menu"          | the gear in the top bar     | `id="preferences-menu"`      |
| "`ctl-stop-command`"         | the terminal icon on a card | `class="… ctl-stop-command"` |

So: quote the tooltip, or quote the id. `rg -x '\s*id="preferences-menu"'` (or just
`rg 'preferences-menu'`) lands on the JSX that owns it.

The rules live in code in [`webview/src/utils/control-id.ts`](../webview/src/utils/control-id.ts)
and are enforced by `webview/src/utils/control-id.test.ts`: **a literal `id` may appear exactly once
in `webview/src`.**

- **One per surface** (a toolbar button, a dialog's own buttons, a menu) → literal `id`, kebab-case of
  its name. A dialog's controls are prefixed with the dialog (`packages-cancel`, `permission-allow`) so
  two open dialogs can never collide; the persistent chrome uses a bare name (`send`, `new-chat`).
- **Repeated** (one per transcript entry, tool card, list row, image tile) → no `id`, only its
  `className`. A control that had none gets one prefixed `ctl-` (`ctl-card-copy`, `ctl-stop-command`).
- **Menu items** get their id from the menu's id plus the slug of the item's label
  (`#preferences-menu-privacy-mode`, `#card-menu-omit-from-context`), so an item is addressable too.
  An item whose _label_ changes shape carries an explicit `id` instead — see "Privacy mode".

## Topbar

| Name (hover text)                         | `id`                                                                                     | File                                         |
| ----------------------------------------- | ---------------------------------------------------------------------------------------- | -------------------------------------------- |
| Amulet logo (session name)                | `amulet-logo`                                                                            | `topbar/topbar-left/header-left.tsx`         |
| Previous / Next prompt                    | `previous-prompt`, `next-prompt`                                                         | `topbar/topbar-left/header-left.tsx`         |
| Prompt navigator (session title)          | `turn-nav`                                                                               | `topbar/topbar-left/header-left.tsx`         |
| Its right-click menu                      | `turn-nav-menu` → `turn-nav-menu-copy-prompt`, `-branch-from-here`, `-copy-conversation` | same                                         |
| Pi packages                               | `pi-packages`                                                                            | `topbar/topbar-right/header-right.tsx`       |
| **Preferences** (the settings menu, gear) | `preferences-menu`                                                                       | `topbar/settings-menu/settings-dropdown.tsx` |
| Open chat in editor                       | `open-chat-in-editor`                                                                    | `topbar/topbar-right/header-right.tsx`       |
| Session history                           | `session-history`                                                                        | `session-dd/session-dropdown.tsx`            |
| New chat                                  | `new-chat`                                                                               | `topbar/topbar-right/header-right.tsx`       |

### `#preferences-menu` items

`SettingsMenu` is the gear in the top-right; every row below is
`#preferences-menu-<slug>` (e.g. `#preferences-menu-privacy-mode`):

Submit Feedback · Log in to provider · Open Pi folder · Force update Pi · Reload Pi config ·
Show session info · Privacy mode · Reduced motion · Uncollapse thinking · Line breaks ·
Sticky approval alerts · Click to focus · Auto compact · Export chat · Changelog · Settings

## Composer (input bar)

| Name                      | `id`                   | File                                                  |
| ------------------------- | ---------------------- | ----------------------------------------------------- |
| Message field             | `composer-input`       | `input-bar/input-bar/composer.tsx`                    |
| Attach files              | `attach-files`         | `input-bar/input-bar/composer.tsx`                    |
| Stop / Send               | `stop`, `send`         | `input-bar/input-bar/composer.tsx`                    |
| Context usage meter       | `context-usage`        | `input-bar/ctx-meter/context-stats.tsx`               |
| └ Compact conversation    | `compact-conversation` | same                                                  |
| Compaction history        | `compaction-history`   | `input-bar/compaction-history/compaction-history.tsx` |
| Extension commands        | `extension-commands`   | `input-bar/extension-commands/extension-commands.tsx` |
| Model picker              | `model-picker`         | `input-bar/model-picker/model-dropdown.tsx`           |
| └ its right-click menu    | `model-picker-menu`    | same                                                  |
| Log in (no models yet)    | `provider-login`       | `input-bar/model-picker/model-dropdown.tsx`           |
| Thinking level            | `thinking-level`       | `input-bar/reasoning-select/thinking-dropdown.tsx`    |
| Slash-command palette     | `slash-command-menu`   | `input-bar/cmd-menu/slash-command-menu.tsx`           |
| `@` project-files palette | `file-menu`            | `input-bar/file-menu/file-menu.tsx`                   |

## Transcript

| Name                               | selector                                                                                                     | File                                                 |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------- |
| Conversation scroll host           | `#chat-log`                                                                                                  | `entry-list/message-list.tsx`                        |
| Card overflow menu                 | `#card-menu` → `#card-menu-omit-from-context`, `#card-menu-edit-context-content`, `#card-menu-show-it-again` | `exec-view/tool-call-view.tsx`                       |
| Card context trigger               | `.exec-ctx-trigger`                                                                                          | `exec-view/tool-call-view.tsx`                       |
| Copy on a card                     | `.ctl-card-copy`                                                                                             | `exec-view/tool-call-view.tsx`                       |
| Copy one nested call               | `.ctl-row-copy`                                                                                              | `exec-view/subagent-calls/subagent-calls.tsx`        |
| Open a subagent transcript         | `.ctl-subagent-log`                                                                                          | same                                                 |
| Stop this command                  | `.ctl-stop-command`                                                                                          | `exec-view/stop-actions/stop-actions.tsx`            |
| Stop this command with reason…     | `.ctl-stop-with-reason`                                                                                      | same                                                 |
| Abort this turn                    | `.ctl-abort-turn`                                                                                            | same                                                 |
| Right-click menu of the transcript | `#transcript-menu` → `#transcript-menu-quote`, `#transcript-menu-branch-from-here`, …                        | `entry-list/transcript-menu.tsx`                     |
| Cancel a running compaction        | `#cancel-compaction`                                                                                         | `entry-list/compaction-card/compaction-progress.tsx` |

## Dialogs and overlays

| Dialog                    | File                                                              | Ids                                                                                                                                                                                                                        |
| ------------------------- | ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pi packages               | `ui/packages-dialog/`                                             | `packages-refresh`, `packages-install-toggle`, `packages-close`, `packages-cancel`, `packages-reload`, `packages-filter`, `packages-install*`, `packages-browse-gallery`, `packages-open-gallery`; rows: `.pk-row-remove*` |
| Provider login            | `ui/auth-dialog/provider-login-dialog.tsx`                        | `provider-login-*` (`-close`, `-use-subscription`, `-use-api-key`, `-save-key`, `-transport-*`, `-ghe-*`, `-done`, `-try-again`, `-error-close`)                                                                           |
| Session info              | `ui/session-info-dialog/`                                         | `session-info-refresh`, `session-info-copy`, `session-info-close`                                                                                                                                                          |
| pi approval (`pi-gate`)   | `ui/permission-prompt/`                                           | `permission-allow`, `permission-deny`, `permission-send`, `permission-answer-field`, `permission-editor-*`, `permission-copy`, `permission-close`                                                                          |
| Reason (Stop with reason) | `ui/reason-dialog/`                                               | `reason-note`, `reason-cancel`, `reason-confirm`, `reason-close`                                                                                                                                                           |
| Prompt / skill insert     | `ui/prompt-dialog/`                                               | `prompt-insert`, `prompt-cancel`, `prompt-close`                                                                                                                                                                           |
| Edit context content      | `ui/context-editor-dialog/`                                       | `context-editor-text`, `context-editor-apply`, `context-editor-cancel`, `context-editor-close`                                                                                                                             |
| Compaction summary        | `ui/compaction-dialog/`                                           | `compaction-copy`, `compaction-close`                                                                                                                                                                                      |
| Generic confirm           | `ui/modal/confirm-dialog.tsx`                                     | `modal-confirm`, `modal-cancel`                                                                                                                                                                                            |
| Find in conversation      | `chat-find/`                                                      | `chat-find-input`, `-case`, `-regex`, `-previous`, `-next`, `-close`                                                                                                                                                       |
| Undo-revert / fork banner | `app-shell.tsx`                                                   | `undo-revert`, `undo-revert-keep`, `fork-cancel`                                                                                                                                                                           |
| Crash screen              | `error-boundary.tsx`                                              | `crash-try-again`                                                                                                                                                                                                          |
| Session list / grid       | `session-dd/session-list.tsx`, `session-grid/recent-sessions.tsx` | `start-page`, `delete-all-sessions`, `recent-sessions`; rows: `.session-dd-row*`, `.session-grid-row*`                                                                                                                     |
