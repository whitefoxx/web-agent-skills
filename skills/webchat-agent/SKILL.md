---
name: webchat-agent
description: Use to drive the user's real, logged-in Chrome through the WebChat Agent browser extension — open pages, read/extract content, click/type/scroll, manage tabs, run installed site adapters, and author new adapters via explore. Covers starting the local bridge yourself and talking to it over plain HTTP (curl) — no MCP setup needed. Reach for this on any "use my browser", "read this site while I'm logged in", "scrape/automate this page", or "make a tool for site X" request.
---

# webchat-agent

Drive the user's **real, logged-in Chrome** through the **WebChat Agent** extension.
You start a tiny local bridge and talk to it over **plain HTTP (`curl`)** — no MCP
config required. Everything runs on the user's machine against their actual browser
session (their cookies/logins); local-only, nothing leaves the box.

## 1. Connect (once per session)

The bridge is a local daemon the extension dials into. You start it; the user flips
one switch in the extension.

1. **Port** — whatever the user enabled in the extension (default **8787**). Ask if unsure.
2. **User enables the bridge** — extension side panel → menu → **外部接入** → set that
   port → **启用**. You can't do this (it's a browser UI toggle); ask the user to, if
   step 4 shows not-connected.
3. **Start the bridge** and leave it running in the background:
   ```bash
   BRIDGE_PORT=8787 npx -y github:whitefoxx/webchat-agent-skills
   # reliable alternative — clone once, then run from the repo:
   #   git clone https://github.com/whitefoxx/webchat-agent-skills
   #   cd webchat-agent-skills && npm install && BRIDGE_PORT=8787 npm start
   ```
4. **Verify** the round trip:
   ```bash
   curl -s localhost:8787/status     # {"ok":true,"connected":true,"tools":N}
   ```
   `connected:false` → the extension isn't enabled on this port (step 2).

## 2. Use it — HTTP (the simple default, no MCP)

- **Discover the tools** (always the source of truth):
  ```bash
  curl -s localhost:8787/tools        # [{ function:{ name, description, parameters } }, ...]
  ```
- **Run a tool** — POST `{ "tool", "args" }`:
  ```bash
  curl -s localhost:8787/command -d '{"tool":"generic__open_url","args":{"url":"https://example.com"}}'
  curl -s localhost:8787/command -d '{"tool":"generic__get_page_text","args":{}}'
  ```
  The reply is `{"ok":true,"result":…}` or `{"ok":false,"error":…}`.

## 3. Optional — native tools via MCP

Prefer first-class tool calls over `curl`? Register the bridge as an MCP server once,
then use your editor's normal `tools/list` / `tools/call`:

```bash
# Claude Code:
claude mcp add webchat-agent -e BRIDGE_PORT=8787 -- npx -y github:whitefoxx/webchat-agent-skills
```
(Cursor / Codex: add the same `command` + `env` to their MCP server config.) The bridge
speaks MCP over stdio; HTTP stays available either way.

## Tool surface (read `tools/list` for the live set)

- **Browser primitives** (`generic__…`): `open_url`, `list_tabs`, `get_active_tab`,
  `get_page_text`, `get_html`, `get_interactives`, `screenshot`; act: `click`,
  `click_by_text`, `type_into`, `scroll_page`, `wait_for_selector`, `close_tab`;
  inspect/extract: `find_structured_data`, `list_network` / `read_network` /
  `find_in_network`, `get_a11y_tree`, `query_dom`, `get_dom_outline`, `eval_js`;
  `find_adapters`, `install_adapter`; bookmarks / history / reading-list.
- **Installed site adapters** (`<site>__<command>`, e.g. `xiaohongshu__feed`):
  deterministic extractors for sites the user added. Read each one's args from `tools/list`.
- **Explore controls**: `explore_start` / `explore_stop` — open/close a recording tab so
  the explore-only tools work, for authoring a NEW adapter.

## Common tasks

- **Read a logged-in page** → `generic__open_url` (or reuse a tab via `generic__list_tabs`)
  → `generic__get_page_text` / `find_structured_data`.
- **Extract structured data** → prefer an installed `<site>__…` adapter; else
  `find_structured_data` → network → DOM.
- **Operate a page** → `generic__get_interactives` for refs → `click` / `type_into` /
  `scroll_page`, with `wait_for_selector` between steps.
- **Author a new adapter** → load the **webchat-adapter-author** skill and run its loop:
  `explore_start` → recon → strategy note → `eval_js` → write the `cli({…})` source →
  verify → `generic__install_adapter`.

## Notes & boundaries

- **Writes** (post / comment / like, and `explore_start`) run only if the user ticked
  **允许外部写操作** in 外部接入.
- **Local-only** (`127.0.0.1`). Run **one** bridge instance — the extension dials a
  single port.
- **Not bridge tools (yet):** the extension's LLM backend, long-term memory, workflows,
  and shortcuts are set in the extension UI (or by its own side-panel agent). Adapters
  you can author here via explore.
