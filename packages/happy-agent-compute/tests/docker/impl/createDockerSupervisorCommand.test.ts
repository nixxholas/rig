import { describe, expect, it } from "vitest";

import { computePermissions } from "../../../sources/ComputePermissions.js";
import {
    createDockerSupervisorCommand,
    DOCKER_SUPERVISOR_PATH,
} from "../../../sources/docker/impl/createDockerSupervisorCommand.js";
import { createDirectSupervisorCommand } from "../../../sources/supervisor/createSupervisorCommand.js";
import { createSupervisorPolicy } from "../../../sources/supervisor/createSupervisorPolicy.js";

describe("createDockerSupervisorCommand", () => {
    it("pipes a command-scoped policy to the mounted supervisor without a mutable policy file", () => {
        const policy = createSupervisorPolicy({
            cwd: "/workspace",
            permissions: computePermissions("workspace_write", {
                network: {
                    egress: true,
                    allowedHosts: ["registry.npmjs.org"],
                    localBinding: false,
                },
            }),
        });
        const command = createDockerSupervisorCommand({
            command: "printf hello",
            policy,
            shell: "/bin/sh",
        });

        expect(command.command).toBe("/bin/sh");
        expect(command.args[0]).toBe("-c");
        expect(command.args[1]).toContain("--policy-fd 3");
        expect(command.args[1]).toContain("exec 4<&0");
        expect(command.args[1]).toContain("stty -echo -icanon min 1 time 0");
        expect(command.args[1]).toContain('stty "$terminal_state"');
        expect(command.args).toContain(DOCKER_SUPERVISOR_PATH);
        expect(command.args).toContain("/bin/sh");
        expect(command.args).toContain("-lc");
        expect(command.args).toContain("printf hello");
        expect(command.args).not.toContain(JSON.stringify(policy));
        expect(command.initialStdin).toBe(`${JSON.stringify(policy)}\n`);
        expect(command.initialStdinHandshake.readyMarker).not.toBe(
            command.initialStdinHandshake.completeMarker,
        );
        expect(command.args).toContain(command.initialStdinHandshake.readyMarker);
        expect(command.args).toContain(command.initialStdinHandshake.completeMarker);
    });

    it("builds a direct host invocation with policy on descriptor three", () => {
        const policy = createSupervisorPolicy({
            cwd: "/workspace",
            permissions: computePermissions("workspace_write"),
        });

        expect(
            createDirectSupervisorCommand({
                command: "printf hello",
                policy,
                shell: "/bin/sh",
                supervisorPath: "/node_modules/happy-agent-supervisor",
            }),
        ).toEqual({
            args: ["--policy-fd", "3", "--", "/bin/sh", "-lc", "printf hello"],
            command: "/node_modules/happy-agent-supervisor",
            extraFileDescriptorInputs: [JSON.stringify(policy)],
        });
    });
});
