import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { ProjectAvatarAsset } from "@slopus/happy-agent-modules";

/**
 * The bytes behind a project avatar, kept beside the agent's own state.
 *
 * The catalog stores only the description of an avatar — its hash, size and where it came from —
 * because a database is the wrong place for pictures. This is the other half: content-addressed
 * files under the agent state directory, written atomically so a half-written file is never
 * mistaken for the asset its hash promises.
 */
export class ProjectAvatarStore {
    readonly #root: string;

    constructor(stateDirectory: string) {
        this.#root = join(stateDirectory, "assets", "project-avatars");
    }

    get root(): string {
        return this.#root;
    }

    path(hash: string): string {
        return join(this.#root, hash.slice(0, 2), `${hash}.webp`);
    }

    async write(hash: string, bytes: Buffer): Promise<void> {
        const path = this.path(hash);
        await mkdir(dirname(path), { recursive: true, mode: 0o700 });
        const temporary = `${path}.${randomUUID()}.tmp`;
        await writeFile(temporary, bytes, { mode: 0o600 });
        try {
            await rename(temporary, path);
        } catch (error) {
            await rm(temporary, { force: true });
            throw error;
        }
    }

    async read(hash: string): Promise<ProjectAvatarAsset | undefined> {
        if (!/^[a-f0-9]{64}$/u.test(hash)) return undefined;
        try {
            const bytes = await readFile(this.path(hash));
            if (bytes.byteLength === 0) return undefined;
            return { bytes: new Uint8Array(bytes), hash, mediaType: "image/webp" };
        } catch {
            return undefined;
        }
    }

    async remove(hash: string): Promise<void> {
        await rm(this.path(hash), { force: true });
    }
}
