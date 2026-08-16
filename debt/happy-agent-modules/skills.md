# Module report: skills

Reviewed: 2026-08-15. Scope: `packages/happy-agent-modules/sources/skills/` (README, `SkillsModule.ts`,
`Skills.ts`, `tools/`) compared against Rig's skill loading in `packages/rig/sources/agent/skills/` and
`packages/rig/sources/agent/tools/external-skills/`, root `AGENTS.md`, and master plans 00, 16, 20, 21.

## Summary

The module discovers filesystem `SKILL.md` files from the compute's cwd upward, renders an
`<available_skills>` block into the instructions, and — unlike Rig — exposes two tools, `list_skills`
and `read_skill`, for browsing and reading them. Roughly 450 lines reimplement discovery, frontmatter
parsing, and prompt rendering that Rig already owns, with a narrower root set and a weaker parser, and
the tools convert a zero-cost prompt-time listing into per-turn tool calls.

## How it differs from Rig's equivalents

- **Tools where Rig has none.** Rig lists filesystem skills in the prompt and expects the model to open
  `SKILL.md` with ordinary file tools; its only `read_skill` is
  `agent/tools/external-skills/createDurableSkillTool.ts`, which serves *durable/external* skills, is
  `requiresAutoOrFullAccess: true`, `shouldReviewInAutoMode: () => true`, and carries
  `describeAutoPermissionAction`. This module's `read_skill` (`SkillsModule.ts:162-171`) reads arbitrary
  files off disk with `shouldReviewInAutoMode: () => false`. `list_skills` (`SkillsModule.ts:152-161`)
  has no Rig counterpart at all: the same content is already in the system prompt.
- **Discovery roots.** Rig's `findSkillRootPaths.ts` states its intent in a comment — "Match Codex
  discovery roots only" — and `createUserSkillRootPaths.ts` includes both `~/.codex/skills` and
  `~/.agents/skills`, plus a builtin root (`getBuiltinSkillRoot.ts`) and plugin roots. The module's
  `skillRoots` (`SkillsModule.ts:332-363`) walks ancestors to the nearest `.git` and appends only
  `~/.agents/skills`. Skills a user installed under `~/.codex/skills`, builtin skills, and plugin skills
  are invisible here, so the two agents disagree about which skills exist on the same machine.
- **Frontmatter parsing.** Rig's `parseSkillFrontmatter.ts` uses the `yaml` package and honours
  `disable-model-invocation`. The module hand-rolls a parser (`skillMetadata`/`frontmatterValue`,
  `SkillsModule.ts:365-403`) keyed on `startsWith("---\n")` and `indexOf("\n---", 4)`, and ignores
  `disable-model-invocation` entirely — a skill its author explicitly marked as not model-invocable is
  advertised to the model anyway.
- **Traversal safety.** Rig's `findSkillFilePaths.ts` skips dot-prefixed entries and `node_modules`, and
  refuses symbolic links for plugin roots. `discoverSkillRoot` (`SkillsModule.ts:203-302`) follows
  symlinked directories and does not skip dotfiles or `node_modules`; it relies purely on numeric budgets
  (`MAX_SKILL_DISCOVERY_ENTRIES=4096`, `MAX_SKILL_FILES_INSPECTED=256`, `MAX_SKILL_COUNT=256`) to stop.
  In a normal repo those budgets are burned inside `node_modules` before real skills are reached.
- **Prompt text.** `formatInstructions` (`SkillsModule.ts:430-448`) emits the same `<available_skills>`
  envelope as Rig's `formatSkillsForPrompt.ts` but drops Rig's guardrail sentence instructing the model to
  ignore frontmatter that asks for hooks, shell execution, model switching, or permission changes. That
  line is the mitigation for skill files being untrusted third-party content; removing it while *adding* a
  no-review `read_skill` moves in the wrong direction.

## Findings

1. **The package contradicts the master plans.** Plans 16 and 21 place ready-made agent capabilities in
   `@slopus/happy-agent-features`; no master plan mentions `happy-agent-modules` at all.
2. **`list_skills` and `read_skill` are invented capabilities.** AGENTS.md states that the skills feature
   follows Codex's behavior and scope and that Claude Code's expanded skill runtime is a non-goal. Neither
   Codex nor Rig has a skill-listing or skill-reading tool for filesystem skills. There is no vendor trace
   or product plan justifying them, and their existence makes the model spend a turn retrieving text it was
   already given.
3. **A no-review file reader.** `read_skill` (`SkillsModule.ts:162-171`) resolves a skill id to a path and
   returns file contents with `shouldReviewInAutoMode: () => false`. It is bounded to discovered skill
   roots, which is the right instinct, but those roots are computed by the same symlink-following walker in
   finding 5 — the safety of the tool rests entirely on the correctness of a hand-rolled traversal.
4. **The tool array is not stable across turns.** Discovery runs afresh in `instructions`, again in `tools`
   (to decide whether to expose the tools at all), and again inside each tool call, with no caching. Adding
   or removing a `SKILL.md` mid-session changes the model's tool array between turns — master plan 16 treats
   a model's tool array as fixed — and a directory tree is walked three-plus times per turn.
5. **Runtime validation of a trusted typed dependency.** `computeResolverSchema`
   (`SkillsModule.ts:41-56`) builds a TypeBox object of `Type.Function` members with
   `additionalProperties: false` to check that `happy-agent-compute`, its own declared dependency, returned
   an object shaped like its own TypeScript interface; `materializeOptions` (`SkillsModule.ts:175-181`)
   exists only to make that check pass. Same pattern flagged in the compute report: it verifies nothing the
   compiler does not, and throws the moment the dependency gains a member.
6. **Schema bugs at the boundary.** In `Skills.ts`, `content: Type.String({ minLength: 1, ... })` means a
   present-but-empty `SKILL.md` makes `read()` throw rather than return an empty skill; and the request's
   `cursor` is `maxLength: 10` while the response's `nextCursor` is `maxLength: 64`, so a cursor the module
   itself emits cannot be sent back. `MAX_SKILL_DOCUMENT_BYTES = 256*1024` is applied as a string
   `maxLength`, i.e. as characters, so the real byte ceiling is up to 4x the named limit.
7. **Quadratic list rendering.** `fitListPage` (`SkillsModule.ts:405-428`) re-renders the entire list for
   each candidate entry while shrinking to fit the output budget. Bounded by `MAX_SKILL_COUNT=256`, so it
   is not a hazard, but it is 256 full re-renders to compute one page.

## What it gets right

Discovery order is sensible and matches Codex's intent: ancestors deepest-first so the nearest skill wins,
user skills last, stopping at the repo root. Every traversal is bounded, output is paginated against an
explicit budget rather than truncated blindly, and both tools are correctly non-durable and non-elevating.
The `<available_skills>` rendering is compact and matches Rig's shape closely enough that a model trained
on one reads the other without trouble.
