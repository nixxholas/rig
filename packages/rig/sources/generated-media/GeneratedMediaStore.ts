import { randomUUID } from "node:crypto";
import { chmod, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, extname, join, relative } from "node:path";

import {
    createGeneratedMediaLocation,
    type GeneratedMediaLocation,
} from "./GeneratedMediaLocation.js";

export interface GeneratedMediaWriteResult {
    hostPath: string;
    location: GeneratedMediaLocation;
    path: string;
}

export interface GeneratedMediaStore {
    readonly hostDirectory: string;
    readonly modelDirectory: string;
    remove(hostPath: string): Promise<void>;
    write(
        bytes: Uint8Array,
        options: { extension: string; preferredName?: string },
    ): Promise<GeneratedMediaWriteResult>;
}

export function createGeneratedMediaStore(options: {
    hostDirectory: string;
    modelDirectory?: string;
}): GeneratedMediaStore {
    const modelDirectory = options.modelDirectory ?? options.hostDirectory;
    return {
        hostDirectory: options.hostDirectory,
        modelDirectory,
        async remove(hostPath) {
            const relation = relative(options.hostDirectory, hostPath);
            if (relation.length === 0 || relation.startsWith("..") || relation.includes("/../")) {
                throw new Error("Generated media removal escaped its storage directory.");
            }
            await rm(hostPath, { force: true });
        },
        async write(bytes, writeOptions) {
            const extension = normalizeExtension(writeOptions.extension);
            const preferredBase =
                writeOptions.preferredName === undefined
                    ? randomUUID()
                    : basename(writeOptions.preferredName, extname(writeOptions.preferredName))
                          .replaceAll(/[^A-Za-z0-9_-]+/gu, "-")
                          .replaceAll(/^-+|-+$/gu, "") || randomUUID();
            const name = `${preferredBase}-${randomUUID().slice(0, 8)}${extension}`;
            const hostPath = join(options.hostDirectory, name);
            const temporaryPath = join(options.hostDirectory, `.${name}.${randomUUID()}.tmp`);
            await mkdir(options.hostDirectory, { mode: 0o755, recursive: true });
            await chmod(options.hostDirectory, 0o755);
            try {
                await writeFile(temporaryPath, bytes, { flag: "wx", mode: 0o644 });
                await rename(temporaryPath, hostPath);
                await chmod(hostPath, 0o644);
            } catch (error) {
                await rm(temporaryPath, { force: true }).catch(() => undefined);
                throw error;
            }
            return {
                hostPath,
                location: createGeneratedMediaLocation(name),
                path: join(modelDirectory, name),
            };
        },
    };
}

function normalizeExtension(value: string): string {
    const extension = value.startsWith(".") ? value : `.${value}`;
    if (!/^\.[A-Za-z0-9]{1,10}$/u.test(extension)) {
        throw new Error(`Invalid generated media extension '${value}'.`);
    }
    return extension.toLowerCase();
}
