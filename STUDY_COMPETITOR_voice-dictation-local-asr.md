# Competitive Intelligence — Local Voice Dictation for Agent Prompting

| | |
| --- | --- |
| **Study** | `STUDY_COMPETITOR_voice-dictation-local-asr.md` |
| **Date** | 2026-11-10 |
| **Scope** | Speak-a-prompt (speech-to-text) for Amulet's chat composer; English-first, local/CPU inference, no changes to the `pi` harness |
| **Trigger** | `docs/PENDANT_VOICE_DICTATION_CLEAN_ROOM.md` (clean-room spec of Pendant's voice dictation, derived from pendant.sh/guide/voice) |
| **Method** | `PROJECT_OVERVIEW.md` + primary sources (VS Code source, vscode-docs, vendor docs, npm/HF metadata) + vendor-artifact inspection (file listing of Pendant's shipped `dist/voice/`) — no code was read from the competing extension |

Confidence labels: **[V]** verified against a primary source (URL given) · **[U]** unverified / secondhand · **[H]** hypothesis needing a spike.

---

## 1. Executive Summary & Our Specialization

**Amulet** (`gunir.amulet`) embeds the external `pi --mode rpc` coding agent in VS Code as a React chat sidebar **and** editor-tab panels. Its distinguishing properties, all of which bear on this feature:

| Our architectural trait | Why it matters for voice |
| --- | --- |
| **RPC client, not SDK host.** We bridge the child's JSON-lines stdio; we do not embed pi. | We cannot reach inside the child for a mic (Pendant can, because it embeds the SDK and pipes real pi-tui frames into xterm.js). Voice must live entirely on our side of the wire. |
| **Pure-TypeScript distribution: 1.5 MB `.vsix`, zero native binaries.** | This is our main cost advantage over Pendant's approach and the thing a voice feature threatens most. |
| **Two surfaces (sidebar + N editor tabs) sharing one `PiRuntime` per cwd.** | Recording state is per-runtime but the *composer* is per-surface — same ownership problem Amulet already solved for dialogs and context-edit badges. |
| **Prompt-cache discipline is load-bearing** (session resume, no tool/prompt-section registration, model pinned only on fresh sessions). | A voice feature must add **zero** bytes to the provider prefix. Anything that "describes the audio" into the system prompt is cache-hostile and out of scope. |
| **Privacy is a rendering concern, never a data concern** (`shared/privacy.ts`). | Dictated text is *user data*: it must enter the composer uncensored, and any cloud cleanup step is a **new egress path**, not a rendering choice. |
| **Host-side alerts already exist** (OS notifier via `spawn(argv, { shell: false })`). | We already have a safe, tested pattern for launching platform helpers — the exact primitive a recorder needs. |

### The three findings that decide the design

**F1 — "Pure frontend feature" is architecturally impossible.** [V]
VS Code's webview `<iframe>` delegates only these permissions:

> `const allowRules = ['cross-origin-isolated', 'autoplay', 'local-network-access'];` → `+ clipboard-read; clipboard-write` — `src/vs/workbench/contrib/webview/browser/webviewElement.ts:431-437` (branch `main`, fetched 2026-11-10; sandbox adds only `allow-scripts/same-origin/forms/pointer-lock/downloads`).

`microphone` is not delegated, so `getUserMedia({audio:true})` in any extension webview is refused by the Permissions Policy with no prompt — corroborated by maintainer-confirmed issues [vscode#113916](https://github.com/microsoft/vscode/issues/113916), [#250568](https://github.com/microsoft/vscode/issues/250568) ("Permissions policy violation: microphone is not allowed in this document"), [#119127](https://github.com/microsoft/vscode/issues/119127). **Capture must be host-side.** What *can* stay in the frontend is inference: `postMessage` transfers `ArrayBuffer`s efficiently since VS Code 1.57 [V], and 16 kHz mono PCM is only 32 KB/s, so the host can stream raw audio to the webview.

**F2 — Our real incumbent is VS Code itself, not Pendant.** [V]
In-box dictation is on-device, streaming, key-bindable, inserts into the chat input without submitting, has a cancel that removes only the dictated text, and runs an **LLM cleanup pass by default** (`dictation.experimental.llmCleanup = true`) on the NVIDIA **`nemotron-3.5-asr-streaming-0.6b`** model over ONNX Runtime (CPU package) — [vscode-docs `docs/configure/accessibility/voice.md`](https://github.com/microsoft/vscode-docs/blob/main/docs/configure/accessibility/voice.md), [marketplace `ms-vscode.vscode-speech`](https://marketplace.visualstudio.com/items?itemName=ms-vscode.vscode-speech). Third-party extensions **cannot** reuse it: the speech API is *proposed* (`vscode.proposed.speech`, `vscode.speech.registerSpeechProvider`) and proposed-API extensions cannot ship to the Marketplace [U → PROBABLE]; `workbench.action.editorDictation.start` only targets a **text editor**, not a webview input.
→ **The UX bar we must clear is Microsoft's, not Pendant's.** Pendant's own feature is measurably *behind* that bar (batch, no keybinding documented).

**F3 — Pendant's dictation is a *batch* pipeline; the differentiation is latency-shaped, not accuracy-shaped.** [V]
Pendant: spawn helper → record → trim leading/trailing silence → whisper.cpp transcribes the whole clip → text lands at the cursor. Nothing is readable until the last token decodes, so wall-clock cost = utterance length + decode time. Claude Code, VS Code in-box, and every modern dictation app show **live partial text**. On CPU-only local models, streaming *is* the product win — and it is achievable with a streaming encoder (see §4).

---

## 2. Competitor Landscape

| Product | Shape | Recognition | Engine / model | Languages | Where text goes | Licence / price |
| --- | --- | --- | --- | --- | --- | --- |
| **Pendant** (`cdervis.vscode-pi`, + desktop app) | Same category as Amulet: pi in a VS Code sidebar/tabs; also a desktop build | **Local**, host-side helper process | whisper.cpp (`ggml` tiny/base, fp32 + Q5_1, multilingual + `.en`), model downloaded from `huggingface.co/ggerganov/whisper.cpp` [V] | whisper.cpp set, **manually chosen**, no auto-detect | Composer, **at the cursor, never auto-sent** | Free |
| **VS Code in-box Voice/Dictation** (+ `ms-vscode.vscode-speech` legacy) | The platform itself | **Local** (streaming, on-device); web client streams to Microsoft's cloud voice service | `nemotron-3.5-asr-streaming-0.6b` (CPU ONNX) desktop; `mai` on web; legacy extension = Azure Embedded Speech [V] | 25 speech-recognition languages | Chat/Agents-Window input (no submit) and writable editors | Bundled / free extension |
| **Claude Code voice dictation** | Terminal + VS Code extension for the Anthropic agent | **Cloud**, streaming WebSocket STT | Anthropic STT, coding-tuned (not disclosed in depth) | 20 | Into the prompt at the cursor; optional **auto-send at ≥ 3 words**; Esc restores the prior prompt | Needs a claude.ai subscription login |
| **Handy** [open source] | Cross-platform dictation overlay | **100 % local** | Whisper, Parakeet V2/V3, Cohere Transcribe 2B, Canary, Breeze, Moonshine, GigaAM, SenseVoice + Silero VAD | Whisper 99+, Parakeet V3 auto (25) | Paste into the focused field | MIT, free |
| **VoiceInk** [open source] | macOS dictation app | Local; optional cloud **text-only** enhance | whisper.cpp, WhisperKit, FluidAudio Parakeet, SenseVoice, GGUF | Many (user-switched) | Paste into focused app | GPLv3, $25 one-time |
| **superwhisper / MacWhisper / Wispr Flow** | Commercial dictation apps | Local Whisper (superwhisper, MacWhisper) / cloud (Wispr Flow) [U for Flow] | Whisper Large + user-selectable polish LLM (GPT-5 / Claude Haiku 4.5 / Grok 4.1 / Gemini 3 Flash / custom key) | 100+, Flow auto-detects | Auto-paste into focused app | Freemium, ~$8–15/mo |
| **Cursor dictation & Voice chat** | Agentic IDE | **Cloud** | Undisclosed for dictation; voice chat is "Grok Voice" speech-to-speech, full-duplex with barge-in | not stated | Dictation → chat input, review before send; voice chat = orchestration surface | In Cursor plans |
| **ChatGPT/Codex Voice** | Desktop agent app | Cloud | GPT-Live (voice chat) + OpenAI STT (Dictate) | not stated | Dictate → composer; Voice = agent control with barge-in | Plus/Pro/Business |
| **Zed** | Agentic editor | — | **No voice/dictation feature at all** (no `voice`/`dictation`/`microphone`/`whisper` string in docs or blog index) [V, absence] | — | — | — |

### Pendant, dissected from its shipped artifact (clean-room: filenames and sizes only, no code read)

`vsix-amulet/extension` @ `dist/voice/` of the unpacked `cdervis.vscode-pi` v0.91.1: [V]

```
pi-voice-helper                     228 KB   (default / macOS)
pi-voice-helper-linux-x64           2.3 MB
pi-voice-helper-linux-arm64         2.0 MB
pi-voice-helper-win32-x64.exe       2.1 MB
pi-voice-helper-win32-arm64.exe     1.8 MB
whisper.framework/                  8.3 MB   (macOS whisper.cpp; Metal on Apple silicon)
WHISPER_CPP_LICENSE.txt             1 KB
                                  ~ 17 MB
```

What that tells us: (a) the feature **is** in the VS Code extension, not only the desktop app — confirmed by their own "Remote development" note; (b) recording *and* inference live in a native helper spawned per dictation; (c) they pay ~17 MB of `.vsix` payload and five platform builds for it; (d) whisper.cpp ships as a macOS **framework**, so the Metal claim is whisper.cpp's own ("on Mac with Apple silicon whisper.cpp uses the GPU; on Intel Mac/Windows/Linux it runs on the processor"). (e) Their documented gaps: no checksum verification, no polish pass, no hotwords, no keybinding — see §3.

Their honest platform caveat, which we inherit verbatim: *"When your editor is connected to another machine … that is the other machine. A server or a container usually has no microphone, so dictation cannot record there."* [V pendant.sh/guide/voice]

---

## 3. Feature Comparison Matrix

Legend: **Ours+** our differentiator · **Parity** we have it, comparable/better · **Behind** we have it, competitor stronger · **Candidate** we lack it, worth adapting · **Rejected** we deliberately will not adapt.

| # | Capability | Amulet today | Pendant | VS Code in-box | Claude Code | OSS/local dictation apps | Class |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | Voice dictation in the agent composer | Missing | Supported (local) | Supported (local, streaming) | Supported (cloud) | Supported (any app) | Candidate |
| 2 | Audio never leaves the machine | n/a | Supported — *claim is sound* | Supported on desktop (web = cloud) | **No** — cloud STT | Handy/VoiceInk/MacWhisper yes, Wispr no | Ours+ (if local-only + checksum) |
| 3 | Live partial text while speaking | n/a | **No** (batch, post-recording) | Supported (streaming) | Supported (dimmed live transcript) | Mixed (cloud yes, whisper.cpp-batch no) | Ours+ (must beat Pendant on this) |
| 4 | Push-to-talk (hold) + click toggle | n/a | Supported | Supported (hold the shortcut) | Supported, rebindable (`voice:pushToTalk`) | Standard | Candidate |
| 5 | Keyboard shortcut / palette command | n/a (13 palette commands exist for other things) | **Not documented** — on-screen mic button only | Supported, context-gated | Supported | Standard | Candidate (cheap, high-signal) |
| 6 | Input-level / "it hears you" meter | n/a | Supported (loudness) | Supported (mic control at cursor) | Supported | Supported | Candidate |
| 7 | Insert at cursor, never auto-send | n/a | Supported | Supported | Supported (+ guarded auto-send) | Supported | Candidate (matches our philosophy) |
| 8 | One-step "remove what I just dictated" | n/a | Supported | Supported (`chat.cancelSpeechToText`) | **Best-in-class**: Esc restores the exact pre-recording prompt | Esc cancels (Handy) | Candidate |
| 9 | Model picker: size/speed/URL before download | n/a | Supported (dialog lists all four) | Weak (single default; local ZIP install for air-gap) | n/a (cloud) | Supported (VoiceInk/Handy wide menus) | Behind → match, then exceed |
| 10 | Bring-your-own model file (absolute path) | n/a | Supported | Partial (offline package) | n/a | Supported | Candidate |
| 11 | Offline switch that blocks downloads | n/a | Supported | Policy-driven (`DictationModel`) | No | n/a | Candidate |
| 12 | Model storage mgmt: disk usage + delete | n/a | Supported | Weak | n/a | Supported | Candidate |
| 13 | Downloaded-file **checksum verification** | n/a | **Explicitly not done** | n/a | n/a | Unverified | Ours+ (free win, one line of trust) |
| 14 | English-only model preference | n/a | Offered (`.en` variants) | No (multilingual) | No | Supported (`.en`, Parakeet) | Ours+ (aligns with our token-efficiency stance) |
| 15 | Multilingual dictation | n/a | Supported (26+ langs, manual choice) | 25 languages | 20 languages | 100+ | Rejected |
| 16 | Language auto-detection | n/a | **No** (documented; Cantonese → "choose Chinese") | Automatic option | n/a | Parakeet V3 auto | Rejected |
| 17 | Post-transcription LLM polish | n/a | **No** | **On by default** (`llmCleanup`) | No (raw transcript) | Standard (Wispr/superwhisper/VoiceInk/Handy) | Candidate (opt-in only — see §6) |
| 18 | Deterministic cleanup (filler words, punctuation, casing) | n/a | No | Via LLM only | Coding-term tuning in the STT itself | Filler removal (MacWhisper), custom prompts | Candidate |
| 19 | Developer hotwords / vocabulary biasing | n/a | No | No | **Automatic**: project name + git branch as recognition hints, coding-term tuned | Manual glossary/dictionary (Wispr learns; superwhisper/VoiceInk lists) | Ours+ potential (we already index workspace files) |
| 20 | Voice → **steer** a running agent | n/a | n/a | n/a | No | No | Ours+ (Amulet owns `steer`/`follow_up`; nobody couples it to dictation) |
| 21 | Works in VS Code Remote (SSH/WSL/containers) | n/a | **No** — records on the remote host, so servers/containers have no mic | **Yes** — recognition runs on the local client | No (disabled for Remote) | n/a (desktop app) | Behind (structural; only the platform can fix it) |
| 22 | Max session length / auto-stop | n/a | Unverified | 20 min, keeps text, screen-reader announced | 15 s silence / 2 min cap (VS Code build) | Unverified | Candidate (guard-rails) |
| 23 | Microphone-permission guidance per OS | n/a | Documented (macOS TCC names host app or helper; Win/Linux follow OS settings) | Documented (macOS checkbox) | Documented | Documented | Candidate (copy-the-spec, not the text) |
| 24 | Graceful "no microphone available" error | n/a | Supported | Supported | Supported | Supported | Candidate |
| 25 | Per-workspace settings | n/a | Supported (folder-scoped VS Code settings) | User-level | n/a | n/a | Parity (we already dual-namespace settings) |
| 26 | Wake word ("Hey Amulet") | n/a | No | "Hey Code" via the legacy Speech extension | No | No | Rejected |
| 27 | Always-on / background listening | n/a | No (helper runs only during a dictation) | No | No | Optional in Wispr-family apps | Rejected |
| 28 | Full-duplex voice chat, barge-in, spoken read-back | n/a | No | Voice Mode (experimental, hosted, `agents.voice.enabled`) | No | No | Rejected (v1 scope) |
| 29 | Text-to-speech of agent replies | n/a | No | Supported (legacy extension, `autoSynthesize`) | n/a | No | Rejected |
| 30 | Native speaker diarization / speaker ID | n/a | No | No | No | No | Rejected |
| 31 | Voice on mobile / "follow from your phone" | n/a | Desktop remote-access exists (no voice) | No | No | No | Rejected |
| 32 | Telemetry / account required | n/a | None, no account [V] | GitHub sign-in (web path only) | claude.ai login required | None (Handy/VoiceInk) | Ours+ (no egress, no account) |
| 33 | Distribution weight of the feature | 1.5 MB total today | ~17 MB extra in `dist/` [V] | Bundled | Bundled CLI | Separate installer | Behind (see §4) |

---

## 4. Engine & Architecture Options

The feature splits into two independently-sourced halves. Conflating them is how teams end up copying Pendant's exact design.

**Capture** (must be host-side — F1):

| Option | Evidence | Verdict |
| --- | --- | --- |
| Ship per-platform native recorder (Pendant's route) | Their `dist/voice/` listing [V]; ~7 other VS Code dictation extensions use `ffmpeg`/`sox`/`arecord` sidecars instead [V] | Best UX + only cross-platform way to get device selection, level metering and *no* external install; costs binaries, signing, AV false-positive risk |
| Externally-installed CLI (`ffmpeg`, `arecord`, `pw-record`, `sox`) | Ubiquitous on Linux; **not present** on stock macOS/Windows as a recorder | Acceptable fallback with a clear "install ffmpeg" error; zero payload |
| `vscode.speech` / in-box dictation | Proposed API, `--enable-proposed-api` required, unpublishable; editor-dictation command inserts into a text editor [V] | **Blocked** |
| Webview `getUserMedia` | Permissions policy [V] | **Impossible** |

**Inference** (host-side native, or webview-side WASM fed over `postMessage`):

| Engine | Footprint | Latency story | Licence | Verdict for Amulet |
| --- | --- | --- | --- | --- |
| **whisper.cpp** (Pendant's choice) | ggml tiny 75 MB / base 142 MB; Q5_1 31 / 57 MB; RAM ~273 / ~388 MB (fp32 figures) [V, HF `ggerganov/whisper.cpp`] | Offline, whole-utterance; batch by construction. CPU RTF is well below 1 for tiny/base on modern silicon, but no authoritative CPU table could be extracted (issue #89 renders as images) → **[U]** | MIT (code **and** the ggml model repo) [V] | Accurate, safe licence, familiar. Needs a native binary per platform; Node bindings are all third-party and their prebuilt/Electron claims are unverified [U] |
| **sherpa-onnx** streaming zipformer (int8) | ≈ 73 MB int8 encoder+decoder+joiner (`streaming-zipformer-en-2023-06-26`) [V, HF]; code Apache-2.0, model Apache-2.0 [V]; Silero VAD + endpointing in the library [V] | **True streaming partials** at ~live latency — the property F3 demands | Apache-2.0 | Highest-upside engine. `sherpa-onnx-node` is N-API (ABI-stable ⇒ no rebuild for Electron) with prebuilts for linux-x64/arm64, darwin-x64/arm64, win-x64 — **no win32-arm64** [U] — but needs `LD/DYLD_LIBRARY_PATH` to its bundled onnxruntime [V], and loading it in a VS Code extension host is **unverified** [U]; native modules in extensions have no supported story (vscode#658) |
| **Whisper in WASM** (transformers.js / whisper.wasm) in the **webview** | Model 15–80 MB quantized; no native binary at all | One measured transformers.js data point: whisper-**base**, 60 s audio, Mac mini M2, WASM 4.9–6.2 s (RTF ≈ 0.08–0.10); WebGPU was *slower* until v4 [U, transformers.js#894] | MIT / Apache-2.0 | The only path that keeps Amulet native-free. Needs PCM streamed from the host, multithreaded WASM (webviews *are* granted `cross-origin-isolated` [V], but whether `SharedArrayBuffer` is actually available under `vscode-webview://` is **[H] — spike it]**, and x86-laptop numbers are unknown |
| **Vosk** | `small-en-us` 40 MB, WER 9.85 (LibriSpeech test-clean); large 1.8 GB, WER 5.69 [V, alphacephei.com/vosk/models] | Streaming, RTF reported ~0.03 (Russian benchmark) [U] | Apache-2.0 code, Apache-2.0 models | Streaming is cheap and permissive, but accuracy is a generation behind Whisper-class and the project is **stale** (last release ~0.3.50, Apr 2024 [V]) and the npm binding is FFI-based — fragile in Electron [U] |
| **Apple `SpeechAnalyzer`** | On-device, macOS 26 + Apple silicon only | Argmax benchmark: CER-based error 14.0 vs WhisperKit base.en 15.2 at 70× speed [V, argmaxinc] | Apple framework | Superb quality per watt, but macOS-only and still requires a Swift helper binary ⇒ a second maintenance track. **[H]** |
| **NVIDIA Nemotron streaming 0.6B** (what VS Code uses) | ~1.4 GB of models on disk per one user report [U]; MIT-licensed ONNX conversion [V] | Streaming, chunk sizes 80–1120 ms [V] | MIT (Microsoft ONNX export) / OpenMDW-1.1 base [U] | The incumbent's exact engine. Quality/latency benchmark to *target*, but the footprint contradicts our 1.5 MB identity |
| **Cloud STT** (OpenAI/Groq/Azure; we *can* read `auth.json`) | — | Streaming, best accuracy | — | **Rejected** (§6) |

### Recommended composite architecture **[H]** — "small helper, swappable engine, smart composer"

1. **Capture:** one tiny native recorder helper per platform (no engine linked in), spawned through the existing `spawn(argv, { shell: false })` discipline, plus a `ffmpeg`/`arecord` fallback where present. This is Pendant's *only* architecturally sound decision and it is forced by F1.
2. **Engine:** a pluggable interface (`auto | wasm | native`) rather than a single bet. Default = **whisper.cpp-class batch transcription with VAD segmentation**, upgraded to **streaming partials** (sherpa-onnx zipformer int8) wherever the addon loads, with **webview WASM** as the zero-binary path if the SharedArrayBuffer spike passes.
3. **Progressive UX:** segment on VAD silence, transcribe each closed segment as it ends, and append partial text to the composer live. That converts Pendant-shaped "wait for the whole clip" latency into first-words-in-a-second, using *any* engine — including batch Whisper. **This is the single cheapest, most visible advantage over Pendant.** [H]
4. **Everything after the transcript is where Amulet wins anyway** (hotwords from workspace context, deterministic cleanup, steer-with-voice, undo).

---

## 5. Prioritized Adaptation Roadmap

| Rank | Adapt | Impact | Effort | Architectural fit | Mandatory tradeoff |
| --- | --- | --- | --- | --- | --- |
| **R1** | **Host-side capture + local transcription into the composer** (Pendant parity: hold-to-talk, click toggle, level meter, insert-at-cursor, no auto-send) — `docs/PENDANT_VOICE_DICTATION_CLEAN_ROOM.md` items 1-3 | High — table stakes; the feature the whole category competes on | High (native helper, 5 platforms, signing) | Fits the existing host-process discipline (`spawn(argv,{shell:false})`, no `vscode` import in webview); a new `amulet.voice.*` setting group, one restart-irrelevant key set | **Our 1.5 MB artifact stops being binary-free.** ~1-2 MB of helpers (before any engine), macOS ad-hoc signature requirement [V], Windows AV false-positive risk, and a release pipeline that must build 5 artifacts. Remote/SSH/containers will record on the *remote* box and fail there |
| **R2** | **Progressive/VAD-segmented partial text** (words appear while speaking) — the direct answer to Pendant's batch design and the UX of VS Code/Claude Code | **Very high** — this is the visible differentiator | Medium over R1 | Pure streaming/render concern; the composer already handles streamed inserts elsewhere (assistant deltas) | Chunking Whisper at VAD boundaries produces *worse* text than one pass (no cross-segment context, repeated 30 s window warm-up, cost grows with segments). Needs A/B tuning; the fallback (true streaming engine) costs the native-dependency argument |
| **R3** | **Developer hotwords, derived automatically** from project name, git branch, workspace file paths, and cached `get_commands` names (Claude Code injects project + branch automatically [V]) — plus `initial_prompt`-style biasing where the engine supports it, and a deterministic fuzzy-fix table where it does not | High — accuracy on exactly the tokens a coding prompt lives on (`regex`, `JSON`, `localhost`, your crate names) | Low-Medium | Reuses existing Amulet data (`project-files.ts` listing, command cache). **Must not** touch the pi system prompt/tools → keeps the provider cache intact | Biasing an *auto-generated* vocabulary can inject noise (a branch named `fix-typo-17` steering common words); `initial_prompt` tricks can also make Whisper hallucinate or loop — must be capped, and silently skipped when empty |
| **R4** | **Undo + full state restore** ("remove what I just dictated", Esc = pre-recording composer contents, cursor position preserved) | Medium-High — Pendant has the 1-step version, Claude Code has the complete one; users trust dictation only when it is reversible | Low | Composer draft state is local textarea state (per the composer-keystroke rules in `AGENTS.md`) — snapshot a string, no runtime involvement | A snapshot/restore model must not clobber edits the user made *during* dictation; needs a merge rule, and a long recording means a second full copy of the draft in memory |
| **R5** | **Model manager dialog**: languages/speed/download size/URL, progress, own-file path, disk usage + delete, offline switch, **and a checksum check (Pendant documents that it does not do one)** | Medium — trust + air-gapped/enterprise users; small effort because Pendant's spec is public | Low-Medium | Mirrors the Packages dialog pattern we already have (read disk state, single dialog, per-workspace override) | Every listed model is another accuracy/speed support matrix we answer for in issues; checksum pinning means shipping (and revoking) a manifest |
| **R6** | **Keybinding + palette command + status-bar recording state** (`Amulet: Dictate Prompt`, hold-to-talk with `when` context, a status-bar entry counting active recordings like `approval-ledger` does for dialogs) | Medium-High in practice (voice features die without a shortcut) — and Pendant has a documented gap here | Low | `src/commands.ts` + `contributes.keybindings` with an existing `onView:amulet.chatView` context; must fire on the *focused surface* (sidebar vs tab) — our N-surfaces/one-runtime fan-out already solves that | Our rule that `WebviewView.visible` lies [AGENTS.md] means a global keybinding needs a routing decision, and a chord on a focused *text editor* competes with `workbench.action.editorDictation.start` (a real conflict we must document) |
| **R7** | **Deterministic local cleanup**: strip fillers, fix casing of code identifiers from the hotword table, sentence-case, no network | Medium — 80 % of the "polish" value with 0 % of the egress | Low | Pure webview string transform, same place as `shared/privacy.ts` hooks; runs **before** any markdown tokenizer, like the privacy rules | Deterministic rules will occasionally mangle legitimate prose ("i.e.", shell snippets, "um" inside a string); never touch backtick spans or the transcript's raw copy source |
| **R8** | **Voice → `steer` / `follow_up`**: dictate while the agent is running and queue the result as a steer instead of a new turn | **High and unique** — nobody surveyed does this (Claude Code's auto-send is a new prompt; Cursor's voice chat is a hosted loop) | Low over R1-R4 | Amulet already owns `steer`/`follow_up` and the extension-command guard (`shared/command-invocation.ts` refuses to queue `/commands`) | Auto-sending dictated text is precisely the thing every product avoids; must default to review-before-send with an explicit opt-in, and it costs tokens mid-run |
| **R9** | **Opt-in LLM polish, run outside the agent run** (precedent: `dictation.experimental.llmCleanup`, superwhisper's model picker, Handy's *separate* hotkey) | Medium — matches VS Code's default-on behaviour, but we would ship it **off** | Medium | Must be a standalone one-shot, never part of the run, so the provider prefix stays byte-identical; needs its own model picker because it may use a different provider | **It is a new egress path for user speech-derived text**, which is exactly what our "your audio never leaves it" sentence promises against; per-provider cost/quota; and a policy-shaped "is this allowed at work?" question the moment an enterprise reads our privacy page |

---

## 6. Explicit Rejections

| Competitor feature | Why we will not adapt it |
| --- | --- |
| **Cloud STT** (OpenAI/Groq/Azure — technically easy, we already read `agentDir/auth.json`) | Destroys the only privacy claim the feature exists to earn, adds a billable dependency and a network failure mode, and buys nothing a CPU model can't: English prompting is a solved problem locally. |
| **Multilingual + language auto-detection** | The user's own brief: English-only is *more* token-efficient for prompting, `.en` models are more accurate per byte, and dropping language choice removes Pendant's whole configuration surface (no "choose Chinese for Cantonese" support thread). |
| **Wake word ("Hey Amulet")** | Continuous listening is the most expensive possible trust failure mode; "Hey Code" only exists in the legacy Azure-based extension. Support cost and microphone-icon anxiety far exceed the convenience. |
| **Full-duplex voice chat / barge-in / spoken read-back** (Cursor Voice chat, ChatGPT Voice) | Requires TTS plus a hosted speech-to-speech loop, breaks keyboard-driven review of a prompt, and turns a sidebar extension into a product we cannot test. This is a different (and hosted) product. |
| **Text-to-speech of replies** (`autoSynthesize`) | Not a prompting feature; wrong persona, and it competes for the same host resources mid-run. |
| **`vscode.speech` proposed API / reusing in-box dictation** | Proposed-API extensions cannot ship to the Marketplace, and editor dictation targets a text editor, not our webview composer — the integration simply does not exist. |
| **Webview `getUserMedia`** | Refused by the iframe Permissions Policy (F1) — not a scope choice, a platform fact. |
| **Auto-send on dictation** (Claude Code's ≥3-word `autoSubmit`) | Our composer is an authoring surface (Quote/Branch/Reply all rely on review-before-send); one mis-parsed tap costs a real LLM turn. |
| **NVIDIA Nemotron 0.6B / "best model" maximalism** | ~1.4 GB reported on disk [U] is incompatible with a 1.5 MB extension identity; VS Code already offers that engine and can re-download it silently. |
| **Bundling whisper.cpp + a full model inside the `.vsix`** | Doubles-to-10×s the artifact; the model must remain a first-use download or a user-supplied path. |
| **Vosk as the mainline engine** | Apache-2.0 and tiny, but a stale upstream (last release ~Apr 2024) and an FFI binding, in a codebase whose entire advantage is having no native dependency. |

---

## 7. Tradeoffs & Risks

**Deliberate tradeoffs we are accepting**

1. **Binary-free → binary-bearing.** Even the minimum (capture only) breaks the property that makes our packaging trivial, and adds notarization/ad-hoc-signature and antivirus work to `scripts/build-vsix.sh`. Mitigation: helper does capture only; engine stays pluggable so the biggest binaries stay optional.
2. **Streaming vs. best-possible text.** R2's segmentation trades a little accuracy for latency. Users tolerate a correct-but-later transcript less than an incorrect-but-instant one they can edit — but we must state it in the model dialog, since Pendant's spec offers no such nuance.
3. **Privacy claim vs. polish UX.** VS Code ships LLM cleanup *on by default*; we ship it *off by default* and put a deterministic cleanup in front. We will look weaker on a checkbox to anyone comparing setting names, and stronger on the sentence "your audio never leaves it".
4. **No language choice = a deliberate UX hole** next to Pendant and the platform. Owned consciously, not drifted into.
5. **Pluggable engine cost.** An `auto | wasm | native` seam is cheap to describe and permanent to maintain (three code paths, three failure modes, two model formats). If the WASM spike does not clear the latency bar, delete it rather than leave it in as a third path.

**Risks**

| Risk | Exposure | Mitigation |
| --- | --- | --- |
| VS Code exposes a stable `vscode.speech` API before we ship (issue #242428 asks for it) | Our capture helper becomes redundant for the *engine*, not for the composer UX | Keep value in the transcript layer (hotwords, steer, undo); isolate capture behind one interface |
| Remote/SSH/dev-container users get a dead or wrong-microphone feature | Pendant documents the same failure; it is the #1 support thread risk | Detect remote extension host, disable the control with an explanatory tooltip (our dialog/notice patterns already exist); never record on a server |
| Linux audio variance (`pipewire`/`pulse`/`alsa`) and per-distro missing binaries | Silent failure on `arecord`-less images | Probe in order, fail loudly with the missing command named; log it in the Amulet output channel like `[ui]` |
| Engine CPU load competing with an actively working agent | A visible slowdown in the user's own tools during runs | Threading cap (2-4 threads), transcribe only after a VAD segment closes, and allow dictation while running (R8) without starting a second heavy decode |
| macOS TCC prompt names *Code*, not Amulet (or names our helper) | User denies the wrong app and believes our feature is broken | Copy Pendant's approach: explain in the error which app entry to enable; never record before the button press |
| Unsigned/ad-hoc binaries: macOS arm64 requires a signature [V]; Windows SmartScreen/AV | "It doesn't start" on fresh installs | Ad-hoc sign at build time, document manual signing, keep the fallback path to system binaries |
| Dictated text vs. `privacyMode` | Rendering rules must never rewrite user input; a censored insert is data loss | Insert raw bytes; the privacy transform stays a render-time concern (existing rule) |
| Model-download trust (Pendant ships **no** checksum verification) | Supply-chain headline against a "privacy first" pitch | Pin digests in a manifest and verify; ship a revocation note |
| Memory footprint (Whisper-class models ≈ 273-850 MB RSS [V, fp32 figures]) on the extension host or renderer | OOM complaints on laptops with an agent already running | Prefer int8/streaming models, unload the process after each dictation (Pendant's "closes once the text is ready" behaviour is right and we should keep it) |
| Unverified core numbers (Whisper CPU RTF, sherpa-in-Electron, `SharedArrayBuffer` in webview, transformers.js on x86) | A whole roadmap item could be built on a Mac-only measurement | One spike before any feature work: `scripts/voice-probe.mjs`, mirroring the existing `rpc-probe.mjs`/`bridge-probe.mjs` pattern — a real child, real mic (or WAV fixture), reported RTF per engine on the CI/dev machine |

**Suggested first step:** run `scripts/voice-probe.mjs` (new, same conventions as `bridge-probe.mjs`) against three fixtures (5 s / 20 s / 60 s English speech) × {WASM base.en int8, native whisper.cpp base.en Q5_1, sherpa streaming zipformer int8} on an x86 Linux laptop, an Apple-silicon Mac and a Windows x64 box. Two numbers decide R1-vs-R2 ordering and whether the engine seam stays two paths or becomes three: **seconds from "stop" to first visible word**, and peak RSS.

---

## 8. Evidence & Open Gaps

Primary sources read this session: `webviewElement.ts` (`main`) for the permissions policy; `vscode-docs/docs/configure/accessibility/voice.md` for in-box dictation, model name, platform matrix, 20-min cap, LLM cleanup and policies; the `ms-vscode.vscode-speech` marketplace page; `pendant.sh` home, `/guide/vscode`, `/guide/voice` (incl. Remote development, Models, Offline, Microphone permission); Pendant's unpacked `dist/voice/` listing (names/sizes only); `alphacephei.com/vosk/models` (sizes + WER); HF `ggerganov/whisper.cpp` model table; sherpa-onnx JS install docs + HF model repos; vendor docs for Claude Code voice, Cursor dictation/voice chat, ChatGPT/Codex voice, Wispr Flow, superwhisper, VoiceInk (`Beingpax/VoiceInk`), Handy (`cjpais/Handy`); `microsoft/vscode` issues #113916, #250568, #119127, #242428, #658; `huggingface/transformers.js` #894.

Still unverified and material: whisper.cpp CPU RTF on x86 laptops (community table lives in issue #89, not machine-readable) · whether `sherpa-onnx-node` loads in VS Code's Electron host with its `LD/DYLD_LIBRARY_PATH` requirement · `SharedArrayBuffer`/multithreaded WASM availability under `vscode-webview://` · WebGPU availability in VS Code webviews · exact on-disk size of the Nemotron model package · whether Pendant exposes any dictation command or keybinding outside the section scanned (absence was verified within that section only).
