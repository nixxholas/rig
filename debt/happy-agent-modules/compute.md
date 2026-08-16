# Module report: compute

Reviewed: 2026-08-15. Scope: `packages/happy-agent-modules/sources/compute/` as the v2 rewrite of
Rig's file and shell tool surface (`packages/rig/sources/agent/tools/`), judged against the root
`AGENTS.md` and master plans 00, 08 (bash and background processes), 16 (tools), 20, 21.

## Summary

The compute module is the rewrite's file and shell surface: thirteen provider-neutral Rig-named
tools (`read_file`, `write_file`, `edit_file`, `delete_file`, `move_file`, `list_directory`,
`find_files`, `search_files`, `view_image`, `run_command`, `read_command_output`,
`send_command_input`, `stop_command`) handed identically to every model, consumed by
`packages/happy-agent` (`loadHappyAgent.ts`). This is a deliberate design change from v1, where
each vendor received its native surface. The rewrite's shell lifecycle is strong; its main debts
are the neutral-surface decision itself (which conflicts with the master plans as currently
written), several invented tools without vendor or plan justification, a new sandbox-escalation
syntax outside the AGENTS.md contract, and search machinery that regressed from real ripgrep to a
hand-rolled scanner.

## Changes from the Rig v1 implementation

- **From vendor surfaces to one neutral surface.** V1 gives each vendor its exact native tools
  (Claude: `Bash`/`Read`/`Edit`/`Write`/`Glob`/`Grep`; Codex: `exec_command` family; Grok:
  `read_file`/`list_dir`/`search_replace`/`grep`). The rewrite replaces all of them with one
  shared array. Master plans 08 and 16 as written still require vendor-shaped file and shell
  tools ("tool names, argument shapes, and how the capability is split across tools follow each
  vendor's own design"); if the neutral surface is the intended v2 direction, the plans need the
  user's dictation to say so. Until then this is a recorded plan conflict, not settled design.
- **New sandbox-escalation syntax.** V1 follows the AGENTS.md contract of four vendor-shaped
  escalation fields (`sandbox_permissions: "require_escalated"` for Codex/Pi/Grok,
  `dangerouslyDisableSandbox` for Claude). The rewrite introduces a fifth, neutral shape:
  `escalate_sandbox: true` plus `justification` (`tools/run_command.ts:81-92`). No shipped model
  was trained on it; the contract in AGENTS.md has not been updated to include it.
- **Search regressed from ripgrep to a hand-rolled engine.** V1's Grep tools shell out to a real
  ripgrep binary (`packages/rig/sources/happy/resolveHappyRipgrepExecutable.ts`). The rewrite's
  `search_files` is a line-by-line regex scanner over a partial gitignore engine whose own
  documentation admits wrong semantics (character classes and escaping unsupported; `a**b`
  treated as `.*`). `find_files` similarly rewrites glob walking with 20,000-visited /
  10,000-collected caps. Carrying v1's ripgrep integration forward is open rewrite debt.
- **Read-before-write extended beyond edits.** V1 tracks reads to guard edits. The rewrite
  persists a `FileReadLog` in `AgentKV` (a genuine improvement: durable across restarts, plan-21
  compliant) but extends "reading earns the right to change" to deletes and moves, which is new
  policy with awkward consequences (below).

## Findings

1. **Invented tools without vendor, product, or plan justification.** `move_file`,
   `delete_file`, and `list_directory` have no counterpart in any vendor surface or in v1, where
   moves, deletes, and listings go through the shell (or `Glob`). Beyond widening every model's
   tool array, the semantics are awkward: `move_file` and `delete_file` require the source to
   have been read via `read_file` first, but `read_file` is a text/small-image reader, so
   renaming or deleting a large binary the agent cannot "read" is effectively blocked. Reading a
   file has nothing to do with the right to rename it. `move_file` also documents that its
   exists-check and move are not atomic. The `run_command` description then steers models toward
   these tools ("Prefer read_file, list_directory, find_files, and search_files over their shell
   equivalents", `tools/run_command.ts:39`).
2. **Review implies elevation.** In the file tools, `shouldRunInFullAccessInAutoMode` is the
   same predicate as `shouldReviewInAutoMode` (e.g. `tools/move_file.ts:48-51`). AGENTS.md:
   "review alone must not imply elevation." A reviewed write to an in-workspace protected file
   such as `rig.toml` does not need to cross the sandbox, yet every reviewed path action gets
   Full access. V1 separates the two decisions; the rewrite lost that separation.
3. **`view_image` duplicates `read_file`,** which already returns image blocks for image paths
   with the same 3 MiB bound and read recording. One of the two should absorb the other.
4. **Runtime validation of a trusted typed dependency.** `ComputeModule.ts:33-96` builds TypeBox
   schemas of `Type.Function` members with `additionalProperties: false` to check that
   `happy-agent-compute` (the module's own declared dependency) returned an object shaped like
   its own TypeScript interface. It validates nothing the compiler does not guarantee, and the
   exact-property schema throws the moment `happy-agent-compute` adds any member to `fs` or
   `shell`.
5. **Acknowledged open debt.** The README records unfinished seams: no secret-bundle support in
   `run_command` (v1 has reviewed secret selection on `Bash`), no per-path serialization of
   concurrent file mutations, and the non-atomic move. These are real rewrite debts to carry as
   work items, not prose.
6. **Master-plan naming.** The master plans place ready-made capabilities in
   `@slopus/happy-agent-features` and have not yet been updated to name `happy-agent-modules`;
   plans 08 and 16 also still describe the vendor-shaped tool surface the rewrite replaces. The
   plans need the user's dictation to catch up with the rewrite direction.

## What it gets right

The shell lifecycle tracks master plan 08 closely and is the strongest part of the rewrite:
background-on-timeout, delta reads, detach-on-background of a running command, kill-on-cancel
only for commands the turn was waiting on, sandboxed-by-default with review only on escalation,
and `read_command_output` / `stop_command` needing no review because they only touch work the
agent itself started. Persisting the `FileReadLog` in `AgentKV` with durable read-authorization
semantics is an improvement over v1's session-scoped tracking, and per-path (rather than
per-tool) permission decisions via `shouldReviewComputePath`, symlink canonicalization, and
protected-path review faithfully carry v1's boundary model forward.
