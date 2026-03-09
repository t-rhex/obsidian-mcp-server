# mcp-obsidian-vault

## Build & Test

```sh
npm install && npm run build
npm test                    # 215 integration tests (node test/run.mjs)
npm run dev                 # tsc --watch
```

## Architecture

20 MCP tools: 10 vault + 7 task/project + 3 context persistence.
TypeScript ES modules, Node ≥ 18. Ships as `npx mcp-obsidian-vault`.

Key deps: `@modelcontextprotocol/sdk` v1.x, `zod` v4, `gray-matter`.

```
src/index.ts          — MCP server entry, tool + prompt registration
src/tools/*.ts        — one file per tool (20 files)
src/config.ts         — env var parsing
src/errors.ts         — ErrorCode enum, VaultError, safeToolHandler wrapper
src/vault.ts          — filesystem ops: path safety, atomic writes, list, search
src/frontmatter.ts    — YAML frontmatter parse/serialize, tag extraction
src/git.ts            — git CLI wrapper with mutex lock
src/task-schema.ts    — task types, ID gen, validation, body template
src/task-dashboard.ts — scan tasks, generate DASHBOARD.md
```

## Conventions

- Every tool handler is wrapped in `safeToolHandler()` (src/errors.ts).
- Zod v4: `z.record()` requires two args — `z.record(z.string(), z.unknown())`.
- Frontmatter: strip `undefined` values before serialize (js-yaml crash).
- Writes are atomic: write to `.tmp` file, then `rename()`.
- All paths resolved via `realpathSync` and validated against vault root.

## Gotchas

- macOS `/tmp` is a symlink to `/private/tmp` — resolve vault path with `realpathSync`.
- opencode MCP config has no `env` field — use `sh -c` with inline env vars.
- `gray-matter`: `undefined` in frontmatter object crashes `js-yaml` dump.
- Git: use HTTPS remotes (no SSH keys configured on GitHub).

## Context-First Discipline

Every new session should call `get_context()` first. It returns:
active projects, in-progress work, blockers, recent decisions, and discoveries.
