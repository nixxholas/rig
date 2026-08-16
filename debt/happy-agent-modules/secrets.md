# Module report: secrets

Reviewed: 2026-08-15. Scope: `packages/happy-agent-modules/sources/secrets/`, the v2 rewrite of Rig's
secrets implementation (`packages/rig/sources/secrets/` and `packages/rig/sources/tools/secrets/` are
the v1 reference implementation being replaced), read against root `AGENTS.md` and master plans 00,
08 (bash and background processes), 16, 20, 21. Note: the master plans still name
`@slopus/happy-agent-features` and have not yet been updated for the rewrite into
`happy-agent-modules`.

## Summary

The module holds a catalog of secret *references* — id, description, environment-variable names,
revision — and a set of `(scopeRef, secretId)` attachments, and gives the model four tools:
`list_secrets`, `reference_secret`, `attach_secret`, `detach_secret`. Values never enter a schema,
event, tool argument, or formatted string; that invariant is real and well enforced, and the
`resolveForCommand` contract is better than v1's. The serious problem is the two mutating tools: they
let the model decide which credentials become available to later commands, and both set
`shouldReviewInAutoMode: () => false`. In v1 that same decision is the one action that forces
reviewed Full-access execution.

## Changes from the Rig v1 implementation

- **Regression — the credential-selection decision lost its review.** AGENTS.md and the v1 prompt
  both say: "Selecting any attached secret also requires reviewed Full-access execution
  automatically" (`createSecretInstructions.ts:8`). v2's `attach_secret` moves the same decision —
  making a credential reachable by a later command in a scope — into an unreviewed tool call
  (`tools/attach_secret.ts:36`). The README defends this on the grounds that the tools cannot "leak a
  value or touch anything outside the secret catalog" (README:44-46), which is true and beside the
  point: the catalog *is* the authorization surface. An agent that can attach `deploy-credentials`
  to its own scope without review has changed what the next reviewed command will be handed. This is
  the most consequential protection lost in the rewrite.
- **New capability — model-facing attach/detach.** v1's entire model-facing secrets surface is
  `request_secret` (`rig/sources/tools/secrets/requestSecret.ts:43-87`), which prepares a
  metadata-only attachment asking the *human* to enter a value in the client. Which secrets exist is
  told to the model in the system prompt (`createSecretInstructions.ts:6-13`), and which secrets a
  given command gets is chosen per command through the shell tool's `secrets` argument. Giving the
  model attach/detach is a real expansion of agent authority and should be an explicit product
  decision, with the review posture above settled as part of it.
- **Open rewrite debt — `request_secret` is not carried over.** README:157-159 — "The legacy
  `request_secret` interaction is intentionally not a secrets-catalog operation." That may be the
  right home for it, but nothing else in the rewrite provides the human-enters-a-value flow that is
  v1's only shipped secret tool, so the capability is currently missing rather than relocated.
- **Open rewrite debt — GitHub sync and the managed Git proxy.** README:161-163 — "Host integration
  debt remains for GitHub CLI token synchronization and the managed `project-git` credential-proxy
  lease (`trustedLoopbackPorts`); those are not flat environment bundles and must be owned by host
  infrastructure." v1 implements both today (`rig/sources/secrets/GitHubSecretSync.ts`, and the
  managed Git proxy referenced from `AGENTS.md`). v2 reserves the IDs, declines the behavior, and
  records the gap in a README; the gap is real and needs an owner.
- **Regression — scope and kind typing loosened.** v1 types the attachment scope as
  `SecretAttachmentScope = "project" | "session"` (`rig/sources/secrets/types.ts:71`). v2 makes
  `scopeRef` an opaque 100-character string (`Secret.ts:25-34`) that the model supplies verbatim,
  with no enumeration of valid scopes and no way for the model to discover one. `kind` likewise
  widens v1's `specialSecretKindSchema = Union([Literal("github")])`
  (`rig/sources/secrets/types.ts:43`) to a free-form 128-character pattern string
  (`Secret.ts:110-116`).
- **Carried over correctly — reserved IDs.** Both reserve `project-git`; v2 additionally reserves
  `github` (`Secret.ts:17-23`) and rejects registrations under either, which matches v1's treatment
  of GitHub as a managed credential rather than an environment bundle.

## Findings

