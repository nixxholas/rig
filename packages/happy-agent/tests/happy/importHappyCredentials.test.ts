import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { importHappyCredentials } from "../../sources/modules/happy/credentials/importHappyCredentials.js";

const temporaryDirectories: string[] = [];
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

afterEach(async () => {
    await Promise.all(
        temporaryDirectories
            .splice(0)
            .map((directory) => rm(directory, { force: true, recursive: true })),
    );
});

async function createHome(prefix: string): Promise<{
    dataDirectory: string;
    home: string;
    sourceHome: string;
    targetHome: string;
}> {
    const root = await mkdtemp(join(tmpdir(), prefix));
    temporaryDirectories.push(root);
    const home = join(root, "home");
    const dataDirectory = join(home, ".happy-agent");
    const sourceHome = join(home, ".happy");
    await mkdir(sourceHome, { recursive: true });
    return { dataDirectory, home, sourceHome, targetHome: join(dataDirectory, "happy") };
}

describe("importHappyCredentials", () => {
    it("imports current Happy credentials and server settings", async () => {
        const { dataDirectory, home, sourceHome, targetHome } = await createHome("happy-import-");
        const source = {
            encryption: {
                machineKey: Buffer.alloc(32, 1).toString("base64"),
                publicKey: Buffer.alloc(32, 2).toString("base64"),
            },
            token: "happy-token",
        };
        await writeFile(join(sourceHome, "access.key"), JSON.stringify(source));
        await writeFile(
            join(sourceHome, "settings.json"),
            JSON.stringify({ machineId: "machine-1", serverUrl: "https://happy.example" }),
        );

        const imported = await importHappyCredentials({
            dataDirectory,
            environment: {},
            homeDirectory: home,
        });

        expect(imported).toMatchObject({ imported: true, serverUrl: "https://happy.example" });
        expect(imported?.machineId).toMatch(uuidPattern);
        // Happy's own machine id belongs to the CLI; this agent keeps its own.
        expect(imported?.machineId).not.toBe("machine-1");
        expect(JSON.parse(await readFile(join(targetHome, "machine.json"), "utf8"))).toEqual({
            id: imported?.machineId,
        });
        expect(await readFile(join(targetHome, "access.key"), "utf8")).toBe(
            `${JSON.stringify(source, null, 2)}\n`,
        );
        expect((await stat(targetHome)).mode & 0o777).toBe(0o700);
        expect((await stat(join(targetHome, "access.key"))).mode & 0o777).toBe(0o600);
        expect((await stat(join(targetHome, "machine.json"))).mode & 0o777).toBe(0o600);
    });

    it("keeps a valid local copy when the Happy source is malformed", async () => {
        const { dataDirectory, home, sourceHome, targetHome } =
            await createHome("happy-malformed-");
        await mkdir(targetHome, { recursive: true });
        await writeFile(join(sourceHome, "access.key"), "not-json");
        await writeFile(
            join(targetHome, "access.key"),
            JSON.stringify({ secret: Buffer.alloc(32, 3).toString("base64"), token: "existing" }),
        );

        const imported = await importHappyCredentials({
            dataDirectory,
            environment: {},
            homeDirectory: home,
        });

        expect(imported).toMatchObject({
            imported: false,
            serverUrl: "https://api.cluster-fluster.com",
        });
        expect(imported?.credentials).toMatchObject({ token: "existing" });
    });

    it("keeps newer local credentials while still importing newer Happy settings", async () => {
        const { dataDirectory, home, sourceHome, targetHome } = await createHome("happy-newest-");
        await mkdir(targetHome, { recursive: true });
        const sourceCredentialsPath = join(sourceHome, "access.key");
        const targetCredentialsPath = join(targetHome, "access.key");
        await writeFile(
            sourceCredentialsPath,
            JSON.stringify({ secret: Buffer.alloc(32, 1).toString("base64"), token: "older" }),
        );
        await writeFile(
            targetCredentialsPath,
            JSON.stringify({ secret: Buffer.alloc(32, 2).toString("base64"), token: "newer" }),
        );
        await utimes(sourceCredentialsPath, new Date(1_000), new Date(1_000));
        await utimes(targetCredentialsPath, new Date(2_000), new Date(2_000));
        await writeFile(
            join(sourceHome, "settings.json"),
            JSON.stringify({ serverUrl: "https://new-settings.example" }),
        );

        const imported = await importHappyCredentials({
            dataDirectory,
            environment: {},
            homeDirectory: home,
        });

        expect(imported).toMatchObject({
            imported: false,
            serverUrl: "https://new-settings.example",
        });
        expect(imported?.credentials).toMatchObject({ token: "newer" });
    });

    it("keeps loading credentials when imported Happy settings cannot be written", async () => {
        const { dataDirectory, home, sourceHome, targetHome } = await createHome("happy-settings-");
        await mkdir(targetHome, { recursive: true });
        await writeFile(
            join(targetHome, "access.key"),
            JSON.stringify({ secret: Buffer.alloc(32, 4).toString("base64"), token: "working" }),
        );
        const sourceSettingsPath = join(sourceHome, "settings.json");
        await writeFile(
            sourceSettingsPath,
            JSON.stringify({ serverUrl: "https://unwritable-settings.example" }),
        );
        // A directory where the settings file belongs makes the write fail.
        const targetSettingsPath = join(targetHome, "settings.json");
        await mkdir(targetSettingsPath);
        await utimes(targetSettingsPath, new Date(3_000), new Date(3_000));
        await utimes(sourceSettingsPath, new Date(4_000), new Date(4_000));

        const imported = await importHappyCredentials({
            dataDirectory,
            environment: {},
            homeDirectory: home,
        });

        expect(imported).toMatchObject({
            imported: false,
            serverUrl: "https://unwritable-settings.example",
        });
        expect(imported?.credentials).toMatchObject({ token: "working" });
    });

    it("reports no connection when nothing is signed in", async () => {
        const { dataDirectory, home } = await createHome("happy-absent-");

        expect(
            await importHappyCredentials({ dataDirectory, environment: {}, homeDirectory: home }),
        ).toBeUndefined();
    });

    it("prefers the configured server over any stored setting", async () => {
        const { dataDirectory, home, sourceHome } = await createHome("happy-environment-");
        await writeFile(
            join(sourceHome, "access.key"),
            JSON.stringify({ secret: Buffer.alloc(32, 5).toString("base64"), token: "token" }),
        );
        await writeFile(
            join(sourceHome, "settings.json"),
            JSON.stringify({ serverUrl: "https://stored.example" }),
        );

        const imported = await importHappyCredentials({
            dataDirectory,
            environment: { HAPPY_SERVER_URL: "https://configured.example/" },
            homeDirectory: home,
        });

        expect(imported?.serverUrl).toBe("https://configured.example");
    });

    it("uses distinct persistent machine identities for separate daemon sockets", async () => {
        const { dataDirectory, home, sourceHome } = await createHome("happy-scopes-");
        await writeFile(
            join(sourceHome, "access.key"),
            JSON.stringify({ secret: Buffer.alloc(32, 6).toString("base64"), token: "shared" }),
        );

        const first = await importHappyCredentials({
            dataDirectory,
            environment: {},
            homeDirectory: home,
            machineScope: "/tmp/first.sock",
        });
        const second = await importHappyCredentials({
            dataDirectory,
            environment: {},
            homeDirectory: home,
            machineScope: "/tmp/second.sock",
        });
        const restored = await importHappyCredentials({
            dataDirectory,
            environment: {},
            homeDirectory: home,
            machineScope: "/tmp/first.sock",
        });

        expect(first?.machineId).toMatch(uuidPattern);
        expect(second?.machineId).toMatch(uuidPattern);
        expect(first?.machineId).toBe(restored?.machineId);
        expect(first?.machineId).not.toBe(second?.machineId);
    });
});
