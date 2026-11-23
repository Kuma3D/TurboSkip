# TurboSkip

A SillyTavern extension that auto-regenerates AI messages until they contain the phrases you require.

Say you want the message to include "I love you" — if the generated message doesn't contain it, TurboSkip regenerates the message and keeps going until the phrase appears (or a max attempt count is reached).

## Features

- **Required phrases** — one per line in the settings panel. The latest AI message must contain them.
- **Match mode** — require *all* phrases, or just *any* one of them.
- **Case sensitivity** toggle.
- **Max regen attempts** — a cap so a never-satisfiable requirement can't regenerate forever (default 3).
- **Toast notifications** when a message is being regenerated, and when TurboSkip gives up.

## How it works

TurboSkip listens for `CHARACTER_MESSAGE_RENDERED`. When the latest AI message renders, it checks the message text against your phrase list. On failure it triggers a regeneration (via the `/regen` slash command — trying both `regen` and `/regen` textual forms since ST builds differ in whether the executor prepends its own slash, with the chat menu's Regenerate action as a final fallback) and re-checks when the regenerated message renders, looping up to the configured attempt limit.

It only inspects the **last AI message**, and never regenerates after a user message arrives mid-loop (the loop aborts). Empty phrase list = no-op.

## Install

Copy this folder into `data/<user-handle>/extensions/TurboSkip` (or install as a system extension under `public/scripts/extensions/third-party/TurboSkip`), then reload SillyTavern and enable it in Extensions.

## Settings

| Setting | Default | Meaning |
|---|---|---|
| Enabled | off | Master switch |
| Required phrases | *(empty)* | One phrase per line |
| Match mode | all | `all` = every phrase required, `any` = at least one |
| Case-sensitive | off | — |
| Max regen attempts | 3 | Cap per message |
| Toast on regen | on | — |

Settings persist in SillyTavern's extension settings and are shared across chats.

## Notes

- Requires a backend generation — regen goes through SillyTavern's normal `/regen` slash command, so API keys, streaming settings, etc. all apply as usual.
- Uses only the public `SillyTavern.getContext()` API (`eventSource`, `extensionSettings`, `executeSlashCommandsWithOptions`), so it should survive ST updates better than imports from `script.js`.