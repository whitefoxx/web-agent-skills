---
name: web-adapter-author
description: Use when authoring a Web Agent adapter for a new site (or a new command) by driving the user's logged-in Chrome through the web-agent MCP bridge. Guides recon → strategy note → develop+test extraction with eval_js → write the cli({}) adapter → verify → install. For ad-hoc browsing (no adapter) just call the web-agent tools directly.
---

# web-adapter-author

You author a **Web Agent adapter** (an opencli-style `cli({…})` command) by
driving the user's real, logged-in Chrome through the **web-agent MCP server**
(the `bridge/`). Goal: from zero to an adapter that re-extracts the data
deterministically (no LLM at replay).

Prereqs: the bridge is connected — see the **web-agent** skill (start the bridge,
enable 外部接入 on its port, `curl -s localhost:<port>/status` shows
`connected:true`). Then the tools (browser primitives + `explore_start` /
`explore_stop` + the installed site adapters) are reachable via `curl
localhost:<port>/command` (or MCP `tools/call` if you registered it). Local-only.

## Loop

1. **`explore_start({ task })`** — opens a dedicated recording tab. Required
   before the explore-only tools work.
2. **`open_url`** to the target page (your logged-in session is reused). Interact
   as needed (`get_interactives` → `click` / `type_into` / `scroll_page`,
   `wait_for_selector`).
3. **Recon — find the most stable data source, in this order (stop when found):**
   - **`find_structured_data`** — JSON-LD, framework state (`__NEXT_DATA__` /
     `__NUXT__` / `__APOLLO_STATE__` / `<script type=json>`), OG/meta, feeds, and
     **IndexedDB / localStorage** (SPAs cache the full dataset there — often more
     complete + stable than the DOM, and immune to virtual lists).
   - **`list_network` / `find_in_network` / `read_network`** — see a value on the
     page? reverse-find which XHR/GraphQL endpoint produced it; read the full body.
   - **`get_a11y_tree` / `get_dom_outline` / `query_dom`** — semantic structure
     (role + name, class-independent) and a cheap layout map; verify selectors.
4. **Write a strategy note before any code** (this is the robustness ladder):

   ```
   Strategy: PUBLIC_API | COOKIE_API | PAGE_FETCH | INTERCEPT | DOM_STATE | UI_SELECTOR
   Contract: stable | visible-ui | internal-unstable
   Evidence: <endpoint / state global / IndexedDB store / UI anchor> · <auth source> · <sample shape>
   ```

   Prefer sources with an external/visible contract. Don't migrate a stable
   UI/DOM impl onto an undocumented internal XHR just to be "API-first".

5. **Develop + test the extraction live with `eval_js`** — it runs in the page via
   the same CDP path the adapter will use. Iterate until it returns exactly the
   rows you want. Notes: write an IIFE or a statement body ending in `return …`;
   for IndexedDB use an async body; the injected **`__loc`** helper
   (`__loc.byRole/byText/byLabel/near/first/units/field`) gives robust,
   class-independent locating.
6. **Write the adapter** as `cli({ site, name, access, description, args, columns,
pipeline | func })`:
   - **pipeline** is preferred (declarative `navigate`/`evaluate`/`map`/… — no
     "Allow user scripts" toggle). Use **func** only for multi-step interaction
     (virtual-list / infinite-scroll scroll-collect loops).
   - Robust selectors only: `data-testid` / `aria-*` / `role` / semantic tags /
     `href` / visible text — **never** obfuscated build-hash classes (`.YzCcne`)
     or positional `:nth-child` for data rows. Give 2–3 ranked candidates per
     field via `__loc.first(...)`.
   - **Parameterize** from args / the URL (e.g. read the session id from
     `location.pathname`); never hardcode a specific id.
7. **Verify** — re-run `eval_js` (or the pipeline's `evaluate`) and confirm the
   output matches what you observed: row count in range + key fields non-empty.
8. **Finish** — `synthesize_adapter` already registered + persisted the adapter
   (it appears under **Adapters → 探索生成**); there is no separate install step.
   Then `explore_stop`. To submit it to the public marketplace, use
   `contribute_adapter` (opens a pre-filled GitHub issue with the source).

## Gotchas

- Virtual lists / infinite scroll: prefer IndexedDB/API for the full set; only
  DOM → a **func** that scrolls + dedups by a stable key until no new items.
- A tool that says "no active explore session" → you forgot `explore_start`.
- Write tools (post/comment/like) execute only if the user enabled 允许外部写操作;
  your editor still confirms each call.
- Run one bridge instance — the extension connects to a single port.
