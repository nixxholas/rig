# Module report: secrets

Reviewed: 2026-08-15. Scope: `packages/happy-agent-modules/sources/secrets/` compared against Rig's
secrets implementation (`packages/rig/sources/secrets/`, `packages/rig/sources/tools/secrets/`),
root `AGENTS.md`, and master plans 00, 08 (bash and background processes), 16, 20, 21.

## Summary

The module holds a catalog of secret *references* — id, description, environment-variable names,
revision — and a set of `(scopeRef, secretId)` attachments, and gives the model four tools:
`list_secrets`, `reference_secret`, `attach_secret`, `detach_secret`. Values never enter a schema,
event, tool argument, or formatted string; that invariant is real and well enforced. The problem is
the two mutating tools: they let the model decide which credentials become available to later
commands, and both set `shouldReviewInAutoMode: () => false`. In Rig, that same decision is the one
action that forces reviewed Full-access execution. It is consumed by `packages/happy-agent`
(`loadHappyAgent.ts:39`), not by Rig.

## How it differs from Rig's equivalents

- **Rig gives the model no attach or detach tool.** Rig's entire model-facing secrets surface is
  `request_secret` (`rig/sources/tools/secrets/requestSecret.ts:43-87`), which prepares a
  metadata-only attachment asking the *human* to enter a value in the client. Which secrets exist is
  told to the model in the system prompt (`createSecretInstructions.ts:6-13`), and which secrets a
  given command gets is chosen per command through the shell tool's `secrets` argument.
- **Rig couples that choice to review and elevation; the module does not.** AGENTS.md and the Rig
  prompt both say: "Selecting any attached secret also requires reviewed Full-access execution
  automatically" (`createSecretInstructions.ts:8`). `attach_secret` moves the same decision — making
  a credential reachable by a later command in a scope — into an unreviewed tool call
  (`tools/attach_secret.ts:36`). The README defends this on the grounds that the tools cannot "leak a
  value or touch anything outside the secret catalog" (README:44-46), which is true and beside the
  point: the catalog *is* the authorization surface. An agent that can attach `deploy-credentials`
  to its own scope without review has changed what the next reviewed command will be handed.
- **The module discards `request_secret` on purpose.** README:157-159 — "The legacy `request_secret`
  interaction is intentionally not a secrets-catalog operation." Calling Rig's only shipped secret
  tool "legacy" while adding two tools Rig does not have inverts the direction of travel; nothing in
  the plans authorizes that.
- **Scope typing.** Rig types the attachment scope as `SecretAttachmentScope = "project" | "session"`
  (`rig/sources/secrets/types.ts:71`). The module makes `scopeRef` an opaque 100-character string
  (`Secret.ts:25-34`) that the model supplies verbatim, with no enumeration of valid scopes and no
  way for the model to discover one. `kind` likewise widens Rig's
  `specialSecretKindSchema = Union([Literal("github")])` (`rig/sources/secrets/types.ts:43`) to a
  free-form 128-character pattern string (`Secret.ts:110-116`).
- **Reserved IDs.** Both reserve `project-git`; the module additionally reserves `github`
  (`Secret.ts:17-23`) and rejects registrations under either, which matches Rig's treatment of
  GitHub as a managed credential rather than an environment bundle. Correct.

## Findings

1. **The package contradicts the master plans.** Plans 16 and 21 place ready-made agent capabilities
   in `@slopus/happy-agent-features`; no master plan mentions `happy-agent-modules`. Per the
   master-plan rules this is a code-vs-plan contradiction to surface to the user.
2. **`attach_secret` grants credential availability without review.**
   `tools/attach_secret.ts:36` — `shouldReviewInAutoMode: () => false`. Even accepting that the
   module's own boundary is metadata-only, AGENTS.md requires each tool to own its Auto behavior
   against what the action *enables*, and requires an approval to disclose a specialized boundary via
   `describeAutoPermissionAction`. Neither `attach_secret` nor `detach_secret` sets one. `detach_secret`
   has the mirror problem in the other direction: silently removing a credential a running workflow
   depends on.
