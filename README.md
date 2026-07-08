# web-agent-skills

The local **bridge** + agent **skills** that let a coding agent (Claude Code / Codex /
Cursor / …) drive your real, logged-in Chrome through the **Web Agent** browser
extension — run its tools/adapters, operate pages, and even **drive `explore` to author
new adapters**. Local-only (binds `127.0.0.1`).

## Quick start

```bash
npx skills add whitefoxx/web-agent-skills -g     # install the skills into your agent(s)
```

Then: in the extension → side panel → **外部接入** → set a port → **启用**. Now ask your
agent to use your browser — the **web-agent** skill tells it how to start the bridge
and drive it (over plain HTTP `curl`, no MCP config). See [`skills/`](./skills).

## Run the bridge yourself

```bash
npx -y github:whitefoxx/web-agent-skills          # BRIDGE_PORT=8787 by default
# or from a clone:
npm install && BRIDGE_PORT=8787 npm start             # ws + @modelcontextprotocol/sdk
```

In the extension: side panel → menu → **外部接入**, set the same port, **启用** → confirm
**已连接**. (Uncheck 允许外部写操作 to make it read-only.)

## Two ways for the agent to talk to it

**HTTP (default, no setup):**

```bash
curl -s localhost:8787/status                                  # {connected:true, tools:N}
curl -s localhost:8787/tools | head -c 400                     # the catalog
curl -s localhost:8787/command -d '{"tool":"generic__list_tabs","args":{}}'
curl -s localhost:8787/command -d '{"tool":"explore_start","args":{"task":"demo"}}'
```

**MCP (optional, for native tool calls):** register the bridge as an MCP server, e.g.

```bash
claude mcp add web-agent -e BRIDGE_PORT=8787 -- npx -y github:whitefoxx/web-agent-skills
```

`tools/list` shows the browser tools + installed adapters + `explore_start`/`explore_stop`;
`tools/call` runs them. (Run one instance — the extension connects to a single port.)

## Skills

`skills/` ships drop-in skills so the agent knows the workflow without you spelling it
out — **`web-agent`** (connect + tool surface + common tasks) and
**`web-adapter-author`** (the recon→write→verify→install loop). See
[`skills/README.md`](./skills/README.md) to install. The extension's **外部接入** page has
the same 3-step quick start.

## Protocol (bridge ⇄ extension, JSON over WS)

The MV3 service worker can't accept inbound connections, so the **extension dials out**
to this daemon's WebSocket and registers; the daemon routes calls to it.

- extension → `{type:'register', client, version}` on connect; `{type:'catalog', tools}`; `{type:'ping'}`.
- bridge → `{type:'call', id, tool, args}`.
- extension → `{type:'result', id, ok, result?, error?}`.

`explore_start` / `explore_stop` are synthetic control tools (handled in the extension,
not registry adapters). Design notes live in the Web Agent extension repo
(`docs/external-agent-control.md`).