1. **`attach_secret` grants credential availability without review.**
   `tools/attach_secret.ts:36` — `shouldReviewInAutoMode: () => false`. Even accepting that the
   module's own boundary is metadata-only, AGENTS.md requires each tool to own its Auto behavior
   against what the action *enables*, and requires an approval to disclose a specialized boundary via
   `describeAutoPermissionAction`. Neither `attach_secret` nor `detach_secret` sets one.
   `detach_secret` has the mirror problem in the other direction: silently removing a credential a
   running workflow depends on.
2. **Four copies of the same two-field shape.** `secretAttachmentSchema` (`Secret.ts:154-160`),
   `secretAttachInputSchema` (162-168), the tool-local `attachSecretInputSchema`
   (`tools/attach_secret.ts:11-17`), and the tool-local `detachSecretInputSchema`
   (`tools/detach_secret.ts:16-22`) are all `{ scopeRef, secretId }` with
   `additionalProperties: false`. A fifth name, `secretDetachInputSchema`, is an alias of the second
   (`Secret.ts:170`).
3. **Overload pairs for every mutation.** `attach(ctx, agentId, scopeRef, secretId)` and
   `attach(ctx, agentId, input)`; the same two for `detach`; and `attachWithReference` duplicating
   `attach` with a wider return type (README:96-100). The tool calls `attachWithReference`, so
   `attach` exists only as a narrower alias of the operation the product actually uses.
4. **`attach_secret` spreads a tool definition for no reason.**
   `tools/attach_secret.ts:27-46` returns `{ ...defineAgentTool({ ... }) }`. Every sibling tool
   returns the definition directly. The spread copies own enumerable properties and can silently drop
   anything `defineAgentTool` attaches non-enumerably or via prototype.
5. **`SecretsModule.ts` is 1,517 lines** and `SecretDatabase.ts` 552. AGENTS.md: "A file should hold
   one coherent piece of behavior. Most product code lands at one function per file."
6. **`reference_secret` renders a single reference through the page formatter.**
   `tools/reference_secret.ts:40-43` calls `formatForModel({ secrets: [secret], limit: 1 })`,
   synthesizing a fake one-row page so it can reuse a list renderer — the only reason a page
   abstraction appears in a single-item lookup.
7. **The list formatter retries with a smaller limit until the text fits.** README:53-56. A read
   whose page size silently shrinks based on rendered character count makes the cursor's meaning
   depend on formatting, so a model paging through `list_secrets` cannot predict how many rows a
   cursor step covers. The module's own store contract requires the cursor to "advance by exactly
   the number of rows returned," so the two rules are in tension by construction.
8. **`Type.Record(..., { additionalProperties: false })`** appears on
   `secretEnvironmentSchema` (`Secret.ts:83-90`), `secretEnvironmentPatchSchema` (92-100), and
   `secretHostEnvironmentSchema` (220-227). For a `Type.Record` whose key pattern already governs
   admissible properties, `additionalProperties: false` is at best redundant and at worst rejects
   valid records depending on TypeBox's record/pattern-properties handling. v1 writes the same
   records the same way (`rig/sources/secrets/types.ts:20-23`), so this is inherited rather than
   introduced by the rewrite — worth confirming once and fixing in v2.

## What it gets right

The value-confinement invariant is the module's real contribution and it is enforced structurally,
not by convention: `secretReferenceSchema` (`Secret.ts:103-119`) has no value-bearing property at
all, `resolveForHost` and `resolveForCommand` are deliberately not tools, and every event and
model-facing string is validated and deep-frozen before it leaves the module (README:152-155). The
`resolveForCommand` contract is a genuine improvement over v1's environment merge: it returns
`{ environment, hiddenEnvironmentVariables }` so the command host removes ambient names
case-insensitively *before* adding resolved values, and it rejects a case-insensitive collision
between two selected secrets rather than applying last-write-wins (README:105-117) — real
correctness gained instead of silently shadowing a variable. Reserving `github` and `project-git` as
host-managed identities prevents an agent from shadowing a managed credential. The retry story is
honest and simple: every mutation is an overwrite, so `durable: true` is truthful and no receipt or
replay ledger is needed (README:14-17), which is exactly what plan 21 asks for. TypeBox is used
throughout with types derived by `Static`, per policy.
