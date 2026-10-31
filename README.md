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

Amulet brings the [Pi coding agent](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) into VS Code and VSCodium as a focused chat sidebar. It spawns an external `pi` runtime and speaks its JSON-lines RPC protocol — streaming rich tool output and thinking, keeping session history and usage stats, and giving you model and reasoning controls, message forking, edit/write diffs, slash-command autocomplete, quick-find in the conversation (Ctrl+F), a full editor-tab chat, and HTML export.

The `pi` runtime is not bundled: install and authenticate it once, and Amulet drives it from inside the editor.

For more information, visit the [repository](https://github.com/gunir/vsix-amulet2).

<div align="center">

<img alt="Amulet screenshot" src="media/screenshot.png" width="100%">

</div>

## Issues

Found a bug or have a feature request? Please open an issue on [GitHub](https://github.com/gunir/vsix-amulet2/issues).

## License

Amulet is released under the MIT License. It embeds the MIT-licensed [`pi` coding agent](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) through its documented RPC interface.
