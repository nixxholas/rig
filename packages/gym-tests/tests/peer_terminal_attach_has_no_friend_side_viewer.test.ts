import { describe, it } from "vitest";

/**
 * These four scenarios were asked for and still cannot run end to end in this
 * repository, because increment 1 deliberately ships only the owner's half of
 * the mirror. This file records exactly what exists and what does not, so each
 * `it.skip` below can become a real gym test the moment the gap it names is
 * closed -- without weakening what it proves or routing around a missing path.
 *
 * What is real. `packages/rig/sources/session-sharing/peer-access/` is built,
 * unit-tested (see its own `tests/`), and wired into the daemon:
 * `runLocalProtocolServer.ts` constructs a `PeerCapabilityContext` and a
 * `PeerTerminalViewerService` and passes them, with the project's Docker
 * config, into `createSessionShareKind({...})`. A friend's own client has a
 * route -- `POST /session-share-replicas/{shareId}/terminal` -- that makes its
 * daemon send the `peer.terminal.attach` Murmur control frame, and on the
 * owner's daemon `handlePeerTerminalControl` runs both gates, checks the
 * terminal's confinement, and really does call `terminal.attach(stream,
 * { input: false })` and write wire packets onto the peer channel.
 *
 * What is missing is the friend's *viewer*. Nothing on a member's daemon calls
 * `SessionShareService.peerChannel(...)` (the member side of
 * `ShareTransport.openMemberEphemeralChannel`), so the frames the owner emits
 * are decrypted by nobody, and there is no client-facing socket that carries
 * them to a replica the way `attachRemoteTerminalWebSocketServer.ts` does for
 * the owner's own terminals. Every scenario below needs a friend who can *see*
 * something, so every one of them needs that consumer first. This is the
 * sequencing the task asked for -- the enforcement boundary lands before the
 * pixels -- not an accident, and it fails closed: with no consumer, an
 * over-permissive gate would still show nobody anything.
 *
 * Each skip states the scenario it would prove and the concrete steps a real
 * test would take, reusing the same owner+friend+relay harness as
 * `session_sharing_is_reachable_and_replicates_the_transcript.test.ts` and
 * `peer_terminal_capability_grant_is_refused_without_a_container.test.ts`,
 * plus a Docker-mode owner Gym (`--docker-image`, `dockerSocket: true`, as in
 * `docker_session_routes_files_and_commands_to_container.test.ts`) so the
 * project actually has a container execution environment.
 */
describe("peer terminal_view attach (blocked on the friend-side viewer described above)", () => {
    it.skip("mirrors an owner's Docker terminal to a friend who holds terminal_view: snapshot-then-deltas arrive, and what the owner types becomes visible to the friend", () => {
        // Once a viewer exists: owner Gym in `mode: "docker"` with a container
        // execution environment; friend Gym in `just-bash`. Complete the
        // friend-request and session-share dance from the sibling test in this
        // directory. PUT `terminal_view` onto the friend's `shareMemberId` and expect
        // 200. Open a terminal on the owner (`POST /projects/{id}/terminals`). Have
        // the friend's client call `POST /session-share-replicas/{shareId}/terminal`,
        // read the mirrored bytes off whatever surface the friend-side viewer comes
        // to expose, decode frames with
        // `RemoteTerminalProtocolClient` + `GhosttyRemoteTerminalReplica` exactly as
        // `remote_terminal_api_streams_ghostty_frames.test.ts` does for an owner's
        // own terminal, and assert the friend's replica shows text the owner typed
        // into the owner's real PTY.
    });

    it.skip("refuses a viewer's input and resize attempts rather than dropping them silently, because attach always requests input: false", () => {
        // Once a viewer exists: same setup as above. Attempt `protocol.writeInput(...)` and a
        // resize from the friend's attached client and assert each is refused by
        // the existing input-lease check `RemoteTerminal.attach` already enforces
        // for "input: false" viewers (see `packages/rig/sources/terminal/RemoteTerminal.ts`
        // and its existing gym coverage in
        // `remote_terminal_protocol_reports_redraw_and_network_pressure.test.ts`),
        // not merely that the owner's terminal state stays unaffected.
    });

    it.skip("closes the friend's channel in flight the moment the owner revokes, with no further frames arriving, and the in-memory close preceding the transport revoke", () => {
        // Once a viewer exists: with the friend actively attached and receiving deltas, call
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
        // Reachable already on the request side -- the friend can call
        // `POST /session-share-replicas/{shareId}/terminal` without ever having been
        // granted the capability -- but the refusal it produces is only observable to
        // the owner, and the friend's own "the channel simply never opened" signal
        // needs the viewer. Assert the denial reason recorded on
        // `GET /sessions/{session}/share/peer-activity` is exactly the sentence
        // `PeerCapabilityContext.authorize` already produces and that
        // `PeerCapabilityContext.test.ts` already unit-tests: "You do not have
        // permission to do this in this shared session. The person who shared it
        // has not granted it, or has taken it back." The reachable part of this
        // scenario -- that a friend with nothing granted reads capabilities as
        // empty, described as "Read the conversation only" -- is already proven in
        // `peer_terminal_capability_grant_is_refused_without_a_container.test.ts`.
    });
});
