# Peer capability access

What one _other person_ may do in a shared session. It is deliberately not part
of [`../../permissions`](../../permissions): that module expresses the authority
the owner has delegated to their own agent, and a friend is neither the owner
nor the agent.

```
  owner grants                      friend acts
       |                                 |
       v                                 v
  capability row  ------ gate 1 ---> PeerCapabilityContext
  (member, epoch)                          |
                                        gate 2
                                           |
                            resolvePeerCapabilityCeiling(sessionMode, capability)
                                           |
                                           v
                              PeerTerminalViewerService
                                           |
                     createPeerChannelSocket  ->  WebSocketDuplex
                                           |
                              terminal.attach(stream, { input: false })
```

## A friend is a principal, not a mode

`PermissionContext` is unchanged and always will be by this module. There is no
fifth `PermissionMode` for a friend and nothing in the agent loop dispatches on
who is asking. The dependency runs one way — `peer-access` may use
`permissions`; nothing in `permissions` or `agent` may use `peer-access`.

The product already said this once, in
[`createAutoPermissionTranscript.ts`](../../permissions/createAutoPermissionTranscript.ts):
a friend's message is excluded from Auto's authorization evidence entirely. That
line is the same rule as this whole directory, one capability earlier.

## Two gates, both required, every single time

**Gate one is durable.** `(shareId, shareMemberId, grantEpoch, capability)` has
to resolve to an active row whose epoch is the member's _current_ epoch, on a
member who is themselves active. Revoking and re-inviting bumps the epoch, so a
grant written under the old one is structurally unusable rather than merely
stale. Absence of a row is denial; there is no "none" state to get wrong.

**Gate two is live.** `resolvePeerCapabilityCeiling(sessionMode, capability)` is
`minimumPermissionMode` of the session's mode right now and the capability's own
ceiling, which for `terminal_view` is Read only. The owner sitting in Full
access does not produce a full-access friend, and Auto's review path is never
reached by a peer action at all, so no peer can trigger an elevation. Both are
re-evaluated on every action, because the capability is stored as intent and
what it amounts to is worked out at the moment it is used.

## Revocation is a state machine, in this order

1. The persistence transaction marks the capability revoked and updates the
   member and grant rows, and **commits**.
2. Synchronously after that commit, and entirely inside the owner's daemon,
   `PeerCapabilityContext.invalidate` bumps its revision, closes every open peer
   channel for that member, detaches the peer terminal attachment, and rejects
   what was in flight. **This is the step that secures the revocation.**
3. Asynchronously and best-effort: the transport revoke and the capability
   broadcast. If step three never lands, the friend's screen keeps a stale
   label on a channel that has already been dead since step two.

Every long-lived channel captures the revision it was authorized under and
re-checks it, exactly as `assertPermissionRevision` does for the owner's own
mode.

## Why a peer terminal must be a container terminal

`terminal_view` is offerable only in a project with a configured Docker
execution environment. This is the load-bearing decision of the whole feature,
so it is stated where it is enforced, in
[`impl/peerTerminalConfinement.ts`](impl/peerTerminalConfinement.ts):

A shell on the owner's machine reaches `~/.claude`, `~/.codex`, `~/.ssh`,
`~/.aws`, the daemon's environment, and the managed proxy. Rig's Read only mode
deliberately still permits reading the host filesystem, so **no permission mode
in this product makes a host shell safe to hand to another human**. Mirroring is
not a safer subset of typing either: the owner's own `cat ~/.codex/auth.json`
mirrors straight to the friend. Without a container there is no honest version
of this feature, so it fails closed with that sentence in English.

Peer-attached terminals also hold their own small budget under the project's
`MAX_TERMINALS`, so a friend cannot exhaust the owner's.

## No second terminal protocol

`RemoteTerminal`, `RemoteTerminalManager`, and the canonical Ghostty emulator
are untouched. A friend gets one more `attach(stream, { input: false })` — the
same call `attachRemoteTerminalWebSocketServer` makes — so snapshot-then-deltas,
resize barriers, input leases, epoch invalidation, and credit-based flow control
are all inherited. "Holds no lease that may write" is an existing, already
tested state of the protocol; dropping input bytes higher up would have left the
lease machinery somewhere it was never designed to be. A viewer cannot resize
either, refused through the same lease check that refuses its input.

The peer channel is one discriminator byte and a payload: `0x01` carries one
complete ghostty-web wire packet exactly as the WebSocket transport carries it,
`0x00` carries flow control and close.
[`impl/createPeerChannelSocket.ts`](impl/createPeerChannelSocket.ts) presents the
Murmur ephemeral channel as a `BinaryWebSocket`, which is the interface
`WebSocketDuplex` and the replica already speak. That adapter is the entire
integration; no new terminal protocol code exists on this path.

Loss ends an attachment rather than corrupting it. A dropped ephemeral frame is
a hole in an ordered byte stream that the wire decoder cannot resynchronize
past, and reattaching is cheap because the protocol opens with a snapshot.
