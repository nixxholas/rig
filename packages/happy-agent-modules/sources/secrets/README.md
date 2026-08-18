# Secrets

Host-owned secret metadata and attachment management. An agent often needs a database URL, an API
key, or some other credential to do its work, but the value itself must never enter a model's
context, a tool argument, a transcript, or anything the model can see. This module lets a model
discover that a secret exists, read its safe description, and attach or detach it from an opaque
scope the host defines — while the value stays entirely on the host side, reachable only through a
trusted-host method the module deliberately does not expose as a tool.

The module never edits `process.env`, starts a process, or decides how a host applies a resolved
value to a command. Values are confined to the module's own SQLite-backed catalog; they never enter
an event, model-facing result, or tool argument.

A mutation simply overwrites. Calling `register`, `update`, `attach`, or `detach` again — with the
same value or a different one — applies again and succeeds; the store carries no retry ledger, and
there is no way for a repeated call to be rejected because it "reused an identity" or "changed the
input." A retried tool call is safe by construction: it just re-runs the write.

```ts
import { Agent } from "@slopus/happy-agent-base";
import { SecretsModule } from "@slopus/happy-agent-modules";

const secrets = new SecretsModule();
const agent = await Agent.create(ctx, { ...options, modules: [secrets] });
```

The constructor takes nothing. The catalog, the clock, and identity generation are the module's own,
and its bounds are fixed constants it exports so a caller can read them but not change them:

- `SECRETS_PAGE_SIZE` (50) — how many references one page returns when the caller does not ask for
  fewer.
- `SECRETS_OUTPUT_CHARACTERS` (12,000) — the character budget every model-facing secrets result is
  trimmed to fit.

## Authorization

There is no authorization policy and no policy seam. Every method takes the acting agent's ID, and
that ID is the whole of the policy: an agent sees, mutates, and resolves only the secrets registered
under its own ID. Another agent's `reference` returns `undefined`, its `list` returns an empty page,
its `resolveForHost` returns an empty environment, and its `attach` fails because the reference does
not exist for it. Beyond that, and beyond the `availableToModel` flag that keeps host-only
credentials out of agent commands and the reserved `github` / `project-git` IDs, nothing is denied.

```text
model ── safe references/attachments ──> SecretsModule ── host-only values ──> command host
                                          │                                      │
                                          └── no values in tools/events ──────────┘
```

## Tools it provides to the model

The module offers four tools, all common (provider-neutral) and all `durable: true`, so a retried
tool call simply re-runs the underlying overwrite. None of them can reach the value-bearing methods:
`resolveForHost` and `resolveForCommand` are intentionally not tools. Every tool sets
`shouldReviewInAutoMode: () => false`,
since none of them can leak a value or touch anything outside the secret catalog.

- **`list_secrets`** — lists a bounded page of safe metadata. Arguments: `limit`
  (1–`SECRETS_PAGE_SIZE`, defaults to `SECRETS_PAGE_SIZE`), `cursor` (an integer offset into the
  filtered result set), and
  `scopeRef` (restrict the page to secrets attached to one opaque scope). The model sees each
  secret's `id`, `description`, sorted-and-deduplicated `environmentVariables` names, `revision`,
  and, when the host marked it, `availableToModel` and `kind`. A reference marked
  `availableToModel: false` is host-only and cannot be attached by an agent. If a page's rendered
  text would exceed `SECRETS_OUTPUT_CHARACTERS`, the module falls back to a compact rendering that
  still names every secret, so the model never loses an identity it could act on; a `next=<cursor>`
  line is appended only when a further page exists.
- **`reference_secret`** — reads one safe reference by `id` and returns `{ secret: reference | null }`.
  `null` means no such secret is registered under the acting agent's ID.
- **`attach_secret`** — attaches a registered model-available secret to a `scopeRef`, changing what
  is _available_, never returning a value. Arguments are `scopeRef` and `secretId`. On success the
  model is told which secret was attached to which scope and shown that secret's reference; the
  host resolves the actual value later, out of the model's sight, using `resolveForCommand` against
  the same scope.
- **`detach_secret`** — detaches a `{ scopeRef, secretId }` pair and reports only `detached: boolean`
  plus the two identifiers, never a value.

Governing principles across all four: ownership is the acting agent's ID and nothing else; every
list and lookup is bounded by `SECRETS_PAGE_SIZE` and
`SECRETS_OUTPUT_CHARACTERS`; paging is a monotonically progressing integer cursor the store advances
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
  — patches `description`, `environment` (a `null` value removes that variable), and/or
  `availableToModel`; `undefined` if the secret does not exist. A repeated call with the same patch
  is a no-op that returns the same reference and emits no further event.
