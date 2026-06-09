---
name: webchat-agent
description: Use to drive the user's real, logged-in Chrome through the WebChat Agent browser extension — open pages, read/extract content, click/type/scroll, manage tabs, run installed site adapters, author new adapters via explore, and manage the extension itself (workflows, shortcuts, long-term memory, LLM model). Covers starting the local bridge yourself and talking to it over plain HTTP (curl) — no MCP setup needed. Reach for this on any "use my browser", "read this site while I'm logged in", "scrape/automate this page", "make a tool for site X", or "save this as a workflow/shortcut/memory" request.
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
3. **Start the bridge** in the background and **leave it running**:
   ```bash
   BRIDGE_PORT=8787 npx -y github:whitefoxx/webchat-agent-skills &
   # reliable alternative — clone once, then run from the repo:
   #   git clone https://github.com/whitefoxx/webchat-agent-skills
   #   cd webchat-agent-skills && npm install && BRIDGE_PORT=8787 npm start
   ```
   ⚠️ The **first** `npx` run clones + `npm install`s (~10–30s) before it listens;
   later runs are cached and fast. **Don't assume it's up immediately** — poll (next step).
4. **Wait for it, then verify** (poll, don't just `sleep`):
   ```bash
   until curl -s localhost:8787/status >/dev/null 2>&1; do sleep 2; done
   curl -s localhost:8787/status     # {"ok":true,"connected":true,"tools":N}
   ```
   - `connected:false` → the extension isn't enabled on this port (step 2).
   - `curl` exit code **7** = nothing listening yet → the bridge is still starting; keep polling.

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
(Cursor / Codex: add the same `command` + `env` to their MCP server config.)

## Tool surface (read `tools/list` / `/tools` for the live set)

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
- **Manage the extension** (the same things the user does in the UI):
  - **Workflows**: `create_workflow` `{name, description, steps:[{tool,args,for_each?}]}`
    (re-use a name to update; later steps may use `{{N.field}}` / `{{prev}}` / `{{item.field}}`),
    `list_workflows`.
  - **Shortcuts**: `create_shortcut` `{label, text}` (re-use a label to update),
    `list_shortcuts`.
  - **Memory**: `save_memory` `{fact}`, `list_memories`, `delete_memory` `{id}`.
  - **LLM**: `get_llm_config` (profiles + slots; **keys redacted**), `set_llm`
    `{profile_id, model?, as_primary?}` — switch the active model or change a profile's
    model. **API keys are never accepted over the bridge** — adding a new backend with
    its key stays a UI action.

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
- **Save it for the user** → turn a repeatable sequence into a `create_workflow`; save a
  reusable prompt with `create_shortcut`; remember a preference with `save_memory`.

## Notes & boundaries

- **Writes** (post / comment / like; `explore_start`; `create_*` / `save_memory` /
  `delete_memory` / `set_llm`) run only if the user ticked **允许外部写操作** in 外部接入.
  Reads (`list_*`, `get_llm_config`, page reads) always work.
- **Local-only** (`127.0.0.1`). Run **one** bridge instance — the extension dials a
  single port.
- **LLM API keys** are never exposed or accepted over the bridge — read is redacted, and
  adding a backend with a key is a UI action (keeps keys out of the agent's context).
