import { describe, expect, it, vi } from "vitest";

import type { SharedSessionEphemeralChannel } from "@slopus/murmur/sharedSession";

import type { DockerExecutionConfig } from "../../../execution/index.js";
import type { RemoteTerminal } from "../../../terminal/RemoteTerminal.js";
import {
    PEER_TERMINAL_NEEDS_CONTAINER,
    resolvePeerTerminalConfinement,
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

/** Only `.attach` is ever called on this by `PeerTerminalViewerService`. */
function fakeTerminal(): RemoteTerminal {
    return { attach: () => () => undefined } as unknown as RemoteTerminal;
}

function makeService(
    options: {
        docker?: DockerExecutionConfig | undefined;
        recordAction?: (entry: unknown) => void;
    } = {},
): { capabilities: PeerCapabilityContext; service: PeerTerminalViewerService } {
    const capabilities = new PeerCapabilityContext({
        recordAction: options.recordAction ?? (() => undefined),
        // Gate one and gate two both pass by default, so these tests exercise only the
        // confinement precondition and the attachment bookkeeping below it.
        resolveGrant: (candidate) => ({ grantEpoch: candidate.grantEpoch, sessionMode: "auto" }),
    });
    const service = new PeerTerminalViewerService({
        capabilities,
        docker: () => options.docker,
        terminal: () => fakeTerminal(),
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

describe("resolvePeerTerminalConfinement", () => {
    it("refuses a host terminal with the container explanation", () => {
        expect(resolvePeerTerminalConfinement(undefined)).toEqual({
            reason: PEER_TERMINAL_NEEDS_CONTAINER,
        });
    });
});

describe("PeerTerminalViewerService.attach", () => {
    it("denies a project with no Docker config with the container explanation, and records a denied audit action", () => {
        const recordAction = vi.fn();
        const { service } = makeService({ docker: undefined, recordAction });

        const result = service.attach(attachRequest());

        expect(result).toEqual({ outcome: "denied", reason: PEER_TERMINAL_NEEDS_CONTAINER });
        expect(recordAction).toHaveBeenCalledWith(
            expect.objectContaining({ capability: "terminal_view", outcome: "denied" }),
        );
    });

    it(`enforces MAX_PEER_ATTACHED_TERMINALS: the ${String(MAX_PEER_ATTACHED_TERMINALS + 1)}th distinct attach is denied`, () => {
        const docker: DockerExecutionConfig = { workingDirectory: "/work" };
        const { service } = makeService({ docker });

        for (let index = 0; index < MAX_PEER_ATTACHED_TERMINALS; index += 1) {
            const result = service.attach(
                attachRequest({
                    shareMemberId: `member-${String(index)}`,
                    terminalId: `term-${String(index)}`,
                }),
            );
            expect(result.outcome).toBe("attached");
        }
        expect(service.attachedCount).toBe(MAX_PEER_ATTACHED_TERMINALS);

        const overflow = service.attach(
            attachRequest({ shareMemberId: "member-overflow", terminalId: "term-overflow" }),
        );

        expect(overflow.outcome).toBe("denied");
        expect(service.attachedCount).toBe(MAX_PEER_ATTACHED_TERMINALS);

        service.close();
    });

    it("replaces rather than accumulates when the same member reattaches the same terminal", () => {
        const docker: DockerExecutionConfig = { workingDirectory: "/work" };
        const { service } = makeService({ docker });

        const first = service.attach(attachRequest());
        expect(first.outcome).toBe("attached");
        expect(service.attachedCount).toBe(1);

        const second = service.attach(attachRequest({ channel: fakeChannel() }));
        expect(second.outcome).toBe("attached");
        expect(service.attachedCount).toBe(1);

        service.close();
    });
});
