import { describe, expect, it, vi } from "vitest";

import type { SharedSessionEphemeralChannel } from "@slopus/murmur/sharedSession";

import type { RemoteTerminal } from "../../../terminal/RemoteTerminal.js";
import type { RemoteTerminalConfinement } from "../../../terminal/RemoteTerminalProcess.js";
import {
    isPeerTerminalConfined,
    PEER_TERMINAL_NEEDS_CONTAINER,
    PEER_TERMINAL_NEEDS_SOLE_MEMBER,
} from "../impl/peerTerminalConfinement.js";
import { PeerCapabilityContext } from "../PeerCapabilityContext.js";
import {
    MAX_PEER_ATTACHED_TERMINALS,
    PeerTerminalViewerService,
    type PeerTerminalAttachRequest,
} from "../PeerTerminalViewerService.js";

function fakeChannel(): SharedSessionEphemeralChannel {
    return {
        close: () => undefined,
        epoch: 1,
        onDropped: () => () => undefined,
        onEpochChanged: () => () => undefined,
        onReceived: () => () => undefined,
        open: true,
        send: () => undefined,
    };
}

/** Only `.attach` and `.confinement` are ever read by `PeerTerminalViewerService`. */
function fakeTerminal(confinement: RemoteTerminalConfinement): RemoteTerminal {
    return { attach: () => () => undefined, confinement } as unknown as RemoteTerminal;
}

function makeService(
    options: {
        activeMemberCount?: number;
        confinement?: RemoteTerminalConfinement;
        recordAction?: (entry: unknown) => void;
        terminal?: () => RemoteTerminal | undefined;
    } = {},
): { capabilities: PeerCapabilityContext; service: PeerTerminalViewerService } {
    const capabilities = new PeerCapabilityContext({
        recordAction: options.recordAction ?? (() => undefined),
        // Gate one and gate two both pass by default, so these tests exercise only the
        // preconditions and the attachment bookkeeping below them.
        resolveGrant: (candidate) => ({ grantEpoch: candidate.grantEpoch, sessionMode: "auto" }),
    });
    const service = new PeerTerminalViewerService({
        activeMemberCount: () => options.activeMemberCount ?? 1,
        capabilities,
        terminal: options.terminal ?? (() => fakeTerminal(options.confinement ?? "container")),
    });
    return { capabilities, service };
}

function attachRequest(
    overrides: Partial<PeerTerminalAttachRequest> = {},
): PeerTerminalAttachRequest {
    return {
        channel: fakeChannel(),
        grantEpoch: 1,
        peerId: "peer-1",
        shareId: "share-1",
        shareMemberId: "member-1",
        terminalId: "term-1",
        ...overrides,
    };
}

describe("isPeerTerminalConfined", () => {
    it("accepts only a container, so anything else fails closed", () => {
        expect(isPeerTerminalConfined("container")).toBe(true);
        expect(isPeerTerminalConfined("host")).toBe(false);
    });
});

describe("PeerTerminalViewerService.attach", () => {
    it("refuses a host terminal with the container explanation, and records a denied audit action", () => {
        const recordAction = vi.fn();
        const { service } = makeService({ confinement: "host", recordAction });

        const result = service.attach(attachRequest());

        expect(result).toEqual({ outcome: "denied", reason: PEER_TERMINAL_NEEDS_CONTAINER });
        expect(recordAction).toHaveBeenCalledWith(
            expect.objectContaining({ capability: "terminal_view", outcome: "denied" }),
        );
        expect(service.attachedCount).toBe(0);
    });

    it("asks the terminal rather than the project, so a container configured after the terminal started does not confine it", () => {
        // The regression this exists for: a project that gains a Docker config while a
        // host terminal is already running. Asking the project would answer
        // "container" about a shell that still reads the owner's home directory.
        const { service } = makeService({ confinement: "host" });

        expect(service.attach(attachRequest())).toEqual({
            outcome: "denied",
            reason: PEER_TERMINAL_NEEDS_CONTAINER,
        });
    });

    it("refuses to mirror to a share that anybody else is in, because the channel reaches everybody", () => {
        const recordAction = vi.fn();
        const { service } = makeService({ activeMemberCount: 2, recordAction });

        expect(service.attach(attachRequest())).toEqual({
            outcome: "denied",
            reason: PEER_TERMINAL_NEEDS_SOLE_MEMBER,
        });
        expect(recordAction).toHaveBeenCalledWith(expect.objectContaining({ outcome: "denied" }));
        expect(service.attachedCount).toBe(0);
    });

    it("refuses a terminal that is not open any more", () => {
        const { service } = makeService({ terminal: () => undefined });

        expect(service.attach(attachRequest())).toEqual({
            outcome: "denied",
            reason: "That terminal is not open any more.",
        });
    });

    it(`enforces MAX_PEER_ATTACHED_TERMINALS: attachment ${String(MAX_PEER_ATTACHED_TERMINALS + 1)} is denied`, () => {
        const { service } = makeService();

        for (let index = 0; index < MAX_PEER_ATTACHED_TERMINALS; index += 1) {
            expect(
                service.attach(attachRequest({ terminalId: `term-${String(index)}` })).outcome,
            ).toBe("attached");
        }
        expect(service.attachedCount).toBe(MAX_PEER_ATTACHED_TERMINALS);

        const overflow = service.attach(attachRequest({ terminalId: "term-overflow" }));

        expect(overflow.outcome).toBe("denied");
        expect(service.attachedCount).toBe(MAX_PEER_ATTACHED_TERMINALS);

        service.close();
    });

    it("lets a peer already holding a terminal reattach to it even at the bound", () => {
        // The bound must not lock somebody out of the very attachment they occupy:
        // a reconnect replaces, so it can never push the count past the bound.
        const { service } = makeService();

        expect(service.attach(attachRequest()).outcome).toBe("attached");
        expect(service.attachedCount).toBe(MAX_PEER_ATTACHED_TERMINALS);

        const again = service.attach(attachRequest({ channel: fakeChannel() }));

        expect(again.outcome).toBe("attached");
        expect(service.attachedCount).toBe(1);

        service.close();
    });
});
