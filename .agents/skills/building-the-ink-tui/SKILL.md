---
name: building-the-ink-tui
description: How to build and extend the guided terminal menu (Ink/React) - the no-build htm setup, the commands.js extraction, the util setLogSink + DB-polling live progress panel, the Ink lifecycle/teardown, TTY/--no-input gating, and keeping the direct flags. Use whenever you add or change a menu screen, the live progress panel, the UI invocation gate, the bilingual strings, or any src/ui/ code.
metadata:
  type: task
  verification_signal: npm test (ink-testing-library renders the menu PT/EN + web-screen navigation) + node -e import of src/ui/App.js loads the graph + `echo "" | node src/index.js` falls back to help (non-TTY)
---
# Building the Ink TUI

## When to use
Adding or editing the guided menu under `src/ui/`, a new screen/flow, the live progress panel, the invocation gate, or the bilingual strings — while keeping every flag/command working directly.

## Procedure / injected knowledge
- **No build step: htm, not JSX.** Author components as `` html`<${Box}>...</${Box}>` `` with `html = htm.bind(createElement)` (`src/ui/html.js`). Stack is `ink@^5` + `react@^18` + `@inkjs/ui@^2` + `htm@^3` (ink@7 needs react@19 and does NOT match @inkjs/ui@2). `import { createElement } from 'react'` works under Node ESM (cjs-module-lexer). htm has NO naked JSX fragment: `<>…</>` parses as tag `''` (React throws `InvalidCharacterError` → blank render) — use `<${Fragment}>…<//>`. `src/web-ui/app.js:5-8@47bfa19`. Verified: browser pageerror reproduced, then fixed.
- **The no-build pattern has a BROWSER twin (`ncrawl web`).** `src/web-ui/` renders with React+ReactDOM UMD as globals + `htm.module.js` as an ES module, all served FROM node_modules by `src/web.js` (offline, no CDN). Exports maps BLOCK deep paths (react exposes no `./umd/*`; htm not even `./package.json`), so resolve via `path.dirname(require.resolve('<pkg>/package.json'))` — and for htm via `path.dirname(require.resolve('htm'))`. `src/web.js:17-25@47bfa19`.
- **Long-running command = its own screen.** RunView's contract is a FINITE thunk (resolve → Alert → back). The web server screen (`WebConfig` → `WebRun`) owns the lifecycle instead: `startWebServer` on mount, `close()` in the effect cleanup, `useInput` q/Esc→onBack and o→openBrowser. `src/ui/screens.js@47bfa19`. Verified: npm test navigates menu → port prompt (`test/ui.web.test.js`).
- **Commands live in `src/commands.js`** (side-effect-free), shared by the CLI (`src/index.js`) and the UI. The UI builds a thunk `() => cmdX(flags, rest)`; the command logs/persists exactly as on the CLI. `getStatus()` returns the counts as DATA (reused by the StatusBar and the run panel).
- **Live progress WITHOUT touching the crawl:** `setLogSink(fn)` (util.js) routes `log`/`warn`/`errorLog`/`debug` to the UI; `RunView` captures them in a BOUNDED ring buffer (~200 lines, NOT `<Static>` — it grows unbounded and lingers across runs) and polls `getStatus()` every ~300ms for the counters. The command is I/O-bound, so the event loop stays free for Ink to render. Unset the sink in BOTH the promise `.finally` and the effect cleanup.
- **Invocation gate (`src/index.js`):** open the UI on `ui`/`menu` OR (no args AND `stdin.isTTY && stdout.isTTY` AND not `--no-input`/`NO_INPUT`); otherwise dispatch the flags directly; bare + non-TTY -> `printHelp()` (NOT crawl). Load Ink via dynamic `import('./ui/index.js')` so the CLI path never pays the React cost.
- **Lifecycle (`src/ui/index.js`):** `render(html\`<${App}/>\`, {patchConsole:true})`, `await waitUntilExit()`, then `setLogSink(null)` + `closeBrowser()` + `db.close()` + `exit(0)`. `exitOnCtrlC` (default true) restores the terminal on Ctrl-C; an abandoned `in_progress` job resumes next run via `resetInProgress`.
- **Focus:** @inkjs/ui `Select`/`TextInput` capture input while mounted, so render ONE input at a time (wizard by `step`). Do NOT register global plain-letter hotkeys (they steal `TextInput` chars). Pre-validate in the screens so the commands' `process.exit` guards (bad `--since`, missing url, `reset --yes`, no LLM) are unreachable under Ink.
- **i18n + transparency:** `t(key)` is PT default / EN via `CRAWLER_LANG` (UI chrome only; crawl logs stay PT). Always show the equivalent command (`commandPreview`) on the review screen so users learn the flags.

## <evolution>
On completion, if the TUI structure or an Ink/htm gotcha changed AND you verified it (`npm test` render + a manual TTY run), update this skill via the memory pipeline. Keep it lean. See meta-skill-evolution.
