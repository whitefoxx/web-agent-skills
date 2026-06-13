#!/usr/bin/env node
/**
 * WebChat Agent bridge daemon (roadmap T7, transport A — see
 * docs/external-agent-control.md).
 *
 *   editor ──MCP(stdio)──▶ daemon ──WS──▶ extension ──▶ result back
 *   curl   ──HTTP /command─▶ daemon ──WS──▶ extension ──▶ result back   (testing)
 *
 * The MV3 service worker can't accept inbound connections, so the EXTENSION
 * dials out to this daemon's WebSocket and registers; we route MCP `tools/call`
 * and HTTP `/command` to it and return the reply.
 *
 * Security: localhost-only bind (127.0.0.1). It's a local-only tool, so no
 * pairing token — the boundary is "runs on your machine". Write tools are
 * confirmed on the AI-editor side (each MCP tool call is user-approved there).
 *
 * Usage:  BRIDGE_PORT=8787 node server.mjs   (MCP clients launch this binary).
 */

import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

const PORT = Number(process.env.BRIDGE_PORT || 8787);
// How long the daemon waits for the extension to answer a /command before giving
// up. Default bumped 60s → 180s (+ env override) so heavy pages and long-video
// transcripts aren't cut off — the SW keepalive pings every ~20s, so the worker
// stays alive well past this. Set BRIDGE_CALL_TIMEOUT_MS to tune.
const CALL_TIMEOUT_MS = Number(process.env.BRIDGE_CALL_TIMEOUT_MS) || 180_000;

/** Synthetic control tools (not in the extension registry). */
const SYNTHETIC = [
  {
    name: 'explore_start',
    description:
      'Start an explore recording session (opens a dedicated tab). Required before the explore-only tools (get_a11y_tree, find_structured_data, eval_js, query_dom, list_network, read_network, get_dom_outline, wait_for_selector) to author a new adapter.',
    inputSchema: {
      type: 'object',
      properties: { task: { type: 'string', description: 'what you intend to build' } },
    },
  },
  {
    name: 'explore_stop',
    description: 'Stop the active explore session and close its tab.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'load_adapter',
    description:
      'Temporarily load a marketplace adapter into THIS session (no install, gone on restart): fetch + sha256-verify + register, then `<site>__<name>` is callable like an installed tool (it appears in tools/list after this). Use find_adapters to get site/name. Prefer this over install_adapter for one-off use — installed adapters sit in the tool list on every request (tokens); install only the high-frequency ones. Returns the adapter args. Loading needs no confirm; a WRITE adapter confirms when it runs.',
    inputSchema: {
      type: 'object',
      properties: {
        site: { type: 'string', description: 'adapter site (from find_adapters)' },
        name: { type: 'string', description: 'adapter name (from find_adapters)' },
      },
      required: ['site', 'name'],
    },
  },
  {
    name: 'contribute_adapter',
    description:
      "Contribute an INSTALLED adapter back to the public marketplace: returns a pre-filled GitHub issue URL containing the adapter's source for the maintainer to audit + merge (+ rotate sha). Use after you authored or healed an adapter and it works. Show the returned `url` to the user — they review + submit on GitHub (privacy: it carries only the source, no scraped data). If `pasteSource` is returned, the source was too long to inline — give it to the user to paste into the issue.",
    inputSchema: {
      type: 'object',
      properties: {
        site: { type: 'string', description: 'installed adapter site' },
        name: { type: 'string', description: 'installed adapter name' },
      },
      required: ['site', 'name'],
    },
  },
  // ── in-extension operations (handled in the extension, not registry adapters) ──
  {
    name: 'create_workflow',
    description:
      'Save a reusable workflow (a named chain of tool calls) into the extension. Re-using a name updates it. Later steps may reference earlier results via {{N.field}} / {{prev}}; set for_each to a context path to fan out (use {{item.field}}).',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'workflow name (re-use to update)' },
        description: { type: 'string', description: 'one-line summary shown to the user' },
        steps: {
          type: 'array',
          description: 'ordered steps',
          items: {
            type: 'object',
            properties: {
              tool: { type: 'string', description: 'tool id, e.g. hackernews__top' },
              args: { type: 'object', description: 'arg key/values; may use {{...}} templates' },
              for_each: { type: 'string', description: 'optional: context path to iterate' },
            },
            required: ['tool'],
          },
        },
      },
      required: ['name', 'description', 'steps'],
    },
  },
  {
    name: 'list_workflows',
    description: 'List saved workflows (name, description, tool chain).',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'create_shortcut',
    description:
      'Save a reusable prompt shortcut the user can insert with /. Re-using a label updates it. Text may embed ⟦wf:NAME⟧ / ⟦tool:ID⟧ tokens to carry a workflow/tool.',
    inputSchema: {
      type: 'object',
      properties: {
        label: { type: 'string', description: 'short name (user searches it with /)' },
        text: { type: 'string', description: 'the prompt text' },
      },
      required: ['label', 'text'],
    },
  },
  {
    name: 'list_shortcuts',
    description: 'List saved shortcuts (label + text/tool).',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'save_memory',
    description:
      "Save one long-term fact/preference about the user; it's injected into every future session's context.",
    inputSchema: {
      type: 'object',
      properties: { fact: { type: 'string', description: 'a short fact/preference' } },
      required: ['fact'],
    },
  },
  {
    name: 'list_memories',
    description: 'List saved long-term memory facts (id + text).',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'delete_memory',
    description: 'Delete a memory fact by id (from list_memories).',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
    },
  },
  {
    name: 'notes',
    description:
      "CRUD the user's notebook (markdown notes). UNLIKE memory, notes are NOT injected into context — read/write them only when the user explicitly asks. action: create(content, title?) / list / search(query) / get(id) / update(id, title?/content?) / delete(id). create/update/delete respect the extension's write switch; list/search/get always work.",
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', description: 'create | list | search | get | update | delete' },
        title: { type: 'string', description: 'note title (create/update; defaults to first line)' },
        content: { type: 'string', description: 'markdown body (required for create)' },
        id: { type: 'string', description: 'note id from list/search (get/update/delete)' },
        query: { type: 'string', description: 'search keyword (search)' },
      },
      required: ['action'],
    },
  },
  {
    name: 'get_llm_config',
    description:
      'Read the extension LLM setup: profiles (id, label, provider, baseUrl, model, hasKey) + capability slots (primary/vision/image). API keys are NEVER returned.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'set_llm',
    description:
      "Switch the active LLM or change an existing profile's model, by profile id (from get_llm_config). Does NOT accept API keys — add a new backend (with its key) in the extension UI.",
    inputSchema: {
      type: 'object',
      properties: {
        profile_id: { type: 'string', description: 'profile id from get_llm_config' },
        model: { type: 'string', description: "optional: new model name for that profile" },
        as_primary: { type: 'boolean', description: 'optional: make it the primary model' },
      },
      required: ['profile_id'],
    },
  },
];

