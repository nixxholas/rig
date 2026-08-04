import { describe, expect, it } from "vitest";

import type { SessionSharedMetadata } from "../protocol/index.js";
import {
    describeActivePeerCapabilities,
    renderPeerCapabilityIndicator,
} from "./renderPeerCapabilityIndicator.js";

function share(overrides: Partial<SessionSharedMetadata> = {}): SessionSharedMetadata {
    return {
        capabilityMemberCount: 1,
        includeFriendMessagesInModel: false,
        memberCount: 1,
        offerableCapabilities: [
            {
                capability: "terminal_view",
                description: "They can watch a container terminal in this session as you use it.",
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

    it("joins several offerable capabilities the way a person reads a list", () => {
        const twoCapabilities = share({
            offerableCapabilities: [
                ...share().offerableCapabilities,
                {
                    capability: "terminal_view",
                    description: "A second capability for this test only.",
                    label: "Do a second thing",
                    offerable: true,
                },
            ],
        });
        expect(describeActivePeerCapabilities(twoCapabilities)).toBe(
            "watch a terminal and do a second thing",
        );
    });

    it("excludes capabilities that are not offerable here", () => {
        const unavailable = share({
            offerableCapabilities: [
                {
                    capability: "terminal_view",
                    description: "Needs a container.",
                    label: "Watch a terminal",
                    offerable: false,
                    unavailableReason:
                        "This session has no container environment to confine it to.",
                },
            ],
        });
        expect(describeActivePeerCapabilities(unavailable)).toBe("a capability");
        expect(renderPeerCapabilityIndicator(unavailable, 80)).not.toContain("terminal_view");
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
