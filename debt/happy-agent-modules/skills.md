# Module report: skills

Reviewed: 2026-08-15. Scope: `packages/happy-agent-modules/sources/skills/` (README, `SkillsModule.ts`,
`Skills.ts`, `tools/`) reviewed as the v2 rewrite of the v1 skill loading in
`packages/rig/sources/agent/skills/` and `packages/rig/sources/agent/tools/external-skills/`, against root
`AGENTS.md` and master plans 00, 16, 20, 21.

## Summary

The module discovers filesystem `SKILL.md` files from the compute's cwd upward, renders an
`<available_skills>` block into the instructions, and exposes two tools, `list_skills` and `read_skill`,
for browsing and reading them. The rewrite is coherent and bounded, but it has lost three protections v1
had — the review and `requiresAutoOrFullAccess` boundary on skill reading, the untrusted-frontmatter
guardrail in the prompt, and the traversal exclusions — and it has not yet carried over v1's full set of
discovery roots.

## Changes from the Rig v1 implementation

- **`read_skill` lost its permission boundary (regression).** v1's only `read_skill`,
  `agent/tools/external-skills/createDurableSkillTool.ts`, is `requiresAutoOrFullAccess: true`,
  `shouldReviewInAutoMode: () => true`, and carries `describeAutoPermissionAction`. v2's `read_skill`
  (`SkillsModule.ts:162-171`) returns file contents with `shouldReviewInAutoMode: () => false` and no
  disclosure. Broadening the tool from durable/external skills to filesystem skills is a reasonable rewrite
  decision; dropping the review and the boundary disclosure while doing so is the regression.
- **`list_skills` is new (improvement, with a caveat).** v1 had no listing tool because the listing was in
  the prompt. Exposing it lets a model re-check the catalog after the prompt was assembled, which is
  genuinely useful — but the module still renders the same list into `instructions`
  (`SkillsModule.ts:430-448`), so in the common case the model pays a turn for text it already has.
- **Narrower discovery roots (open rewrite debt).** v1's `findSkillRootPaths.ts` documents its intent —
  "Match Codex discovery roots only" — and `createUserSkillRootPaths.ts` covers `~/.codex/skills` and
  `~/.agents/skills`, plus a builtin root (`getBuiltinSkillRoot.ts`) and plugin roots. v2's `skillRoots`
  (`SkillsModule.ts:332-363`) walks ancestors to the nearest `.git` and appends only `~/.agents/skills`.
  Skills under `~/.codex/skills`, builtin skills, and plugin skills are not yet reachable, so a user who
  installed a skill through Codex finds it missing after the rewrite.
- **Weaker frontmatter parsing (regression).** v1's `parseSkillFrontmatter.ts` uses the `yaml` package and
  honours `disable-model-invocation`. v2 hand-rolls a parser (`skillMetadata`/`frontmatterValue`,
  `SkillsModule.ts:365-403`) keyed on `startsWith("---\n")` and `indexOf("\n---", 4)`, and ignores
  `disable-model-invocation` entirely — a skill its author explicitly marked as not model-invocable is
  advertised to the model anyway.
- **Traversal exclusions dropped (regression).** v1's `findSkillFilePaths.ts` skips dot-prefixed entries and
  `node_modules` and refuses symbolic links for plugin roots. `discoverSkillRoot`
  (`SkillsModule.ts:203-302`) follows symlinked directories and skips neither, relying purely on numeric
  budgets (`MAX_SKILL_DISCOVERY_ENTRIES=4096`, `MAX_SKILL_FILES_INSPECTED=256`, `MAX_SKILL_COUNT=256`) to
  stop. In a normal repo those budgets are consumed inside `node_modules` before real skills are reached, so
  this is both a safety and a correctness regression.
- **Prompt guardrail dropped (regression).** `formatInstructions` (`SkillsModule.ts:430-448`) emits the same
  `<available_skills>` envelope as v1's `formatSkillsForPrompt.ts` but omits v1's sentence instructing the
  model to ignore frontmatter that asks for hooks, shell execution, model switching, or permission changes.
  That line is the mitigation for skill files being untrusted third-party content, and it is removed in the
  same rewrite that made skill reading unreviewed.

## Findings

1. **The master plans have not been updated for the rewrite.** Plans 16 and 21 still place ready-made agent
   capabilities in `@slopus/happy-agent-features` and do not mention `happy-agent-modules`.
2. **Skill reading is unreviewed and undisclosed.** `read_skill` (`SkillsModule.ts:162-171`) is
   `shouldReviewInAutoMode: () => false` with no `describeAutoPermissionAction`. It is bounded to discovered
   skill roots, which is the right instinct, but per finding 3 those roots come from a symlink-following
   walker, so the containment rests entirely on a hand-rolled traversal. Either restore v1's review
   boundary or make the traversal defensible; today neither holds.
3. **Traversal follows symlinks and does not exclude `node_modules` or dotfiles**
   (`SkillsModule.ts:203-302`). This is both the escape path under finding 2 and the reason discovery
   budgets are exhausted on irrelevant trees.
4. **`disable-model-invocation` is ignored** (`SkillsModule.ts:365-403`), so skills their authors marked as
   not model-invocable are still listed and readable.
5. **The tool array is not stable across turns.** Discovery runs afresh in `instructions`, again in `tools`
   (to decide whether to expose the tools at all), and again inside each tool call, with no caching. Adding
   or removing a `SKILL.md` mid-session changes the model's tool array between turns, and master plan 16
   treats a model's tool array as fixed. The tree is also walked three-plus times per turn.
6. **Runtime validation of a trusted typed dependency.** `computeResolverSchema` (`SkillsModule.ts:41-56`)
   builds a TypeBox object of `Type.Function` members with `additionalProperties: false` to check that
   `happy-agent-compute`, its own declared dependency, returned an object shaped like its own TypeScript
   interface; `materializeOptions` (`SkillsModule.ts:175-181`) exists only to make that check pass. It
   verifies nothing the compiler does not, and throws the moment the dependency gains a member.
7. **Schema bugs at the boundary.** In `Skills.ts`, `content: Type.String({ minLength: 1, ... })` means a
   present-but-empty `SKILL.md` makes `read()` throw rather than return an empty skill; the request's
   `cursor` is `maxLength: 10` while the response's `nextCursor` is `maxLength: 64`, so a cursor the module
   itself emits cannot be sent back. `MAX_SKILL_DOCUMENT_BYTES = 256*1024` is applied as a string
   `maxLength`, i.e. as characters, so the real byte ceiling is up to 4x the named limit.
8. **Quadratic list rendering.** `fitListPage` (`SkillsModule.ts:405-428`) re-renders the entire list for
   each candidate entry while shrinking to fit the output budget. Bounded by `MAX_SKILL_COUNT=256`, so not a
   hazard, but 256 full re-renders per page.

## What it gets right

Discovery order is preserved from v1 and still matches Codex's intent: ancestors deepest-first so the
nearest skill wins, user skills last, stopping at the repo root. Every traversal is explicitly budgeted,
output is paginated against a declared limit rather than truncated blindly, and both tools are correctly
non-durable and request no elevation. The `<available_skills>` rendering keeps v1's shape, so prompts stay
recognizable across the rewrite, and adding a listing tool is a sensible extension of the surface.
