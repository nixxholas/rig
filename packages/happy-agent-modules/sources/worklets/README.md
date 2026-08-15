# Worklets

Worklets are background TypeScript compute that lives in Rig. This module owns
the worklet **filesystem**, module-owned database, and the common agent-facing management tools. It
verifies a source folder, copies it into the versioned install layout itself,
and records durable metadata through its own database. It does not start a
process, build code, own a timer, or enforce a runtime process sandbox.

```ts
import { WorkletsModule } from "@slopus/happy-agent-modules";

const worklets = new WorkletsModule({ runtime, installRoot });
```

## Filesystem layout

Every worklet lives under one kebab-case-named folder in the install root. The
install root is the `installRoot` option, defaulting to the user-visible
worklets folder (`~/Happy/Worklets` on macOS, `~/happy/worklets` elsewhere,
overridable with `HAPPY_WORKLETS_DIRECTORY`):

```
<root>/<name>/favicon.png   the icon, beside the versions
<root>/<name>/Data/         durable state that survives every version change
<root>/<name>/v1/           the first install
<root>/<name>/v2/           the next update
```

Install copies the source into `v1`, creates the `Data` folder, and writes the
icon. Each update adds the next version folder with a change description; any
earlier version can be made current again with revert, without deleting the
others. `Data` is created once on install and is never destroyed by an update,
a revert, or a re-install. Removing a worklet deletes its icon and every
version folder while keeping `Data`, so a later re-install under the same name
finds the same state.

## Safe, verified installs

The module verifies before it writes. Every source entry is `lstat`ed;
symbolic links, special files, files over 10 MiB, and trees over 10,000 files
or directories, or 100 MiB are refused. Each version is copied into a hidden
staging directory
and atomically renamed into place before the module database mutation, so the database
never records a version whose files are not fully written. A failed mutation
compensates that move, and the icon that a commit moves aside can be restored.
Each installed version carries provenance metadata, so a revert cannot reuse a
stale or unrelated directory. The installer writes only inside
`<root>/<name>` and only ever adds a new version folder, the icon, or the
`Data` folder — it never mutates an existing version. This is the
installation-side of the one boundary worklets enforce: a worklet writes into
its own `Data` folder and nowhere else. Confining a running worklet's writes at
runtime is a separate concern this module does not implement.

On the next operation, reconciliation removes hidden copy leftovers and final
version directories that have no matching catalog version. This repairs a
crash between the filesystem rename and the catalog mutation without touching
`Data`.

A worklet's declared operations come from an optional `worklet.json` manifest at
the root of the source folder (`{ "operations": [{ "name", "description"? }] }`).
The module reads and validates it while staging the version.

Containment is checked with resolved pathnames and re-checked immediately
before each filesystem operation. This is cheap hardening, not a guarantee
against a same-account process that swaps an ancestor between the check and
the operation: Node does not expose the `openat`/directory-descriptor-relative
API needed to close that race here. Exploiting it requires a local process
that can already write inside `~/Happy/Worklets`; that process can already
write or delete elsewhere in the user's account directly, so the residual
race grants no privilege Rig was withholding.

## Module database and runtime

The module owns durable worklet rows, contiguous version history, the
current-version pointer, replay receipts, immutable mutation proofs, bounded
catalog paging, and its ordered database migration. It does not stage, commit,
or roll back source imports through an injected catalog — the module owns the
filesystem.

`WorkletRuntime` reports bounded status and logs and invokes one declared
operation with bounded JSON arguments and results. The module checks the
declaration before crossing this boundary.

## Common tools

All nine tools are provider-neutral, durable, and do not request Auto-mode
review:

- `install_worklet`
- `list_worklets`
- `get_worklet`
- `update_worklet`
- `revert_worklet`
- `remove_worklet`
- `get_worklet_status`
- `read_worklet_logs`
- `invoke_worklet_operation`

`install_worklet` and `update_worklet` take an absolute path to the worklet's
source folder. `get_worklet` pages a complete detail stream containing the
worklet name, owner, current version, status, timestamps, version change
descriptions, source references, and declared operation names/descriptions.
Log and invocation payloads are bounded at the runtime boundary and again at
the model-facing formatter.

## Durability and access

Install, update, revert, and remove receive a module-owned operation identity.
When a durable tool omits it, the module allocates and retains the identity
and request fingerprint in the call-scoped Agent Base `AgentKV`. The module
database stores a replay receipt and an independent before/after proof. Replays
verify both pieces of evidence and inspect the authoritative database without
reapplying the transition or repeating the filesystem work. A later opposite
transition is preserved; replay returns the original durable result and never
removes or reinstalls the newer state. A host call outside a durable tool must
provide its own operation ID; the module will not mint a retry identity
without a call-scoped `AgentKV`.

Proofs retain compact state identities and full-record fingerprints. Receipts
retain only the settled state identity plus the introduced version (and a
pointer to its preceding version receipt); replay reconstructs the original
result from that bounded chain after checking the authoritative database. This
keeps receipt storage proportional to the version history rather than copying
the complete history into every receipt. Catalog list pages are also bounded
by an aggregate encoded-byte cap, reducing an oversized page before it is
returned to an agent.

Removal cleanup is recoverable from that durable receipt and proof: if a
process exits before its post-commit cleanup callback runs, replaying the
settled removal observes the absent database row and schedules the code
reconciliation again. A recreated worklet is a new generation and is left
untouched.

Every changed mutation emits one frozen event. The same event object is handed
to `onEventTransactional` inside the module database transaction and to `onEvent` only
after the outermost commit through stdlib `afterCommit`. Post-commit listener errors are contained
and optionally reported through `onPostCommitError`; unchanged mutations,
status reads, log reads, and invocations emit nothing.

Worklet rows retain the installing agent identity for audit and host policy
decisions, but worklets are installation-global. With no injected
`authorization` policy, every agent may list, inspect, read logs from, invoke,
and manage every worklet. When supplied, `authorization` is an explicit host
restriction: a denied action blocks that cross-agent access, while self-access
continues to be allowed.
