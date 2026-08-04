import { describe, expect, it } from "vitest";

import type { SessionSharedMetadata } from "../protocol/index.js";
import {
    describeActivePeerCapabilities,
    renderPeerCapabilityIndicator,
} from "./renderPeerCapabilityIndicator.js";

function share(overrides: Partial<SessionSharedMetadata> = {}): SessionSharedMetadata {
    return {
        activeCapabilitiesDescription: "watch a terminal",
        capabilityMemberCount: 1,
        includeFriendMessagesInModel: false,
        memberCount: 1,
        offerableCapabilities: [
            {
                capability: "terminal_view",
                description:
                    "They can watch a container terminal in this session, including whatever is already on its screen and in its scrollback when you turn this on.",
                grantWarning:
                    "Anything they see is theirs to keep, including what was already on that terminal when you turned this on. Turning it off stops what happens next; it cannot recall what has already been seen. Treat every credential that passes through a shared terminal as disclosed, and rotate it.",
                label: "Watch a terminal",
                offerable: true,
            },
        ],
        shareId: "share-1",
        state: "active",
        toolOutput: "summaries",
        toolOutputDescription: "Friends see tool summaries only.",
        ...overrides,
    };
}

describe("renderPeerCapabilityIndicator", () => {
    it("renders nothing when no member holds a capability, and never a raw capability code", () => {
        expect(renderPeerCapabilityIndicator(undefined, 80)).toBeUndefined();
        expect(
            renderPeerCapabilityIndicator(share({ capabilityMemberCount: 0 }), 80),
        ).toBeUndefined();
    });

    it("names what members can do in English, singular and plural", () => {
        expect(renderPeerCapabilityIndicator(share({ capabilityMemberCount: 1 }), 80)).toContain(
            "1 member can watch a terminal in this session",
        );
        expect(renderPeerCapabilityIndicator(share({ capabilityMemberCount: 2 }), 80)).toContain(
            "2 members can watch a terminal in this session",
        );
    });

    it("reads what members actually hold from activeCapabilitiesDescription, joined the way a person reads a list", () => {
        const twoCapabilities = share({
            activeCapabilitiesDescription: "watch a terminal and do a second thing",
        });
        expect(describeActivePeerCapabilities(twoCapabilities)).toBe(
            "watch a terminal and do a second thing",
        );
    });

    it("stays correct and grammatical even after the project's offerable list empties out from under a live grant", () => {
        // A grant can outlive the project's own offer: the container that confined it can be
        // removed without touching the grant that predates it. `offerableCapabilities` reflects
        // only what the project could offer a *new* grant, so it going empty here must not
        // change what this sentence says about members who already hold something.
        const offerGoneButGrantLive = share({
            activeCapabilitiesDescription: "watch a terminal",
            capabilityMemberCount: 1,
            offerableCapabilities: [
                {
                    capability: "terminal_view",
                    description: "Needs a container.",
                    grantWarning: "This capability can no longer be granted to anybody new.",
                    label: "Watch a terminal",
                    offerable: false,
                    unavailableReason:
                        "This session has no container environment to confine it to.",
                },
            ],
        });
        expect(describeActivePeerCapabilities(offerGoneButGrantLive)).toBe("watch a terminal");
        const rendered = renderPeerCapabilityIndicator(offerGoneButGrantLive, 80);
        expect(rendered).toContain("1 member can watch a terminal in this session");
        expect(rendered).not.toContain("terminal_view");
        expect(rendered).not.toContain("can a capability");
    });

    it("truncates to the available width without dropping the count", () => {
        const narrow = renderPeerCapabilityIndicator(share(), 24);
        expect(narrow).toBeDefined();
        expect(stripAnsi(narrow ?? "").length).toBeLessThanOrEqual(24);
    });
});

function stripAnsi(value: string): string {
    let result = "";
    for (let index = 0; index < value.length; index += 1) {
        if (value[index] !== "\u001b") {
            result += value[index];
            continue;
        }
        while (index < value.length && value[index] !== "m") index += 1;
    }
    return result;
}
