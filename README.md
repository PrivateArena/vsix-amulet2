<div align="center">

# Amulet

<img alt="Amulet logo" src="media/icon.png" width="80" height="80">

**AI coding agent for VS Code, powered by Pi.**

[github.com/gunir/vsix-amulet2](https://github.com/gunir/vsix-amulet2)

<p align="center">
  <a href="https://github.com/gunir/vsix-amulet2/releases">
    <img src="https://img.shields.io/github/release-date/gunir/vsix-amulet2?label=Release%20Date&display_date=published_at">
 </a>
  <a href="https://github.com/gunir/vsix-amulet2/issues">
    <img src="https://img.shields.io/github/issues/gunir/vsix-amulet2?color=orange" />
  </a>
 <a href="https://github.com/gunir/vsix-amulet2/pulls">
    <img src="https://img.shields.io/github/issues-pr/gunir/vsix-amulet2?color=8B5CF6" />
  </a>
  <a href="https://marketplace.visualstudio.com/items?itemName=gunir.amulet">
    <img src="https://img.shields.io/badge/VS%20Code-Marketplace-0078D4?logo=visualstudiocode">
  </a>
  <a href="https://open-vsx.org/extension/gunir/amulet">
    <img src="https://img.shields.io/badge/Open%20VSX-Registry-C8962E?logo=openvsx">
  </a>
</p>

</div>

## Overview

Amulet brings the [Pi coding agent](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) into VS Code and VSCodium as a focused chat sidebar. It spawns an external `pi` runtime and speaks its JSON-lines RPC protocol — streaming rich tool output and thinking, keeping session history and usage stats, and giving you model and reasoning controls, message forking, edit/write diffs, slash-command and `@` file-path autocomplete, quick-find in the conversation (Ctrl+F), a full editor-tab chat, and HTML export.

The `pi` runtime is not bundled: install and authenticate it once, and Amulet drives it from inside the editor.

### Privacy mode

The chat menu (⚙, in the top-right of the panel) has a **Privacy mode** switch. While it is on, the chat view
rewrites sensitive text before it reaches the screen, so a screenshot, a selection copy, or a Copy button hands
out the censored version:

```jsonc
// .vscode/settings.json — plus one built-in rule: a user name used as a path segment becomes `username`
"amulet.privacyRules": [
  { "search": "/media/jang/home/PortableApp", "replace": "/media/user/home/PortableApp" },
  { "label": "api keys", "pattern": "sk-[A-Za-z0-9]{16,}", "replace": "sk-REDACTED" }
]
```

Each rule needs `replace` and either `search` (literal) or `pattern` (a JavaScript regular expression, matched
globally; `$1` groups work in `replace`). Rules run in order, after the built-ins. Nothing here needs a code
change to cover a new case, and a rule that cannot compile is skipped and named in the Amulet output channel
while the others still apply.

The censoring is a rendering pass, not an edit: the conversation, pi's session file, and every string sent
back to the runtime keep their original text, so **Branch from here**, **Quote**/**Reply** and the tool cards'
file and image reads all still work on the real paths. Only a *partial* selection quoted from a censored block
carries the censored text, because a selection has no source of its own — the same rule the copy menu follows.
Anything outside the chat view (the approval dialogs, the session list, `Amulet: Export chat`) is left alone.

For more information, visit the [repository](https://github.com/gunir/vsix-amulet2).

<div align="center">

<img alt="Amulet screenshot" src="media/screenshot.png" width="100%">

</div>

## Issues

Found a bug or have a feature request? Please open an issue on [GitHub](https://github.com/gunir/vsix-amulet2/issues).

## License

Amulet is released under the MIT License. It embeds the MIT-licensed [`pi` coding agent](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) through its documented RPC interface.
