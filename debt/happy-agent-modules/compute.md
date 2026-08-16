# Module report: compute

Reviewed: 2026-08-15. Scope: `packages/happy-agent-modules/sources/compute/` compared against
Rig's own tool surface (`packages/rig/sources/agent/tools/`), root `AGENTS.md`, and master plans
00, 08 (bash and background processes), 16 (tools), 20, 21.

## Summary

The compute module is a second, provider-neutral reimplementation of the tool surface Rig
already has: thirteen invented Rig-named tools (`read_file`, `write_file`, `edit_file`,
`delete_file`, `move_file`, `list_directory`, `find_files`, `search_files`, `view_image`,
`run_command`, `read_command_output`, `send_command_input`, `stop_command`) handed identically to
every model. It is consumed only by `packages/happy-agent` (`loadHappyAgent.ts`). Rig itself does
the opposite: each vendor gets its native surface, assembled per vendor.

## How it differs from Rig's equivalents

- **Tool identity.** Rig's file and shell tools are vendor tools whose names, schemas, and
  descriptions match the vendor definitions exactly (Claude: `Bash`/`Read`/`Edit`/`Write`/
  `Glob`/`Grep`; Codex: `exec_command` family; Grok: `read_file`/`list_dir`/`search_replace`/
  `grep`). The compute module authors one neutral schema per capability and gives the same array
  to every model — the "common tool" treatment, which AGENTS.md reserves for Rig product
  capabilities (scheduling, workspaces), not the filesystem and shell.
- **Sandbox escalation.** AGENTS.md fixes four model-facing escalation shapes
  (`sandbox_permissions: "require_escalated"` for Codex/Pi/Grok, `dangerouslyDisableSandbox` for
  Claude). `run_command` invents a fifth: `escalate_sandbox: true` plus `justification`. No model
  was trained on it and it is not in the contract.
- **Search.** Rig's Grep tools shell out to a real ripgrep binary
  (`packages/rig/sources/happy/resolveHappyRipgrepExecutable.ts`). `search_files` hand-rolls a
  line-by-line regex scanner plus a partial gitignore engine whose README admits wrong semantics
  (character classes and escaping unsupported; `a**b` treated as `.*`). `find_files` reimplements
  glob walking with arbitrary 20,000-visited / 10,000-collected caps.
- **Read-before-write bookkeeping.** Rig tracks reads for edit safety per session; this module
  persists a `FileReadLog` in `AgentKV` and extends "reading earns the right to change" beyond
  edits to deletes and moves, which Rig does not do.

## Why `move_file`, `list_directory`, `delete_file` should not be tools

- No vendor surface has them; Claude, Codex, and Rig do moves, deletes, and listings through the
  shell (or `Glob`). Master plan 08 says shell/file capabilities follow "each vendor's own
  design"; master plan 16 says a model's behavior is its fixed tool array, not an invented
  capability grid.
- `move_file` and `delete_file` require the source to have been read first via `read_file` — but
  `read_file` is a text/small-image reader, so renaming or deleting a large binary or non-text
  file the agent cannot "read" is effectively blocked. Reading a file has nothing to do with the
  right to rename it.
- `move_file` admits in its own docs that the exists-check and move are not atomic and concurrent
  writers can race — complexity purchased for something `run_command` covers.
- The `run_command` description doubles down: "Prefer read_file, list_directory, find_files, and
  search_files over their shell equivalents," steering models toward the redundant tools.

## Other findings

1. **The package contradicts the master plans.** Plans 16 and 21 place ready-made agent
   capabilities in `@slopus/happy-agent-features`; no master plan mentions `happy-agent-modules`
   at all. Per the master-plan rules this is a code-vs-plan contradiction to surface to the user.
2. **Review implies elevation.** In the file tools, `shouldRunInFullAccessInAutoMode` is the same
   predicate as `shouldReviewInAutoMode` (e.g. `move_file.ts:48-51`). AGENTS.md: "review alone
   must not imply elevation." A reviewed write to an in-workspace protected file such as
   `rig.toml` does not need to cross the sandbox, yet every reviewed path action gets Full
   access.
3. **`view_image` duplicates `read_file`,** which already returns image blocks for image paths
   with the same 3 MiB bound and read recording.
4. **Runtime validation of a trusted typed dependency.** `ComputeModule.ts` builds TypeBox
   schemas of `Type.Function` members with `additionalProperties: false` to check that
   `happy-agent-compute` (its own declared dependency) returned an object shaped like its own
   TypeScript interface. It validates nothing the compiler does not already guarantee, and the
   exact-property schema throws the moment `happy-agent-compute` adds any member to `fs` or
   `shell`.
5. **Acknowledged unfinished seams shipped as prose.** The README carries known debt inline: no
   secret-bundle support in `run_command`, no per-path serialization of concurrent file
   mutations, the non-atomic move.

## What it gets right

The shell lifecycle tracks master plan 08 closely: background-on-timeout, delta reads,
detach-on-background of a running command, kill-on-cancel only for commands the turn was waiting
on, sandboxed-by-default with review only on escalation, and `read_command_output` /
`stop_command` needing no review because they only touch work Rig itself started.
