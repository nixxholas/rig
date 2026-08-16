# happy-agent-modules — rewrite review summary

Reviewed: 2026-08-15. One report per module in this directory. Premise: `happy-agent-modules`
(with `happy-agent-base`, `happy-agent`, and `happy-agent-compute`) is the v2 rewrite of Rig's
agent runtime; `packages/rig/sources/` is the v1 reference implementation being replaced. Each
report sorts differences from v1 into regressions, open rewrite debt, and deliberate
improvements, judged against the root `AGENTS.md` and the master plans.

## Cross-module themes

1. **Auto review was systematically dropped in the rewrite.** This is the one theme that must be
   fixed before v2 can replace v1. Operations v1 reviews and discloses ship here with
   `shouldReviewInAutoMode: () => false`: secrets attach/detach (the exact decision v1 forces
   into reviewed Full access), all nine worklet tools, workflow execution on host compute,
   workspace archive and transfer, project archive (which triggers host folder deletion), slot
   mutations, and `read_skill`. Where review does exist (compute file tools, applets), it is
   coupled 1:1 to Full-access elevation, losing v1's separation that AGENTS.md requires. The
   permissions module itself is mechanically faithful to the contract but dropped the user
   transcript from the reviewer interface, so Auto review has no user-authorization evidence and
   cannot fail closed the way v1's `reviewAutoPermission` can.
2. **The master plans have not been updated for the rewrite.** No plan names
   `happy-agent-modules`; plans 16 and 21 still place ready-made capabilities in
   `@slopus/happy-agent-features`, and plans 08 and 16 still describe the vendor-shaped tool
   surface that compute's neutral thirteen-tool surface replaces. The direction needs the user's
   dictation in the plans; until then several deliberate v2 decisions read as plan violations.
3. **Capabilities lost in the rewrite (carry-over debt).** Compute regressed from real ripgrep
   to a hand-rolled search and gitignore engine; mcp lost per-server locks, per-call timeouts,
   and `toUI`; skills lost traversal safety (`node_modules`, dotfiles, symlinks) and the
   untrusted-frontmatter guardrail; scheduling lost cross-agent targeting (plan 10's defining
   capability); search collapsed six vendor definitions into one templated tool (what plan 16
   forbids) and lost answer-plus-citations results; presence lost `answerWaitMs`, the purpose
   plan 11 assigns it; userInput lost `toTrustedUserEvidence` and ask durability; workspaces
   lost the mandatory branch field; projects lost canonical-Git-top-level validation;
   imageGeneration lost the path-boundary check and image validation; secrets has not carried
   `request_secret`, GitHub sync, or the `project-git` lease.
4. **Broken or dead-as-wired code.** Applets' create/import/update cannot execute
   (`loadHappyAgent.ts:383` omits required factory options whose defaults throw); collaboration's
   `list_agents` fails outright with no authorization supplied (`loadHappyAgent.ts:384`);
   `workflow_logs` reads a table nothing writes; happy's notifications table is written but never
   read and its config switch is never consulted; history carries an unwired persistence layer
   and a default record limit that bricks the agent; usage's retention trim has no agent
   predicate, so per-agent cost is silently a cross-agent window; four of mcp's trust helpers are
   ported but unwired yet documented as live.
5. **Worklets is incompatible with the state v1 already created.** Same `~/Happy/Worklets`
   directory, different manifest format, `remove_worklet` that throws after partial deletion on
   v1's files, and reconciliation that deletes v1's version folders. A migration story is
   required, not optional.
6. **New policy invented without plan backing.** Compute's `move_file`/`delete_file`/
   `list_directory` (with read-before-delete semantics that block unreadable binaries) and its
   fifth sandbox-escalation syntax; the tasks module's full CRUD todo backend; projects'
   agent-writable settings blobs; happy's overlap with slots and notifications; collaboration's
   roster exposure reversing v1's deliberate no-discovery stance. Each needs a product decision,
   not silent adoption.
