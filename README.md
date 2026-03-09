# obsidian-mcp-server

An MCP (Model Context Protocol) server that gives AI assistants direct filesystem access to your Obsidian vault. No Obsidian running required — reads and writes markdown files directly on disk.

## Features

- **Read, create, update, delete notes** with YAML frontmatter support
- **Full-text search** across your vault with regex support and timeout protection
- **Browse vault structure** with recursive listing and depth control
- **Tag management** — read, add, remove tags from frontmatter (deduplicates automatically)
- **Daily notes** — get, create, or append by date (`today`, `yesterday`, `2025-03-08`, etc.)
- **Git sync** — commit, pull, push, and full sync via git CLI. Optional auto-sync after every write.

## Requirements

- Node.js 18+
- An Obsidian vault (just a folder of markdown files)
- Git (optional, only needed for git sync features)

## Installation

```bash
git clone https://github.com/t-rhex/obsidian-mcp-server.git
cd obsidian-mcp-server
npm install
npm run build
```

## Quick Start

### Claude Desktop

Add to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "obsidian": {
      "command": "node",
      "args": ["/path/to/obsidian-mcp-server/build/index.js"],
      "env": {
        "OBSIDIAN_VAULT_PATH": "/path/to/your/vault"
      }
    }
  }
}
```

### With git auto-sync enabled

```json
{
  "mcpServers": {
    "obsidian": {
      "command": "node",
      "args": ["/path/to/obsidian-mcp-server/build/index.js"],
      "env": {
        "OBSIDIAN_VAULT_PATH": "/path/to/your/vault",
        "GIT_AUTO_SYNC": "true"
      }
    }
  }
}
```

## Tools

### `read_note`

Read a note's content, frontmatter, tags, and file metadata.

```
path: "Projects/my-note.md"     # .md added automatically if missing
includeRaw: false                # include unparsed content
```

### `create_note`

Create a new note with optional YAML frontmatter. Parent folders are created automatically.

```
path: "Projects/new-idea"
content: "# My Idea\n\nSome content here."
frontmatter: { "tags": ["idea", "project"], "status": "draft" }
overwrite: false                 # fails if note exists (default)
```

### `update_note`

Update an existing note. Supports replace, append, or prepend modes. Can merge frontmatter.

```
path: "Projects/my-note"
content: "## New Section\n\nAdded content."
mode: "append"                   # "replace" | "append" | "prepend"
frontmatter: { "status": "in-progress" }  # merged with existing
```

### `delete_note`

Delete a note. Moves to `.trash/` by default (Obsidian convention).

```
path: "Projects/old-note"
permanent: false                 # true for hard delete
```

### `search_vault`

Full-text search across all notes. Supports plain text and regex.

```
query: "meeting notes"
regex: false
caseSensitive: false
folder: "Projects"               # limit to subfolder
maxResults: 20
```

### `list_vault`

Browse the vault's file and folder structure.

```
path: "Projects"                 # defaults to vault root
recursive: true
maxDepth: 5
notesOnly: false                 # true to filter to .md files only
```

### `manage_tags`

Read, add, or remove tags on a note's YAML frontmatter.

```
path: "Projects/my-note"
action: "add"                    # "list" | "add" | "remove"
tags: ["important", "review"]
```

### `daily_note`

Get, create, or append to daily notes.

```
action: "append"                 # "get" | "create" | "append"
date: "today"                    # "today" | "yesterday" | "tomorrow" | "2025-03-08"
content: "- Met with team about roadmap"
```

### `git_sync`

Git version control for your vault.

```
action: "sync"                   # full pull + commit + push
message: "update notes"          # optional commit message
```

Available actions:

| Action | Description |
|--------|-------------|
| `status` | Show working tree status (staged, modified, untracked) |
| `commit` | Stage all changes and commit |
| `pull` | Pull from remote (with `--rebase` by default) |
| `push` | Push to remote |
| `sync` | Pull + stage all + commit + push in one operation |
| `log` | Show recent commit history |
| `diff` | Show uncommitted changes |
| `init` | Initialize git repo with a sensible `.gitignore` |
| `remote_add` | Add a git remote |
| `remote_list` | List configured remotes |

## Configuration

All configuration is via environment variables.

### Required

| Variable | Description |
|----------|-------------|
| `OBSIDIAN_VAULT_PATH` | Absolute path to your Obsidian vault folder |

### Optional — Vault

| Variable | Default | Description |
|----------|---------|-------------|
| `DAILY_NOTE_FOLDER` | `Daily Notes` | Subfolder for daily notes |
| `DAILY_NOTE_FORMAT` | `YYYY-MM-DD` | Date format for daily note filenames |
| `TRASH_ON_DELETE` | `true` | Move deleted files to `.trash/` instead of permanent delete |
| `MAX_SEARCH_RESULTS` | `50` | Maximum search results returned |
| `SEARCH_TIMEOUT_MS` | `30000` | Search timeout in milliseconds |
| `NOTE_EXTENSIONS` | `.md,.markdown,.txt` | File extensions treated as notes |

### Optional — Git Sync

| Variable | Default | Description |
|----------|---------|-------------|
| `GIT_AUTO_SYNC` | `false` | Auto commit + push after every write/delete |
| `GIT_AUTO_SYNC_DEBOUNCE_MS` | `5000` | Wait time after last write before auto-syncing |
| `GIT_COMMIT_MESSAGE_PREFIX` | `vault: ` | Prefix for auto-commit messages |
| `GIT_REMOTE` | `origin` | Default git remote name |
| `GIT_BRANCH` | `main` | Default git branch name |
| `GIT_TIMEOUT_MS` | `30000` | Timeout for git operations |
| `GIT_PULL_REBASE` | `true` | Use `--rebase` on git pull |

## Setting Up Git Sync

If your vault isn't a git repo yet, use the `git_sync` tool:

```
1. git_sync(action: "init")
2. git_sync(action: "remote_add", remote_url: "git@github.com:you/vault.git")
3. git_sync(action: "sync", message: "initial commit")
```

From then on, set `GIT_AUTO_SYNC=true` to automatically sync after every change, or use `git_sync(action: "sync")` manually.

## Security

- **Path traversal prevention** — all paths validated against vault root, including symlink resolution via `realpath`
- **Symlink safety** — symlinks that escape the vault are blocked; symlinks are excluded from list/search
- **No shell injection** — git commands use `execFile` (not `exec`)
- **Atomic writes** — temp file + rename prevents partial writes on crash
- **Overwrite protection** — `create_note` fails if the note already exists unless explicitly overridden
- **Trash safety** — delete never silently falls through to permanent deletion; unique filenames prevent collision in `.trash/`
- **File size limits** — configurable cap (default 10 MB) prevents reading huge files
- **Search timeout** — prevents runaway searches from hanging the server
- **Git operation lock** — mutex prevents concurrent git commands from conflicting

## Project Structure

```
src/
├── index.ts              # MCP server entry point, tool registration, auto-sync wiring
├── config.ts             # Environment variable parsing with validation
├── errors.ts             # Typed error codes and safe handler wrapper
├── vault.ts              # Filesystem operations (path safety, atomic writes, list, search)
├── frontmatter.ts        # YAML frontmatter parse/serialize, tag extraction
├── git.ts                # Git CLI wrapper with locking and timeouts
└── tools/
    ├── read-note.ts
    ├── create-note.ts
    ├── update-note.ts
    ├── delete-note.ts
    ├── search-vault.ts
    ├── list-vault.ts
    ├── manage-tags.ts
    ├── daily-note.ts
    └── git-sync.ts
```

## License

MIT
