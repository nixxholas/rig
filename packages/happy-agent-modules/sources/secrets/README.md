# Secrets

Host-owned secret metadata and attachment management. An agent often needs a database URL, an API
key, or some other credential to do its work, but the value itself must never enter a model's
context, a tool argument, a transcript, or anything the model can see. This module lets a model
discover that a secret exists, read its safe description, and attach or detach it from an opaque
scope the host defines — while the value stays entirely on the host side, reachable only through a
method the module deliberately does not expose as a tool.

The module never stores a secret value itself, never opens a database, never edits
`process.env`, and never decides how a host applies a resolved value to a process or a command. All
of that is the host's job. The module only keeps the catalog of safe references and attachments
consistent and correct.

A mutation simply overwrites. Calling `register`, `update`, `attach`, or `detach` again — with the
same value or a different one — applies again and succeeds; the store carries no retry ledger, and
there is no way for a repeated call to be rejected because it "reused an identity" or "changed the
input." A retried tool call is safe by construction: it just re-runs the write.

```ts
import { Agent } from "@slopus/happy-agent-base";
import { SecretsModule } from "@slopus/happy-agent-modules";

const secrets = new SecretsModule({ store: hostSecretStore });
const agent = await Agent.create(ctx, { ...options, modules: [secrets] });
```

`store` is the only required option: a `SecretStore` the host implements over its own database or
vault. Everything else — `idFactory`, `eventIdFactory`, `clock`, `listener`, `authorize`,
`onPostCommitError`, `maxPageSize`, and `maxOutputCharacters` — has a working default and only
needs to be supplied when the host wants to control identity generation, subscribe to events,
enforce scope-level authorization, or tighten the bounds on list pages and model-facing text.

## Tools it provides to the model

The module offers four tools, all common (provider-neutral) and all `durable: true`, so a retried
tool call simply re-runs the underlying overwrite. None of them can reach the raw host resolver:
`resolveForHost` is intentionally not a tool. Every tool sets `shouldReviewInAutoMode: () => false`,
since none of them can leak a value or touch anything outside the secret catalog.