7. **Recurring structural habits.** Very large single-file modules (config at 1,971 lines,
   several over 1,200); adversarial TypeBox re-validation of the module's own state and typed
   dependencies; duplicate public operations and aliased schemas; state in private SQL tables
   behind `*KV`-named factories where plan 21 mandates `AgentKV` (goal, tasks); READMEs that
   contradict the code (history, modelSwitch, tasks, secrets).

## Genuine improvements over v1 worth keeping

- Compute's shell lifecycle (background-on-timeout, delta reads, detach semantics) and durable
  `FileReadLog` in `AgentKV`.
- mcp's SDK-free protocol behind an injected `McpHost`, untrusted `readOnlyHint`, and review
  never coupled to elevation — the most AGENTS.md-faithful surface in the package.
- Collaboration's durability and follow-up work, which restores plan-7 behavior v1 regressed on;
  `interrupt_agent` as the model of review-without-elevation.
- Scheduling's staged durable-wait lifecycle and idempotent delivery reconciliation.
- Secrets' structural value confinement and collision-rejecting `resolveForCommand`.
- Projects' in-transaction `ensure_project` convergence; workspaces' transactional bookkeeping
  and archival-as-decision; worklets' staging and containment design.
- History's provider-neutral transcript model; usage's persistence; tasks' enforced invariants;
  userInput's explicit terminal outcomes; modelSwitch's sampled-vs-exact labelling; config's
  preserved machine-setting security filter.

## Per-module verdicts

| Module | Verdict |
|---|---|
| applets | Better staging/transaction design; primary tools dead as wired; review coupled to elevation. |
| collaboration | Restores plan-7 follow-ups; roster exposure and unwired authorization break `list_agents`. |
| compute | Strong shell lifecycle; neutral surface conflicts with plans as written; invented file tools; search regressed from ripgrep. |
| config | Correct layering, security filter preserved; one 1,971-line file, duplicated rules, ambient cwd. |
| goal | Closest to plan; right permission judgement; state in private SQL not `AgentKV`; can wedge an agent pre-inference. |
| happy | Net-new surface needing a placement decision vs slots/notifications; unbounded never-read table; unconsulted config switch. |
| history | Better transcript model; unwired store layer; default limit bricks the agent; promised pruning absent. |
| imageGeneration | Good storage; tool selection branches on provider key (forbidden); lost path boundary and validation. |
| mcp | Clearest architectural gain; lost locks/timeouts/`toUI`; unwired trust helpers documented as live. |
| modelSwitch | Small and well-reasoned; notice exceeds its own budget; README describes a former design. |
| permissions | Most faithful to the permission contract; must restore the user transcript in the reviewer before v2 ships. |
| presence | Better event machinery; dropped `answerWaitMs`, the capability plan 11 defines presence by. |
| projects | `ensure_project` is a real advance; archive unreviewed despite host deletion; undefined settings scratch. |
| scheduling | Strongest lifecycle work; dropped cross-agent targeting, plan 10's defining capability. |
| search | One templated tool with six names — plan 16 forbids exactly this; lost citations and required `provider_id`. |
| secrets | Structural confinement improved; credential attach/detach lost v1's forced review — must be restored. |
| skills | Solid discovery rewrite; `read_skill` lost review+elevation; traversal safety and frontmatter guardrail dropped. |
| slots | Cleaner model; write-only to users (no global stream); mutations lost Auto review. |
| systemPrompt | Vendor prompts drifted from captured truth (not licensed by the rewrite); AGENTS.md delivered twice. |
| tasks | Real upgrade over ephemeral plans; state outside `AgentKV`; no delete/reorder; README example throws. |
| usage | Persistence is right; global retention trim makes per-agent cost cross-agent — one-line fix, real bug. |
| userInput | Better outcomes model; lost trusted-evidence path and ask durability. |
| workflows | Durable run catalog is good; compute-starting tool lost review; `workflow_logs` permanently empty. |
| worklets | Best installer design; incompatible with v1's on-disk state; all mutations lost review+elevation. |
| workspaces | Clean bookkeeping; archive/transfer lost review and disclosure; mandatory branch field absent. |
