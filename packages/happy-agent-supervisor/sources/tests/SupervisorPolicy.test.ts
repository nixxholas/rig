import { describe, expect, it } from "vitest";

import { parseSupervisorPolicy } from "../SupervisorPolicy.js";

describe("parseSupervisorPolicy", () => {
    it("accepts the ComputePermissions shape", () => {
        expect(
            parseSupervisorPolicy({
                mode: "workspace_write",
                deniedWritePaths: ["/workspace/.git"],
                network: { egress: true, allowedHosts: [], localBinding: false },
            }),
        ).toEqual({
            mode: "workspace_write",
            deniedWritePaths: ["/workspace/.git"],
            network: { egress: true, allowedHosts: [], localBinding: false },
        });
    });

    it("accepts an outgoing proxy on an already-connected descriptor", () => {
        const policy = parseSupervisorPolicy({
            mode: "workspace_write",
            network: {
                egress: true,
                allowedHosts: ["example.com"],
                localBinding: false,
                outgoingProxy: {
                    upstreamFd: 3,
                    token: "command-scoped-token",
                    frontEnds: ["http", "socks5"],
                    tlsTermination: { certificateAuthorityFile: "/tmp/authority.pem" },
                },
            },
        });

        expect(policy.network.outgoingProxy).toEqual({
            upstreamFd: 3,
            token: "command-scoped-token",
            frontEnds: ["http", "socks5"],
            tlsTermination: { certificateAuthorityFile: "/tmp/authority.pem" },
        });
    });

    it("rejects a proxy the supervisor could not act on", () => {
        for (const outgoingProxy of [
            { upstreamFd: 2, token: "token", frontEnds: ["http"] },
            { upstreamFd: 3, token: "", frontEnds: ["http"] },
            { upstreamFd: 3, token: "token", frontEnds: [] },
            { upstreamFd: 3, token: "token", frontEnds: ["ftp"] },
            { upstreamFd: 3, token: "token", frontEnds: ["http"], certificate: "/tmp/ca.pem" },
        ]) {
            expect(() =>
                parseSupervisorPolicy({
                    mode: "workspace_write",
                    network: { egress: true, localBinding: false, outgoingProxy },
                }),
            ).toThrow();
        }
    });

    it("rejects unknown policy fields", () => {
        expect(() =>
            parseSupervisorPolicy({
                mode: "auto",
                command: "sh -lc 'unsafe'",
                network: { egress: false, localBinding: false },
            }),
        ).toThrow();
    });
});