- `remove(ctx, actingAgentId, secretId): Promise<boolean>` — removes a secret and its attachments
  atomically through the store; returns whether anything changed.
- `attach(ctx, actingAgentId, scopeRef, secretId)` and the `(ctx, actingAgentId, input: SecretAttachInput)` overload — returns `Promise<SecretAttachment>`, the same operation as the tool.
- `attachWithReference(...)` — same overloads as `attach`, but returns
  `Promise<SecretAttachReferenceResult>` (`{ attachment, secret }`), which is what the tool actually
  calls so it can render both the attachment and the reference in one result.
- `detach(ctx, actingAgentId, scopeRef, secretId)` / `(ctx, actingAgentId, input)` — `Promise<boolean>`.
- `resolveForHost(ctx, actingAgentId, scopeRef, secretIds?): Promise<SecretHostEnvironment>` —
  returns real values for a trusted host operation, deliberately not wrapped as a tool or ever
  rendered to a model. `secretIds`, when given, must be a de-duplicated array of at most 256 valid
  IDs.
- `resolveForCommand(ctx, actingAgentId, scopeRef, secretIds?): Promise<SecretCommandEnvironment>`
  — the compute seam. It returns `{ environment, hiddenEnvironmentVariables }`; the host must remove
  every hidden name case-insensitively from its ambient environment before adding the resolved
  values. Explicit IDs must already be attached to the scope and still be available to the model.
  The module performs the collision-safe merge itself and validates the final bounded contract.
- `formatForModel`, `formatPageForModel`, `formatAttachmentForModel`, `formatDetachForModel` —
  render results to the exact bounded text the tools send back, available to a host building its
  own presentation on top of the same methods.

Resolution rejects a case-insensitive environment-name collision between selected secrets rather
than applying silent last-write-wins. The command host owns the final merge with its ambient
environment; the module supplies the names that must be hidden first.

Every mutating method (`register`, `update`, `remove`, `attach`/`attachWithReference`, `detach`)
runs inside the Agent Base transaction, emitting one `SecretEvent` (`secret_registered`, `secret_updated`,
`secret_removed`, `secret_attached`, or `secret_detached`) only when the mutation actually changed
something.

Subscribe after construction. `onEventTransactional(listener)` runs the listener inside the
committing transaction — throwing there rolls the mutation back — and `onEvent(listener)` runs it
after the outer transaction commits. Both return an unsubscribe function, and calling it more than
once does nothing further.

```ts
const unsubscribe = secrets.onEvent((ctx, event) => {
    ctx.log.info({ type: event.type }, "a secret changed");
});
```

A post-commit listener that throws is logged through `ctx.log.error` and cannot roll the committed
change back or stop the remaining listeners.

## Storage

The module keeps the catalog in its Agent Base database, and its SQLite-backed store is the only
resolution path — there is no injectable resolver. `SecretStore` is the validated structural
boundary for those database result shapes. Its shape:

- `list`, `reference`, `attachment` — bounded reads of the catalog.
- `register`, `update`, `remove`, `attach`, `detach` — mutations. Each simply applies against the
  current state and returns the outcome (`changed`/`removed`/`detached`, plus the resulting
  reference or attachment where relevant); the store does not need to remember anything about a
  call once it returns.
- `resolveForHost` — reads values (a `SecretHostEnvironment`, i.e. a map of environment-variable
  name to string value, at most 256 entries, values up to 65,536 characters) for a given scope. This
  is the only place a value leaves storage.
- Agent Base's transaction and `afterCommit` boundary — used for every mutation and for delivering
  `SecretEvent`s after the outer transaction commits.

Identities are minted by the module on every call: `crypto.randomUUID()` supplies a new `SecretId`
whenever `register` is called without an explicit `id` and a fresh ID for each emitted
`SecretEvent`, with `Date.now()` supplying its timestamp. There is no persisted call identity and nothing keyed to a
tool call's retry history: the module does not need `AgentKV` and does not read or write it.

Every value that crosses into an event or model-facing string is validated against its TypeBox
schema and deep-frozen before an event is handed to a subscriber, so nothing malformed or mutable
escapes the module's boundary. Registrations under `github` and `project-git` are rejected because
those IDs belong to managed host credentials.

The legacy `request_secret` interaction is intentionally not a secrets-catalog operation. Asking a
person to enter or update a value belongs in the User Input module/client broker; this module only
stores or resolves a value after the host has supplied it.

Host integration debt remains for GitHub CLI token synchronization and the managed `project-git`
credential-proxy lease (`trustedLoopbackPorts`); those are not flat environment bundles and must be
owned by host infrastructure.