3. **Admitted host-integration debt shipped as prose.** README:161-163 — "Host integration debt
   remains for GitHub CLI token synchronization and the managed `project-git` credential-proxy lease
   (`trustedLoopbackPorts`); those are not flat environment bundles and must be owned by host
   infrastructure." Rig implements both today (`rig/sources/secrets/GitHubSecretSync.ts`, and the
   managed Git proxy referenced from `AGENTS.md`). The module reserves the IDs, declines the
   behavior, and records the gap in a README.
4. **Four copies of the same two-field shape.** `secretAttachmentSchema` (`Secret.ts:154-160`),
   `secretAttachInputSchema` (162-168), the tool-local `attachSecretInputSchema`
   (`tools/attach_secret.ts:11-17`), and the tool-local `detachSecretInputSchema`
   (`tools/detach_secret.ts:16-22`) are all `{ scopeRef, secretId }` with
   `additionalProperties: false`. A fifth name, `secretDetachInputSchema`, is an alias of the second
   (`Secret.ts:170`).
5. **Overload pairs for every mutation.** `attach(ctx, agentId, scopeRef, secretId)` and
   `attach(ctx, agentId, input)`; the same two for `detach`; and `attachWithReference` duplicating
   `attach` with a wider return type (README:96-100). The tool calls `attachWithReference`, so
   `attach` exists only as a narrower alias of the operation the product actually uses.
6. **`attach_secret` spreads a tool definition for no reason.**
   `tools/attach_secret.ts:27-46` returns `{ ...defineAgentTool({ ... }) }`. Every sibling tool
   returns the definition directly. The spread copies own enumerable properties and can silently drop
   anything `defineAgentTool` attaches non-enumerably or via prototype.
7. **`SecretsModule.ts` is 1,517 lines** and `SecretDatabase.ts` 552. AGENTS.md: "A file should hold
   one coherent piece of behavior. Most product code lands at one function per file."
8. **`reference_secret` renders a single reference through the page formatter.**
   `tools/reference_secret.ts:40-43` calls `formatForModel({ secrets: [secret], limit: 1 })`,
   synthesizing a fake one-row page so it can reuse a list renderer — the only reason a page
   abstraction appears in a single-item lookup.
9. **The list formatter retries with a smaller limit until the text fits.** README:53-56. A read
   whose page size silently shrinks based on rendered character count makes the cursor's meaning
   depend on formatting, so a model paging through `list_secrets` cannot predict how many rows a
   cursor step covers. The module's own store contract requires the cursor to "advance by exactly
   the number of rows returned," so the two rules are in tension by construction.
10. **`Type.Record(..., { additionalProperties: false })`** appears on
    `secretEnvironmentSchema` (`Secret.ts:83-90`), `secretEnvironmentPatchSchema` (92-100), and
    `secretHostEnvironmentSchema` (220-227). For a `Type.Record` whose key pattern already governs
    admissible properties, `additionalProperties: false` is at best redundant and at worst rejects
    valid records depending on TypeBox's record/pattern-properties handling. Rig writes the same
    records the same way (`rig/sources/secrets/types.ts:20-23`), so this is inherited rather than
    invented — worth confirming once for both.

## What it gets right

The value-confinement invariant is the module's real contribution and it is enforced structurally,
not by convention: `secretReferenceSchema` (`Secret.ts:103-119`) has no value-bearing property at
all, `resolveForHost` and `resolveForCommand` are deliberately not tools, and every event and
model-facing string is validated and deep-frozen before it leaves the module (README:152-155). The
`resolveForCommand` contract is better than a naive environment merge: it returns
`{ environment, hiddenEnvironmentVariables }` so the command host removes ambient names
case-insensitively *before* adding resolved values, and it rejects a case-insensitive collision
between two selected secrets rather than applying last-write-wins (README:105-117) — a real
correctness improvement over silently shadowing a variable. Reserving `github` and `project-git` as
host-managed identities prevents an agent from shadowing a managed credential. The retry story is
honest and simple: every mutation is an overwrite, so `durable: true` is truthful and no receipt or
replay ledger is needed (README:14-17), which is exactly what plan 21 asks for. TypeBox is used
throughout with types derived by `Static`, per policy.
