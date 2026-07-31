import type Dockerode from "dockerode";

import type { ManagedNetworkPolicy } from "../agent/context/ManagedNetworkPolicy.js";
import { toManagedNetworkPolicy } from "../agent/context/loadProjectManagedNetworkPolicy.js";
import { loadNetworkConfigForProject } from "../config/loadNetworkConfig.js";
import { parseConfigToml } from "../config/parseConfigToml.js";
import { runDockerExec } from "./runDockerExec.js";

export interface DockerProjectManagedNetworkPolicyState {
    absentProjectConfigNames: readonly ("happy.toml" | "rig.toml")[];
    policy: ManagedNetworkPolicy | undefined;
    projectConfigPlaceholderCreated: boolean;
    readyProjectConfigNames: readonly ("happy.toml" | "rig.toml")[];
}

export async function loadDockerProjectManagedNetworkPolicyState(
    container: Dockerode.Container,
    cwd: string,
    bridgeRoot: string,
    placeholderMarkerPath: string,
): Promise<DockerProjectManagedNetworkPolicyState> {
    const result = await runDockerExec(container, [
        "/bin/sh",
        "-c",
        [
            "rig_path=$1/rig.toml",
            "happy_path=$1/happy.toml",
            "bridge_root=$2",
            "marker=$3",
            'case "$marker" in "$bridge_root"/.config-*) ;; *) exit 46 ;; esac',
            '[ -d "$bridge_root" ] && [ ! -L "$bridge_root" ] || exit 47',
            'if [ -f "$rig_path" ]; then',
            '  if [ -f "$happy_path" ]; then printf B; else printf R; fi',
            '  cat "$rig_path"',
            'elif [ -f "$happy_path" ]; then',
            '  printf H; cat "$happy_path"',
            'elif (umask 077; set -C; : > "$marker") 2>/dev/null; then',
            '  if ln "$marker" "$rig_path" 2>/dev/null; then',
            "    printf P",
            "  else",
            '    rm -f -- "$marker"',
            '    if [ -f "$rig_path" ]; then',
            '      if [ -f "$happy_path" ]; then printf B; else printf R; fi',
            '      cat "$rig_path"',
            '    elif [ -f "$happy_path" ]; then',
            '      printf H; cat "$happy_path"',
            "    else",
            "      exit 44",
            "    fi",
            "  fi",
            "else",
            "  exit 45",
            "fi",
        ].join("\n"),
        "rig",
        cwd,
        bridgeRoot,
        placeholderMarkerPath,
    ]);
    if (result.exitCode !== 0 || result.stdout.length === 0) {
        throw new Error("Could not read the Docker project's configuration.");
    }
    const selection = parseDockerProjectConfigSelection(
        result.stdout.subarray(0, 1).toString("utf8"),
    );
    try {
        const project = parseConfigToml(result.stdout.subarray(1).toString("utf8"));
        return {
            ...selection,
            policy: toManagedNetworkPolicy(await loadNetworkConfigForProject(project)),
        };
    } catch (error) {
        if (selection.projectConfigPlaceholderCreated) {
            await cleanupDockerProjectConfigPlaceholder(
                container,
                cwd,
                bridgeRoot,
                placeholderMarkerPath,
            ).catch(() => undefined);
        }
        throw error;
    }
}

export function parseDockerProjectConfigSelection(
    marker: string,
): Omit<DockerProjectManagedNetworkPolicyState, "policy"> {
    if (!["B", "H", "P", "R"].includes(marker)) {
        throw new Error("Could not identify the Docker project's configuration.");
    }
    return {
        absentProjectConfigNames:
            marker === "B"
                ? []
                : marker === "H"
                  ? (["rig.toml"] as const)
                  : (["happy.toml"] as const),
        projectConfigPlaceholderCreated: marker === "P",
        readyProjectConfigNames:
            marker === "B"
                ? (["rig.toml", "happy.toml"] as const)
                : marker === "H"
                  ? (["happy.toml"] as const)
                  : (["rig.toml"] as const),
    };
}

export async function cleanupDockerProjectConfigPlaceholder(
    container: Dockerode.Container,
    cwd: string,
    bridgeRoot: string,
    placeholderMarkerPath: string,
): Promise<void> {
    const result = await runDockerExec(container, [
        "/bin/sh",
        "-c",
        [
            "path=$1/rig.toml",
            "bridge_root=$2",
            "marker=$3",
            'case "$marker" in "$bridge_root"/.config-*) ;; *) exit 46 ;; esac',
            '[ -d "$bridge_root" ] && [ ! -L "$bridge_root" ] || exit 47',
            'if [ -f "$marker" ]; then',
            '  if [ -f "$path" ] && [ "$path" -ef "$marker" ] && [ ! -s "$path" ]; then',
            '    rm -f -- "$path"',
            "  fi",
            '  rm -f -- "$marker"',
            "fi",
        ].join("\n"),
        "rig",
        cwd,
        bridgeRoot,
        placeholderMarkerPath,
    ]);
    if (result.exitCode !== 0) {
        throw new Error("Could not remove the temporary Docker project configuration placeholder.");
    }
}
