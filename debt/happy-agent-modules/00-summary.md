# happy-agent-modules — module review summary

Reviewed: 2026-08-15. One report per module in this directory. Scope: every module under
`packages/happy-agent-modules/sources/`, judged against Rig's own implementations
(`packages/rig/sources/`), the root `AGENTS.md`, and the master plans.

## Cross-module themes

1. **The package itself is unsanctioned.** No master plan mentions `happy-agent-modules`. Plans
   16 and 21 place ready-made agent capabilities in `@slopus/happy-agent-features`, which does
   not exist in the tree. This is a code-vs-plan contradiction to raise with the user.
2. **Auto review is systematically dropped.** The most dangerous operations in the package ship
   with `shouldReviewInAutoMode: () => false` where Rig reviews and discloses the same actions:
   secrets attach/detach, all nine worklet tools, workflow execution on host compute,
   workspace archive and session transfer, project create/archive, slot mutations, and the
   no-review `read_skill` file reader. Where review does exist (compute file tools, applets), it
   is coupled 1:1 to Full-access elevation, which AGENTS.md forbids.
3. **Parallel reimplementation of Rig, with drift.** Compute re-creates the vendor file/shell
   surface with invented neutral tools; config duplicates Rig's ~50-file loader in one
   1,971-line file; systemPrompt is a drifted third copy of the vendor prompts; worklets is a
   second, incompatible implementation writing into the same `~/Happy/Worklets` directory Rig
   owns; goal and userInput are near-verbatim copies; mcp shares 13 file names with Rig's mcp
   directory; applets spends 4,265 lines on what Rig does in ~780, including a hand-written PNG
   decoder.
4. **Invented capability with no vendor, product, or plan justification.** `move_file`,
   `delete_file`, `list_directory`, `view_image` (compute); the tasks module's five-tool CRUD
   todo backend; the happy module's three tools; `rename_project` and agent-writable project
   settings blobs; `list_skills`; scheduling's list/cancel tools the plan assigns to the human.
5. **Plan violations in the modules the plans do cover.** Search is a cross-vendor definition
   factory (plan 16 forbids exactly this); scheduling hardcodes `targetAgentId` to self,
   removing the cross-agent messaging plan 10 defines it by; slots builds a private store the UI
   never sees where plan 14 assigns slots to Rig's database and API; presence stores a label but
   cannot drive answer-wait behavior, which is what plan 11 defines presence for; workspaces
   drops the branch field plan 03 calls mandatory; tasks and goal keep durable state in private
   SQL tables instead of the `AgentKV` plan 21 requires.
6. **AGENTS.md rule breaches.** imageGeneration selects tools by branching on
   `providerKind`/model prefix (explicitly forbidden); compute invents a fifth sandbox-escalation
   syntax; systemPrompt edits vendor prompt truth; run_command's description steers models toward
   the redundant file tools.
7. **Dead and broken code shipped as live.** applets' create/import/update cannot execute as
   wired (missing required factory options at `loadHappyAgent.ts:383`); collaboration's
   `list_agents` throws once any unrelated agent exists; workflow_logs is a permanently empty
   feature; history carries an unreachable persistence layer; happy's notifications table is
   written but never read; four of mcp's documented helpers have no callers; usage's retention
   trim is global so per-agent cost is silently cross-agent.
8. **Structural habits.** 1,200–4,265-line module classes; duplicate public operations
   (`list`/`listPage`, `get`/`getPage`); adversarial TypeBox re-validation of the module's own
   trusted state and typed dependencies; READMEs that contradict the code (history's
   `transaction` option, modelSwitch's examples, tasks' throwing example, secrets' debt list).

## Per-module verdicts

| Module | Verdict |
|---|---|
| applets | Massive reimplementation; primary tools cannot execute as wired; review coupled to elevation. |
| collaboration | Real durability work, best review-without-elevation example; but `list_agents` fails outright and exposes a roster Rig withholds. |
| compute | Provider-neutral reinvention of vendor file/shell tools; invented `move_file`/`delete_file`/`list_directory`; fifth escalation syntax; hand-rolled search. |
| config | 1,971-line duplicate of Rig's config loader; ambient `process.cwd()`; undocumented security-relevant layer. |
| goal | Closest to plan; near-verbatim copy of Rig's goal code; state in private SQL not `AgentKV`. |
| happy | No precedent; duplicates slots/notifications plans; unbounded never-read table; ignores its own config switch. |
| history | Dead persistence layer; O(n²) append path; README documents options that don't exist; default limit bricks the agent. |
| imageGeneration | Tool selection branches on provider key/model prefix (forbidden); unquoted prompt in approval text; no path boundary check. |
| mcp | Best literal implementation of the AGENTS.md security rules; problem is duplication of Rig's mcp files and dead helpers; loses locks and timeouts. |
| modelSwitch | README contradicts code; hypothetical defensive validation; reads 200 records to render 12. |
| permissions | Structurally the most correct module; reviewer receives no user transcript so it cannot weigh user authorization evidence; kill failure doesn't fail closed. |
| presence | Stores a label; cannot drive answer-wait behavior, the purpose plan 11 assigns presence; raw enum values reach the model. |
| projects | Invented settings-blob and rename tools; create/archive skip review Rig requires; duplicate schemas. |
| scheduling | Hardcodes self as target, deleting the plan's cross-agent capability; adds tools the plan assigns to the human; strong delivery lifecycle. |
| search | Cross-vendor search factory in all but name — the exact plan-16 violation; optional `provider_id` where the plan requires it; silent downgrade of unroutable tools. |
| secrets | Model can change credential attachment with zero review; Rig treats that exact decision as forced Full-access review; good value-confinement invariant. |
| skills | Invented no-review `read_skill` file reader; narrower discovery than Rig; drops the frontmatter-guardrail prompt. |
| slots | Private store invisible to the UI where plan 14 assigns slots to Rig; no review on mutations; mixed-author catalogs unorderable. |
| systemPrompt | Drifted third copy of vendor prompts (vendor-truth violation); duplicates AGENTS.md discovery and delivers documents twice. |
| tasks | Whole feature invented against no plan or vendor trace; state in private SQL blob behind a file named `taskKV.ts`; README example throws. |
| usage | Retention trim has no agent predicate, so "this agent's cost" is a cross-agent window; ignored `aggregate` argument. |
| userInput | Clean interruption boundary; but answers can never become trusted authorization evidence (no `toTrustedUserEvidence`); copied prose; wrong "legacy" label. |
| workflows | Host-compute execution with no review or `requiresAutoOrFullAccess`; `workflow_logs` permanently empty; name collision with Rig's `workflow_status`. |
| worklets | Second incompatible implementation over the directory Rig owns; destructive reconciliation; nine tools, zero review, where Rig reviews and elevates all of them. |
| workspaces | Irreversible archive/transfer ship unreviewed and undisclosed; drops the mandatory branch field. |
