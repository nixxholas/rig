import { describe, expect, it } from "vitest";

import { computePermissions } from "../../../sources/ComputePermissions.js";
import { resolveDockerNetworkPermissions } from "../../../sources/docker/impl/resolveDockerNetworkPermissions.js";

describe("resolveDockerNetworkPermissions", () => {
    it("gives Workspace write unrestricted egress through the managed boundary", () => {
        const resolved = resolveDockerNetworkPermissions(
            computePermissions("workspace_write", {
                network: { egress: true, localBinding: false },
            }),
        );

        expect(resolved).toEqual({
            directEgress: false,
            managedPolicy: {
                allowPrivateAddresses: true,
                allowedDomains: [{ domain: "*" }],
            },
        });
    });

    it("keeps a command isolated when local binding is withheld", () => {
        const resolved = resolveDockerNetworkPermissions(
            computePermissions("auto", {
                network: { egress: true, localBinding: false },
            }),
        );

        expect(resolved.directEgress).toBe(false);
        expect(resolved.managedPolicy?.allowPrivateAddresses).toBe(true);
        expect(resolved.managedPolicy?.allowedDomains).toEqual([{ domain: "*" }]);
    });

    it("uses direct networking only when unrestricted egress and local binding are both granted", () => {
        expect(
            resolveDockerNetworkPermissions(
                computePermissions("workspace_write", {
                    network: { egress: true, localBinding: true },
                }),
            ),
        ).toEqual({ directEgress: true, managedPolicy: undefined });
    });

    it("maps an allowed-host list into an exhaustive managed policy", () => {
        expect(
            resolveDockerNetworkPermissions(
                computePermissions("auto", {
                    network: {
                        allowedHosts: ["registry.npmjs.org", "*.githubusercontent.com"],
                        egress: true,
                        localBinding: true,
                    },
                }),
            ),
        ).toEqual({
            directEgress: false,
            managedPolicy: {
                allowedDomains: [
                    { domain: "registry.npmjs.org" },
                    { domain: "*.githubusercontent.com" },
                ],
            },
        });
    });

    it("intersects operation hosts with the project network boundary", () => {
        expect(
            resolveDockerNetworkPermissions(
                computePermissions("workspace_write", {
                    network: {
                        allowedHosts: ["api.example.com", "blocked.example.com"],
                        egress: true,
                        localBinding: false,
                    },
                }),
                {
                    allowedDomains: [{ domain: "*.example.com", ports: [443] }],
                    deniedDomains: [{ domain: "blocked.example.com" }],
                },
            ),
        ).toEqual({
            directEgress: false,
            managedPolicy: {
                allowedDomains: [
                    { domain: "api.example.com", ports: [443] },
                    { domain: "blocked.example.com", ports: [443] },
                ],
                deniedDomains: [{ domain: "blocked.example.com" }],
            },
        });
    });
});