- **`list_secrets`** — lists a bounded page of safe metadata. Arguments: `limit` (1–`maxPageSize`,
  defaults to `maxPageSize`), `cursor` (an integer offset into the host's filtered result set), and
  `scopeRef` (restrict the page to secrets attached to one opaque scope). The model sees each
  secret's `id`, `description`, sorted-and-deduplicated `environmentVariables` names, `revision`,
  and, when the host set it, `availableToModel` and `kind`. If a page's rendered text would exceed
  `maxOutputCharacters`, the module retries with a smaller `limit` before giving up, so the model
  never receives a page it cannot read in full; a truncated `next=<cursor>` line is appended only
  when a further page still fits.
- **`reference_secret`** — reads one safe reference by `id` and returns `{ secret: reference | null }`.
  `null` means no such secret is registered; the tool never distinguishes "does not exist" from "you
  are not authorized" beyond what `authorize` decides.
- **`attach_secret`** — attaches a registered secret to a `scopeRef`, changing what is *available*,
  never returning a value. Arguments are `scopeRef` and `secretId`. On success the model is told
  which secret was attached to which scope and shown that secret's reference; the host resolves the
  actual value later, out of the model's sight, using `resolveForHost` against the same scope.
- **`detach_secret`** — detaches a `{ scopeRef, secretId }` pair and reports only `detached: boolean`
  plus the two identifiers, never a value.

Governing principles across all four: permissions are enforced only by the optional host
`authorize` callback plus whatever the host's own `SecretStore` does, since the module has no
notion of ownership itself; every list and lookup is bounded by `maxPageSize` and
`maxOutputCharacters`; paging is a monotonically progressing integer cursor the store must advance
by exactly the number of rows returned; and no schema, tool result, or formatted string produced
for the model carries a secret value — `secretReferenceSchema` has, by design, no value-bearing
property.

## External functions

`SecretsModule` is a class; a host or another module calls its methods directly with a `Context`
and the acting agent's ID, the same way the tools do internally.

- `list(ctx, actingAgentId, query?: SecretListInput): Promise<SecretPage>` — the same bounded,
  size-shrinking page logic the `list_secrets` tool uses.
- `reference(ctx, actingAgentId, secretId): Promise<SecretReference | undefined>` — one safe
  reference, or `undefined` if it does not exist.
- `register(ctx, actingAgentId, input: SecretRegistrationInput): Promise<SecretReference>` —
  registers a secret (host values plus description) and returns only its safe reference. A repeated
  call with an explicit `id` overwrites that secret's description and environment; a repeated call
  that omits `id` registers a new secret under a freshly generated one each time. Not exposed as a
  tool: registration is a host operation.
- `update(ctx, actingAgentId, secretId, input: SecretUpdateInput): Promise<SecretReference | undefined>`
  — patches `description` and/or `environment` (a `null` value removes that variable); `undefined`
  if the secret does not exist. A repeated call with the same patch is a no-op that returns the same
  reference and emits no further event.
- `remove(ctx, actingAgentId, secretId): Promise<boolean>` — removes a secret and its attachments
  atomically through the store; returns whether anything changed.
- `attach(ctx, actingAgentId, scopeRef, secretId)` and the `(ctx, actingAgentId, input: SecretAttachInput)` overload — returns `Promise<SecretAttachment>`, the same operation as the tool.
- `attachWithReference(...)` — same overloads as `attach`, but returns
  `Promise<SecretAttachReferenceResult>` (`{ attachment, secret }`), which is what the tool actually
  calls so it can render both the attachment and the reference in one result.
- `detach(ctx, actingAgentId, scopeRef, secretId)` / `(ctx, actingAgentId, input)` — `Promise<boolean>`.
- `resolveForHost(ctx, actingAgentId, scopeRef, secretIds?): Promise<SecretHostEnvironment>` — the
  one method that returns real values, deliberately not wrapped as a tool or ever rendered to a
  model. `secretIds`, when given, must be a de-duplicated array of at most 256 valid IDs.
- `formatForModel`, `formatPageForModel`, `formatAttachmentForModel`, `formatDetachForModel` —
  render results to the exact bounded text the tools send back, available to a host building its
  own presentation on top of the same methods.

Every mutating method (`register`, `update`, `remove`, `attach`/`attachWithReference`, `detach`)
runs inside `store.transaction`, emitting one `SecretEvent` (`secret_registered`, `secret_updated`,
`secret_removed`, `secret_attached`, or `secret_detached`) only when the mutation actually changed
something. A `SecretModuleListener` passed as `listener` gets `onEventTransactional` inside that
same transaction and `onEvent` after it commits (via `store.afterCommit`); `onPostCommitError` is
invoked, best-effort, if `onEvent` throws.

## Storage

The module keeps almost nothing itself. All catalog state — registrations and attachments — lives
in the host's own `SecretStore` (`sources/secrets/SecretStore.ts`), which the host implements and
passes in as `store`. Its shape:

- `list`, `reference`, `attachment` — bounded reads of the catalog.
- `register`, `update`, `remove`, `attach`, `detach` — mutations. Each simply applies against the
  current state and returns the outcome (`changed`/`removed`/`detached`, plus the resulting
  reference or attachment where relevant); the store does not need to remember anything about a
  call once it returns.
- `resolveForHost` — the resolver the host implements to actually produce values (a
  `SecretHostEnvironment`, i.e. a map of environment-variable name to string value, at most 256
  entries, values up to 65,536 characters) for a given scope. This is the only place a value ever
  appears.
- `transaction` / `afterCommit` — the host's own transactional and post-commit hooks, used for every
  mutation and for delivering `SecretEvent`s.

Identities are generated fresh on every call: `idFactory` (default `crypto.randomUUID()`) supplies a
new `SecretId` whenever `register` is called without an explicit `id`, and `eventIdFactory` (default
`crypto.randomUUID()`) supplies a fresh ID for each emitted `SecretEvent`, with `clock` (default
`Date.now()`) supplying its timestamp. There is no persisted call identity and nothing keyed to a
tool call's retry history: the module does not need `AgentKV` and does not read or write it.

Every value that crosses into an event or model-facing string is validated against its TypeBox
schema and deep-frozen before an event is handed to a listener, so nothing malformed or mutable
escapes the module's boundary.
