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
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const PORT = Number(process.env.BRIDGE_PORT || 8787);
const CALL_TIMEOUT_MS = 60_000;

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
];

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
  if (req.method === 'GET' && url === '/tools') return json(200, { ok: true, tools: catalog });
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

// ───────── MCP server (stdio) — editors connect here ─────────
const mcp = new Server(
  { name: 'webchat-agent', version: '0.0.1' },
  { capabilities: { tools: {} } },
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
mcp
  .connect(new StdioServerTransport())
  .then(() => console.error('[bridge] MCP server ready on stdio'))
  .catch((e) => console.error('[bridge] MCP failed:', e));
