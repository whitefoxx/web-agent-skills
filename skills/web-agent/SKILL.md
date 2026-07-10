---
name: web-agent
description: Use to drive the user's real, logged-in Chrome through the Web Agent browser extension — open pages, read/extract content, click/type/scroll, manage tabs, load + run site adapters on demand, author new adapters via explore, and manage the extension itself (工作流/prompt recipes, long-term memory, LLM model). Covers starting the local bridge yourself and talking to it over plain HTTP (curl) — no MCP setup needed. Reach for this on any "use my browser", "read this site while I'm logged in", "scrape/automate this page", "make a tool for site X", or "save this as a 工作流/memory" request.
---

# web-agent

**The user's logged-in browser, as your tools.** Drive the user's real, logged-in
Chrome through the **Web Agent** extension — locally, over plain HTTP (`curl`),
no MCP setup required. Deterministic site adapters + their real sessions (no re-auth),
local-first. Read/extract pages, click/type/scroll, load + run site adapters on demand,
author new ones (explore), and manage the extension (工作流 / prompt recipes / memory / LLM).

> **This file is a thin bootstrap — the live truth is `/guide`.** Once the bridge is up
> (§1), **run this first and follow it.** It reports the CURRENT state (connection, which
> adapters are installed, available tools) + directives generated for that state, and tells
> you (`upToDate:false`) if THIS file is stale, with the update command:
>
> ```bash
> curl -s "http://127.0.0.1:8787/guide?skill-version=2026-07-03"
> ```
>
> When this file and `/guide` disagree, **trust `/guide`.** Don't rely on a static tool
> list — read `/tools` (§2) for the live set.

## 1. Connect (once per session)

The bridge is a local daemon the extension dials into. You start it; the user flips one
switch in the extension.

1. **User enables the bridge** — extension side panel → menu → **外部接入** → set the port
   (default **8787**) → **启用**. You can't do this (it's a browser UI toggle); ask them to
   if step 3 shows not-connected.
2. **Start the bridge** in the background and leave it running. The **first** `npx` run
   clones + `npm install`s (~10–30s) before it listens — don't assume it's up; poll (step 3):
   ```bash
   BRIDGE_PORT=8787 npx -y github:whitefoxx/web-agent-skills &
   # reliable alternative: git clone https://github.com/whitefoxx/web-agent-skills
   #   && cd web-agent-skills && npm install && BRIDGE_PORT=8787 npm start
   ```
3. **Wait, then verify** (poll — don't just `sleep`):
   ```bash
   until curl -s localhost:8787/status >/dev/null 2>&1; do sleep 2; done
   curl -s localhost:8787/status     # {"ok":true,"connected":true,"tools":N}
   ```
   - `connected:false` → the extension isn't enabled on this port (step 1).
   - `curl` exit code **7** = nothing listening yet → still starting; keep polling.

## 2. Use it — HTTP (the simple default)

1. **Run `/guide` first** (above) — current state + how to drive + directives.
2. **Live tool list** (the source of truth — never guess from a static list):
   ```bash
   curl -s localhost:8787/tools        # [{ function:{ name, description, parameters } }, ...]
   ```
3. **Run a tool** — POST `{ "tool", "args" }`; reply is `{"ok":true,"result":…}` or
   `{"ok":false,"error":…}`:
   ```bash
   curl -s localhost:8787/command -d '{"tool":"generic__open_url","args":{"url":"https://example.com"}}'
   curl -s localhost:8787/command -d '{"tool":"generic__get_page_text","args":{}}'
   ```

Marketplace adapters you don't have yet: `find_adapters {query}` → `load_adapter {site,name}`
(temporary, no install) → call `<site>__<name>`. Authoring a new adapter: load the
**web-adapter-author** skill and run its `explore_start` → recon → `eval_js` →
`synthesize_adapter` loop. Hit a login wall / captcha / a step only the user can do?
`await_user_action {objective, tab_id}` hands off to the user and resumes.

## 3. Optional — native tools via MCP

Prefer first-class tool calls over `curl`? Register the bridge as an MCP server once:

```bash
claude mcp add web-agent -e BRIDGE_PORT=8787 -- npx -y github:whitefoxx/web-agent-skills
```

(Cursor / Codex: add the same `command` + `env` to their MCP server config.) You then also
get **prompts** (`author-adapter`, `find-or-load-adapter`, `summarize-tabs`) and **resources**
(`web://server-info` — read it first, `web://adapters`).

## Boundaries

- **Local-only** (`127.0.0.1`); run **one** bridge instance.
- **Writes** (post / comment / like; `explore_start`; `create_*` / `save_memory` / `set_llm`)
  run only if the user ticked **允许外部写操作** in 外部接入; reads always work.
- **LLM API keys** are never exposed or accepted over the bridge (read is redacted; adding a
  backend with a key stays a UI action).
- **Load saved memories first** — call `list_memories` once at the start and honor them;
  driving over the bridge does NOT auto-inject the user's stored preferences.
