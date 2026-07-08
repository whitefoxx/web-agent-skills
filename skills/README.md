# Web Agent skills

Drop-in skills that teach a coding agent (Claude Code / Codex / Cursor / …) to drive
the user's logged-in Chrome through the **Web Agent** extension's local bridge
(this repo's `server.mjs`).

- **`web-agent/`** — umbrella skill: start the bridge, connect, and drive it over
  plain HTTP (`curl`) — **no MCP setup needed** — plus the tool surface and common
  tasks. Start here.
- **`web-adapter-author/`** — the recon → strategy → `eval_js` → write → verify →
  install loop for authoring a brand-new site adapter.

## Install (one command)

These live in a public repo, so the [`skills`](https://github.com/vercel-labs/skills)
CLI installs them straight from GitHub into whatever agents you have:

```bash
npx skills add whitefoxx/web-agent-skills -g      # -g = user-global (~/.<agent>/skills)
```

Or just hand the repo URL to your agent — `https://github.com/whitefoxx/web-agent-skills`
— and ask it to install the **web-agent** skill. Manual install also works: copy
`web-agent/` and `web-adapter-author/` into your agent's skills dir (Claude
Code: `~/.claude/skills/`), or point Cursor/Codex rules at the `SKILL.md`.

## Then

1. Enable the bridge in the extension: side panel → **外部接入** → set a port → **启用**.
2. Ask your agent to use your browser — it reads the skill, starts the bridge, and
   drives it. Detailed usage lives in the skill; just ask.