/** Synthetic tools in OpenAI-tool shape, so HTTP /tools lists them alongside the
 * extension catalog (MCP tools/list maps them separately, below). */
function syntheticAsOpenAi() {
  return SYNTHETIC.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.inputSchema },
  }));
}

/** The single connected extension socket. */
let extWs = null;
/** Latest tool catalog the extension pushed (openAiToolsFromRegistry output). */
let catalog = [];
/** id → { resolve, timer } for in-flight calls awaiting a `result`. */
const pending = new Map();
let seq = 0;

function callExtension(tool, args) {
  return new Promise((resolve) => {
    if (!extWs || extWs.readyState !== extWs.OPEN) {
      resolve({ ok: false, error: 'extension not connected' });
      return;
    }
    const id = `c${++seq}`;
    const timer = setTimeout(() => {
      pending.delete(id);
      resolve({ ok: false, error: 'timeout waiting for extension' });
    }, CALL_TIMEOUT_MS);
    pending.set(id, { resolve, timer });
    extWs.send(JSON.stringify({ type: 'call', id, tool, args: args ?? {} }));
  });
}

// ───────── HTTP (health + testing) ─────────
const http = createServer(async (req, res) => {
  const url = (req.url || '/').split('?')[0];
  const json = (code, obj) => {
    res.writeHead(code, { 'content-type': 'application/json' });
    res.end(JSON.stringify(obj));
  };
  const connected = !!(extWs && extWs.readyState === extWs.OPEN);
  if (req.method === 'GET' && url === '/ping') return json(200, { ok: true });
  if (req.method === 'GET' && url === '/status')
    return json(200, { ok: true, connected, port: PORT, tools: catalog.length });
  if (req.method === 'GET' && url === '/tools')
    return json(200, { ok: true, tools: [...syntheticAsOpenAi(), ...catalog] });
  if (req.method === 'POST' && url === '/command') {
    let body = '';
    for await (const chunk of req) body += chunk;
    let parsed;
    try {
      parsed = JSON.parse(body || '{}');
    } catch {
      return json(400, { ok: false, error: 'bad json' });
    }
    const result = await callExtension(parsed.tool, parsed.args);
    return json(200, result);
  }
  return json(404, { ok: false, error: 'not found' });
});

