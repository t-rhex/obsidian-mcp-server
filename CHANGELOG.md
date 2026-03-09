# Changelog

All notable changes to this project will be documented in this file.

## [0.1.2] - 2026-03-09

### Fixed
- **Critical**: `gitCommitMessagePrefix` config was silently ignored — `git.ts` read a non-existent property name (`gitAutoCommitPrefix` instead of `gitCommitMessagePrefix`)
- **Critical**: Server reported version `1.0.0` to MCP clients instead of actual package version
- **Critical**: Git operations (status, commit, pull, push, log, diff, remote_add, remote_list) gave opaque errors on non-git vaults instead of helpful "run init first" message
- **Critical**: Inline `#tag` regex missed tags at the start of lines (missing multiline flag)
- Wikilink resolution was O(n) per link (full vault listing each time) — now builds a file index once per request
- Git lock could queue indefinitely if an operation got stuck — now times out after 60 seconds
- Auto-sync debounce timer was not cleared on server shutdown, risking orphaned git operations
- Git log parsing broke on commit messages containing `|` — now uses null byte delimiter
- `.txt` files were included in default note extensions (Obsidian doesn't use `.txt`)
- `DAILY_NOTE_FORMAT` was silently accepted but ignored — now warns if set to unsupported value

### Added
- `--help` and `--version` CLI flags
- `MAX_FILE_SIZE_BYTES` environment variable (configurable, default 10 MB)
- Windows CI testing (ubuntu + windows matrix)
- Auto-push to remote after auto-sync commit (when remote is configured)
- Graceful skip of pull/push when no git remote is configured
- Auto `-u` flag on first push to set up upstream tracking
- Laptop-to-phone sync documentation with Obsidian Git plugin guide

### Changed
- Default `NOTE_EXTENSIONS` changed from `.md,.markdown,.txt` to `.md,.markdown`
- Build script no longer uses `chmod +x` (cross-platform compatible)
- Server name in MCP protocol changed from `obsidian-vault` to `mcp-obsidian-vault`
- Git config accessors replaced unsafe `unknown` casts with direct typed property access

## [0.1.1] - 2026-03-09

### Added
- GitHub Actions CI (Node 18/20/22 matrix)
- 34 integration tests
- Fixed package-lock.json to match renamed package
- CI git identity configuration for test suite

## [0.1.0] - 2026-03-09

### Added
- Initial release with 10 MCP tools: `read_note`, `create_note`, `update_note`, `delete_note`, `search_vault`, `list_vault`, `manage_tags`, `daily_note`, `git_sync`, `wikilinks`
- Direct filesystem access — no Obsidian required
- YAML frontmatter support via gray-matter
- Git sync with auto-commit after writes (debounced)
- Path traversal prevention with symlink safety
- Atomic writes to prevent data loss
- Published to npm as `mcp-obsidian-vault`
