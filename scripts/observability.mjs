import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const action = process.argv[2] ?? "up";
const commands = {
    down: ["down"],
    restart: ["up", "-d", "--force-recreate", "--remove-orphans"],
    status: ["ps"],
    up: ["up", "-d", "--remove-orphans"],
};
const composeCommand = commands[action];
if (composeCommand === undefined) {
    console.error("Usage: node scripts/observability.mjs <up|down|restart|status>");
    process.exitCode = 1;
} else {
    const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
    const composePath = join(repositoryRoot, "observability", "docker-compose.yml");
    const dataDirectory = join(homedir(), "Happy", "Local", "observability");
    await Promise.all(
        ["grafana", "prometheus", "tempo"].map((name) =>
            mkdir(join(dataDirectory, name), { recursive: true }),
        ),
    );

    const child = spawn(
        "docker",
        [
            "compose",
            "--project-name",
            "happy-observability",
            "--file",
            composePath,
            ...composeCommand,
        ],
        {
            env: {
                ...process.env,
                OBSERVABILITY_DATA_DIR: dataDirectory,
                OBSERVABILITY_GID: String(process.getgid?.() ?? process.getuid?.() ?? 1000),
                OBSERVABILITY_UID: String(process.getuid?.() ?? 1000),
            },
            stdio: "inherit",
        },
    );
    const exitCode = await new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", (code, signal) => {
            if (signal !== null) {
                reject(new Error(`Docker Compose stopped after receiving ${signal}.`));
                return;
            }
            resolve(code ?? 1);
        });
    });
    process.exitCode = exitCode;
}