// ───────── WebSocket (extension dials in) ─────────
const wss = new WebSocketServer({ server: http });
wss.on('connection', (ws) => {
  ws.on('message', (data) => {
    let m;
    try {
      m = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (m.type === 'register') {
      if (extWs && extWs !== ws) {
        try {
          extWs.close();
        } catch {
          /* ignore */
        }
      }
      extWs = ws;
      console.error(`[bridge] extension registered: ${m.client} ${m.version || ''}`);
    } else if (m.type === 'catalog') {
      catalog = Array.isArray(m.tools) ? m.tools : [];
      console.error(`[bridge] catalog: ${catalog.length} tools`);
    } else if (m.type === 'ping') {
      ws.send(JSON.stringify({ type: 'pong' }));
    } else if (m.type === 'result') {
      const p = pending.get(m.id);
      if (!p) return;
      clearTimeout(p.timer);
      pending.delete(m.id);
      p.resolve({ ok: m.ok, result: m.result, error: m.error });
    }
  });
  ws.on('close', () => {
    if (extWs === ws) {
      extWs = null;
      catalog = [];
      // Fail in-flight calls fast instead of letting each hit CALL_TIMEOUT_MS.
      for (const [, p] of pending) {
        clearTimeout(p.timer);
        p.resolve({ ok: false, error: 'extension disconnected' });
      }
      pending.clear();
    }
  });
});

http.listen(PORT, '127.0.0.1', () => {
  console.error(
    `[bridge] listening on http://127.0.0.1:${PORT}  (ws + GET /ping /status /tools, POST /command)`,
  );
  console.error('[bridge] enable 外部接入 in the extension (same port) to connect.');
});

// ───────── MCP: positioning + guided workflows (resources + prompts) ─────────
// A connecting agent should immediately grasp WHAT this is (the user's logged-in
// browser as a tool surface) and HOW to work it — so we embed that in the
// PROTOCOL, not just docs: a `server-info` resource + guided prompts. This is what
// makes the MCP integration feel first-class rather than a flat tool list (H2).

const SERVER_INFO = [
  "# WebChat Agent — the user's logged-in browser, as tools",
  '',
  'You are connected to a Chrome extension that drives the user\'s REAL, logged-in',
  'browser, locally on their machine. This is the execution layer; you are the brain.',
  '',
  '## Why this beats raw computer-use',
  '- Deterministic site adapters (see `tools/list`) extract data with NO LLM at replay',
  '  — fast, cheap, reliable. Generic clicking is the fallback, not the default.',
  '- Real logged-in sessions — no re-auth; you act as the user on sites they are signed into.',
  '- Local-first — it runs on the user\'s machine; page data need not leave it.',
  '',
  '## How to work (cheapest path first)',
  '1. `tools/list` is the source of truth. READ tools run freely; WRITE tools are',
  '   user-confirmed in the extension (a kill switch can disable them entirely).',
  '2. Prefer a ready-made adapter: `find_adapters` (search the marketplace) →',
  '   `load_adapter {site, name}` (ephemeral, token-cheap) → call `<site>__<name>`.',
  '3. No adapter for the task? Author one — use the `author-adapter` prompt, or',
  '   `explore_start` then the perception tools (get_a11y_tree, find_structured_data,',
  '   read_network, eval_js, …) to find the data source, then write + install a',
  '   deterministic adapter. A good adapter beats slow generic clicking.',
  '4. Anything without an adapter: generic primitives — open_url, get_interactives,',
  '   click, click_by_text, type_into, scroll_page, screenshot, eval_js, query_dom.',
  '5. The extension also exposes the user\'s workflows, shortcuts, notes, and memory.',
  '',
  '## Authoring discipline (also in the webchat-adapter-author skill)',
  'Pick the most stable data source, in this order:',
  'PUBLIC_API > COOKIE_API > PAGE_FETCH > INTERCEPT > DOM_STATE > UI_SELECTOR.',
  'Write a one-line strategy note (source + contract + evidence) before any code.',
  'Robust selectors only (data-testid / aria / role / text), never obfuscated build',
  'classes. Done = passes `verify` (returns the expected rows) and is installed.',
].join('\n');

/** Guided workflows surfaced as MCP prompts (clients show them as slash-commands). */
const PROMPTS = [
  {
    name: 'author-adapter',
    description: 'Author a deterministic site adapter (explore → strategy note → write → verify → install).',
    arguments: [
      { name: 'site', description: 'site or URL to build an adapter for', required: true },
      { name: 'operation', description: 'the operation, e.g. search / list comments', required: false },
    ],
  },
  {
    name: 'find-or-load-adapter',
    description: 'Find a ready-made marketplace adapter for a task and load it (cheaper than building one).',
    arguments: [{ name: 'task', description: 'what you want to do', required: true }],
  },
  {
    name: 'summarize-tabs',
    description: "Read and summarize the user's open browser tabs.",
    arguments: [],
  },
];

function promptText(name, args) {
  const a = args ?? {};
  if (name === 'author-adapter') {
    const op = a.operation ? ` for the operation "${a.operation}"` : '';
    return [
      `Build a deterministic WebChat Agent adapter for ${a.site || '<site>'}${op}.`,
      '',
      '1. explore_start({ task: "adapter for the above" }).',
      '2. open_url to the relevant page (the user is already logged in there).',
      '3. Find where the data really comes from, in order: find_structured_data',
      '   (JSON-LD / framework state / IndexedDB) → find_in_network / read_network',
      '   (XHR/GraphQL) → DOM (get_a11y_tree / query_dom). Confirm with eval_js.',
      '4. Strategy note: PUBLIC_API|COOKIE_API|PAGE_FETCH|INTERCEPT|DOM_STATE|UI_SELECTOR,',
      '   the contract (stable|visible-ui|internal-unstable), and the evidence.',
      '5. Write the opencli cli({…}) adapter (pipeline preferred; func for multi-step).',
      '   Robust selectors only; parameterize from args/URL, never hardcode ids.',
      '6. Verify it returns the expected rows; install it. explore_stop when done.',
      '',
      'Read the resource webchat://server-info and the webchat-adapter-author skill first.',
    ].join('\n');
  }
  if (name === 'find-or-load-adapter') {
    return [
      `Find and use a ready-made marketplace adapter for: ${a.task || '<task>'}.`,
      '1. find_adapters with keywords from the task.',
      '2. If a good match exists, load_adapter({ site, name }) — it becomes callable as',
      '   <site>__<name> for this session (token-cheap, not installed).',
      '3. Call it with the right args (the load result shows the arg schema).',
      '4. Only author a new adapter (see the author-adapter prompt) if nothing fits.',
    ].join('\n');
  }
  if (name === 'summarize-tabs') {
    return [
      "Summarize the user's open browser tabs.",
      '1. list_tabs to see what is open.',
      '2. For each relevant tab, get_text_from_tab (or get_page_text) to read it.',
      '3. Give a concise per-tab summary, grouped by topic.',
    ].join('\n');
  }
  return null;
}

const RESOURCES = [
  {
    uri: 'webchat://server-info',
    name: 'WebChat Agent — what this is + how to drive it',
    description: 'The value prop + the cheapest-path workflow for this logged-in-browser execution layer.',
    mimeType: 'text/markdown',
  },
  {
    uri: 'webchat://adapters',
    name: 'Available tools & site adapters',
    description: 'The current catalog (site adapters + generic primitives + synthetic control tools).',
    mimeType: 'application/json',
  },
];

// ───────── MCP server (stdio) — editors connect here ─────────
const mcp = new Server(
  { name: 'webchat-agent', version: '0.1.0' },
  { capabilities: { tools: {}, prompts: {}, resources: {} } },
);
mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    ...SYNTHETIC,
    ...catalog.map((t) => ({
      name: t.function.name,
      description: t.function.description,
      inputSchema: t.function.parameters,
    })),
  ],
}));
mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  const r = await callExtension(name, args ?? {});
  if (!r.ok) return { content: [{ type: 'text', text: r.error ?? 'error' }], isError: true };
  const text = typeof r.result === 'string' ? r.result : JSON.stringify(r.result, null, 2);
  return { content: [{ type: 'text', text }] };
});
mcp.setRequestHandler(ListPromptsRequestSchema, async () => ({ prompts: PROMPTS }));
mcp.setRequestHandler(GetPromptRequestSchema, async (req) => {
  const text = promptText(req.params.name, req.params.arguments);
  if (text == null) throw new Error(`unknown prompt: ${req.params.name}`);
  return { messages: [{ role: 'user', content: { type: 'text', text } }] };
});
mcp.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: RESOURCES }));
mcp.setRequestHandler(ReadResourceRequestSchema, async (req) => {
  const uri = req.params.uri;
  if (uri === 'webchat://server-info') {
    return { contents: [{ uri, mimeType: 'text/markdown', text: SERVER_INFO }] };
  }
  if (uri === 'webchat://adapters') {
    const tools = [
      ...SYNTHETIC.map((t) => ({ name: t.name, description: t.description })),
      ...catalog.map((t) => ({ name: t.function.name, description: t.function.description })),
    ];
    return { contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(tools, null, 2) }] };
  }
  throw new Error(`unknown resource: ${uri}`);
});
mcp
  .connect(new StdioServerTransport())
  .then(() => console.error('[bridge] MCP server ready on stdio (tools + prompts + resources)'))
  .catch((e) => console.error('[bridge] MCP failed:', e));
