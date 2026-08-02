import { createHash } from "node:crypto";

export const PLUGIN_DOCKER_MANAGED_LABEL = "dev.rig.managed";
export const PLUGIN_DOCKER_FOLDER_LABEL = "dev.rig.plugin-folder";

export function createPluginDockerFolderIdentity(folderName: string): string {
    return createHash("sha256").update(folderName).digest("hex").slice(0, 24);
}
