# Sharing

Everything sharing needs that is not about _what_ is shared. A session's
transcript, a workspace, and a project all ride the same encrypted Murmur
shared-session transport; this module owns that transport, and the per-kind
modules (`session-sharing`, `scope-sharing`) own the subject matter.

```
                     session-sharing/            scope-sharing/
                     SessionShareService         ScopeShareService
                             |                          |
                             +------------+-------------+
                                          |
                                 ShareKindRuntime
                                          |
  createShareRuntime  ---  one MurmurShareTransport  ---  one MurmurShareDirectory
                                          |                        |
                                one Murmur event router     one-use key packages
                                                             and invitations
```

## Why one of everything

`createShareRuntime` registers exactly one Murmur event router and builds exactly
one `MurmurShareDirectory`. Both are singletons by construction: two directories
would race each other over one-use key-package offers, and two routers would race
over relay cursors, which is silent data loss rather than a visible failure. So
every kind of share is registered into the single runtime and told apart by the
kind its `shareId` carries.

## What lives here

- `ShareTransport.ts` — the transport contract and its TypeBox schemas. It is
  share-generic: it moves opaque canonical-JSON entries and knows nothing about
  sessions, workspaces, or projects.
- `MurmurShareTransport.ts` — the real adapter over Murmur's shared-session
  protocol. This is the subtlest code in the feature: duplicate-append
  discrimination on sequence gaps, the two-consecutive-idle-passes retry rule,
  the deferred/retained relay-cursor contract, member tombstones, and
  `resetRuntime`.
- `MurmurShareDirectory.ts` — Murmur ships no key-package directory and no
  invitation inbox, so this transports both over Rig's encrypted friend channel
  and keeps its bounded state in the Murmur store, never in Rig's database.
- `FakeShareTransport.ts` — the in-memory transport the contract tests and the
  service tests run against.
- `canonicalShareJson.ts` — the byte-identical JSON and content hash both sides
  derive for the same entry.
- `shareId.ts` — the kind a share carries in its own identifier: `wsp_` for a
  workspace, `prj_` for a project, and a bare cuid2 for a session. Existing
  session share IDs are primary keys bound into Murmur's durable records and
  signed into invitations, so they cannot be reformatted; the unprefixed form is
  that kind's rule rather than a compatibility branch. Because a `shareId` is
  signed into every invitation and bound into every frame, the prefix is
  authenticated.
- `createShareRuntime.ts` — the assembly: transport, directory, event router,
  backfill backoff, key-package and invitation observation, and runtime-change
  reset.
- `impl/shareCodec.ts` — the wire and stored records the directory exchanges.

## Kinds

A kind supplies a `ShareKindRuntime`: the durable history it offers a new member,
how it joins and resumes replicas, how it recovers its owner shares, and what it
must flush once Murmur's transaction commits. `createShareRuntime` dispatches to
it on the kind decoded from the `shareId`, and hands back whatever each factory
built so a caller can reach that kind's own daemon surface.
