import { describe, it } from "vitest";

/**
 * These five scenarios were asked for and cannot run in this repository today,
 * end to end, through any real client-reachable path. This file records why,
 * precisely, so each `it.skip` below can be turned into a real gym test the
 * moment the gap it names is closed -- without weakening what it proves or
 * routing around the missing path.
 *
 * `packages/rig/sources/session-sharing/peer-access/` is a fully built and
 * unit-tested module (see its own `tests/`): the two gates, the confinement
 * precondition, the socket adapter, the audit trail, and the revocation state
 * machine are all real code with real coverage. What is missing is everything
 * that would let an actual client -- the way a gym test is required to drive
 * behavior, per this package's README principle 5 ("interact like a user...
 * avoid calling application internals to move a scenario forward") -- ever
 * reach that module at all:
 *
 * 1. The daemon never constructs a `PeerCapabilityContext` or a
 *    `PeerTerminalViewerService`, and never resolves a session's Docker
 *    execution config for peer access. `createSessionShareKind(...)` accepts
 *    `docker`, `peerAccess`, and `peerTerminalViewer` options (see
 *    `packages/rig/sources/session-sharing/createSessionShareKind.ts`), but
 *    its one production call site,
 *    `packages/rig/sources/server/runLocalProtocolServer.ts` (search
 *    `createSessionShareKind({`), passes none of the three. Confirmed by
 *    grepping the whole `packages/rig/sources/server/` tree: it contains zero
 *    references to `PeerTerminalViewerService`, `PeerCapabilityContext`,
 *    `sendMemberControl`, or `openMemberEphemeralChannel`.
 *
 *    A direct, observable consequence: because `docker` is never wired,
 *    `resolveOfferablePeerCapabilities` always resolves against `undefined`,
 *    so granting `terminal_view` is refused today for *every* project, not
 *    only host projects -- see
 *    `peer_terminal_capability_grant_is_refused_without_a_container.test.ts`
 *    in this directory, which proves the refusal path is correct for a host
 *    project (where the same answer is also the intended one, whether or not
 *    this gap exists).
 *
 * 2. Even with that wiring restored, there is no HTTP or WebSocket route
 *    anywhere in `packages/rig/sources/server/` through which a friend's own
 *    client asks its daemon to send the `peer.terminal.attach` Murmur control
 *    frame (`PEER_TERMINAL_ATTACH_CONTROL_ID` in
 *    `packages/rig/sources/session-sharing/peer-access/handlePeerTerminalControl.ts`)
 *    or to open its side of the ephemeral channel
 *    (`ShareTransport.openMemberEphemeralChannel`) and relay the resulting
 *    bytes back to a client the way `attachRemoteTerminalWebSocketServer.ts`
 *    does for the owner's own terminals. `handlePeerTerminalControl` only
 *    ever runs on the *owner's* daemon, in response to a control frame that,
 *    in this build, nothing anywhere ever sends.
 *
 * Both gaps sit outside `packages/gym-tests/` and are not lane-boot problems,
 * so fixing them is outside this task's scope; see this task's own
 * instructions. Each skip below states the scenario it would prove and the
 * concrete steps a real test would take, reusing the same owner+friend+relay
 * harness as `session_sharing_is_reachable_and_replicates_the_transcript.test.ts`
 * and `peer_terminal_capability_grant_is_refused_without_a_container.test.ts`,
 * plus a Docker-mode owner Gym (`--docker-image`, `dockerSocket: true`, as in
 * `docker_session_routes_files_and_commands_to_container.test.ts`) so the
 * project actually has a container execution environment once wiring exists.
 */
describe("peer terminal_view attach (blocked on daemon wiring described above)", () => {
    it.skip("mirrors an owner's Docker terminal to a friend who holds terminal_view: snapshot-then-deltas arrive, and what the owner types becomes visible to the friend", () => {
        // Once wired: owner Gym in `mode: "docker"` with a container execution
        // environment; friend Gym in `just-bash`. Complete the friend-request and
        // session-share dance from the sibling test in this directory. PUT
        // `terminal_view` onto the friend's `shareMemberId` and expect 200. Open a
        // terminal on the owner (`POST /projects/{id}/terminals`). Drive the
        // friend's client to attach the same way a real client would once the
        // missing route in gap 2 above exists, decode frames with
        // `RemoteTerminalProtocolClient` + `GhosttyRemoteTerminalReplica` exactly as
        // `remote_terminal_api_streams_ghostty_frames.test.ts` does for an owner's
        // own terminal, and assert the friend's replica shows text the owner typed
        // into the owner's real PTY.
    });

    it.skip("refuses a viewer's input and resize attempts rather than dropping them silently, because attach always requests input: false", () => {
        // Once wired: same setup as above. Attempt `protocol.writeInput(...)` and a
        // resize from the friend's attached client and assert each is refused by
        // the existing input-lease check `RemoteTerminal.attach` already enforces
        // for "input: false" viewers (see `packages/rig/sources/terminal/RemoteTerminal.ts`
        // and its existing gym coverage in
        // `remote_terminal_protocol_reports_redraw_and_network_pressure.test.ts`),
        // not merely that the owner's terminal state stays unaffected.
    });

    it.skip("closes the friend's channel in flight the moment the owner revokes, with no further frames arriving, and the in-memory close preceding the transport revoke", () => {
        // Once wired: with the friend actively attached and receiving deltas, call
        // `POST /sessions/{session}/share/members/{id}/revoke` on the owner. Assert
        // the friend's WebSocket/channel closes promptly and no further terminal
        // bytes arrive. `PeerCapabilityContext.invalidate` (see
        // `packages/rig/sources/session-sharing/peer-access/PeerCapabilityContext.ts`)
        // documents that the synchronous local close is the step that actually
        // secures a revocation, ahead of the best-effort transport revoke and
        // capability broadcast -- assert that ordering if it can be observed, for
        // example by comparing when the friend's socket closes against when
        // `GET /sessions/{session}/share/peer-activity` or the capability-changed
        // event reflects the revoke.
    });

    it.skip("denies a friend with no terminal_view grant who tries to attach, with a readable English refusal rather than a silent drop", () => {
        // Once wired: friend attempts `peer.terminal.attach` without ever having
        // been granted the capability. Assert the denial reason is exactly the
        // sentence `PeerCapabilityContext.authorize` already produces and that
        // `PeerCapabilityContext.test.ts` already unit-tests: "You do not have
        // permission to do this in this shared session. The person who shared it
        // has not granted it, or has taken it back." The reachable part of this
        // scenario -- that a friend with nothing granted reads capabilities as
        // empty, described as "Read the conversation only" -- is already proven in
        // `peer_terminal_capability_grant_is_refused_without_a_container.test.ts`.
    });
});
