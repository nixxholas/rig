#!/usr/bin/env node

import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { Value } from "@sinclair/typebox/value";

import { createHappyPluginTestHost } from "./createHappyPluginTestHost.js";
import { happyPluginTestSeedSchema, type HappyPluginTestSeed } from "./types.js";

interface RunnerOptions {
    argumentsValue: unknown;
    call?: string;
    entry: string;
    listTools: boolean;
    seed?: string;
}

async function main(): Promise<void> {
    const options = parseArguments(process.argv.slice(2));
    const seed = await readSeed(options.seed);
    const host = await createHappyPluginTestHost(seed, {
        onRequest: (request) => {
            process.stdout.write(
                `[fake Happy] ${request.method} ${request.path}${request.body === undefined ? "" : ` ${JSON.stringify(request.body)}`}\n`,
            );
        },
    });
    const child = spawn(process.execPath, ["--experimental-strip-types", resolve(options.entry)], {
        env: { ...process.env, ...host.environment },
        stdio: "inherit",
    });
    let stopping = false;
    const childExit = new Promise<number>((resolveExit) => {
        child.once("exit", (code) => resolveExit(stopping ? 0 : (code ?? 1)));
        child.once("error", () => resolveExit(1));
    });
    const stop = () => {
        stopping = true;
        child.kill("SIGTERM");
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);

    try {
        if (options.listTools || options.call !== undefined) {
            await Promise.race([
                host.mcp.waitForTools(),
                childExit.then((code) => {
                    throw new Error(
                        `The plugin exited with code ${String(code)} before registering an MCP server.`,
                    );
                }),
            ]);
            const tools = host.mcp.listTools();
            process.stdout.write(`${JSON.stringify({ tools }, null, 2)}\n`);
            if (options.call !== undefined) {
                const separator = Math.max(
                    options.call.lastIndexOf("/"),
                    options.call.lastIndexOf("."),
                );
                if (separator <= 0 || separator === options.call.length - 1) {
                    throw new Error("--call must be SERVER/TOOL or SERVER.TOOL.");
                }
                const result = await host.mcp.callTool(
                    options.call.slice(0, separator),
                    options.call.slice(separator + 1),
                    options.argumentsValue,
                );
                process.stdout.write(`${JSON.stringify({ result }, null, 2)}\n`);
            }
            stop();
        }
        process.exitCode = await childExit;
    } finally {
        process.off("SIGINT", stop);
        process.off("SIGTERM", stop);
        await host.close();
    }
}

function parseArguments(arguments_: readonly string[]): RunnerOptions {
    if (arguments_[0] !== "dev" || arguments_[1] === undefined) {
        throw new Error(
            "Usage: happy-plugin dev <entry.ts> [--seed seed.json] [--list-tools] [--call SERVER/TOOL] [--arguments JSON]",
        );
    }
    const options: RunnerOptions = {
        argumentsValue: {},
        entry: arguments_[1],
        listTools: false,
    };
    for (let index = 2; index < arguments_.length; index += 1) {
        const argument = arguments_[index];
        if (argument === "--list-tools") {
            options.listTools = true;
            continue;
        }
        if (argument === "--seed" || argument === "--call" || argument === "--arguments") {
            const value = arguments_[++index];
            if (value === undefined) throw new Error(`${argument} requires a value.`);
            if (argument === "--seed") options.seed = value;
            else if (argument === "--call") options.call = value;
            else options.argumentsValue = JSON.parse(value) as unknown;
            continue;
        }
        throw new Error(`Unknown happy-plugin option ${JSON.stringify(argument)}.`);
    }
    return options;
}

async function readSeed(path: string | undefined): Promise<HappyPluginTestSeed> {
    if (path === undefined) return {};
    return Value.Decode(
        happyPluginTestSeedSchema,
        JSON.parse(await readFile(resolve(path), "utf8")),
    );
}

void main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
});
