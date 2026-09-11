# Development Setup — Fixed-Width Query

Index of the project's governance artifacts. Current phase: **F0 — Setup**.

| Artifact | Path | Purpose |
|---|---|---|
| Context document | [00-PROJECT-CONTEXT.md](00-PROJECT-CONTEXT.md) | Goal, stack, SLOs, architecture, roadmap, risks. Source of truth |
| Custom instructions | [../CLAUDE.md](../CLAUDE.md) | Rules the assistant follows in every response on this project |
| Skill #1 | [../.claude/skills/memory-streaming/SKILL.md](../.claude/skills/memory-streaming/SKILL.md) | Memory management, streaming, workers, buffers |
| Skill #2 | [../.claude/skills/vscode-webview-ipc/SKILL.md](../.claude/skills/vscode-webview-ipc/SKILL.md) | Custom editor, webview, IPC protocol, security |
| Skill #3 | [../.claude/skills/virtual-rendering/SKILL.md](../.claude/skills/virtual-rendering/SKILL.md) | Virtualization, high-performance rendering |
| Skill #4 | [../.claude/skills/query-engine/SKILL.md](../.claude/skills/query-engine/SKILL.md) | SQL-like parser, planner, predicates, execution |
| ADRs | `adr/` | Decisions that amend the context document |

## How this is used

- `CLAUDE.md` is loaded automatically in every Claude Code session opened in this folder.
- Skills activate on their own when the work touches their area; they can also be invoked explicitly
  by name (for example, "apply the query-engine skill").
- Any deviation from the context document requires an ADR under `docs/adr/`, numbered sequentially,
  covering context, decision, rejected alternatives, and consequences for the SLOs.
- All project output — documentation, code, identifiers, comments, commit messages, UI strings — is
  written in English.

## SLO summary (pocket version)

`P1` RSS < 200 MB · `P2` chunk < 1 s p99 · `P3` first row < 500 ms · `P4` index ≥ 300 MB/s ·
`P5` scroll ≥ 55 fps · `P6` no host task > 50 ms · `P7` index ≤ 8 MB per 1B rows ·
`P8` query ≥ 200 MB/s progressive · `P9` cancellation within 100 ms

Details and measurement method: §3 of the context document.
