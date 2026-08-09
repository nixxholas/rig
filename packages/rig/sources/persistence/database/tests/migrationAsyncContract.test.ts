import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import ts from "typescript";
import { describe, expect, it } from "vitest";

const migrationDirectory = fileURLToPath(new URL("../migrations/", import.meta.url));

describe("asynchronous migration contract", () => {
    it("keeps one contiguous history of awaited asynchronous migrations", () => {
        const names = readdirSync(migrationDirectory)
            .filter((name) => name.endsWith(".ts"))
            .sort();

        expect(names.map((name) => Number.parseInt(name.slice(0, 2), 10))).toEqual(
            Array.from({ length: names.length }, (_unused, index) => index + 1),
        );

        for (const name of names) {
            const path = `${migrationDirectory}/${name}`;
            const source = readFileSync(path, "utf8");
            const file = ts.createSourceFile(
                path,
                source,
                ts.ScriptTarget.Latest,
                true,
                ts.ScriptKind.TS,
            );
            let exportsAsyncMigration = false;

            const visit = (node: ts.Node): void => {
                if (
                    ts.isFunctionDeclaration(node) &&
                    hasModifier(node, ts.SyntaxKind.ExportKeyword) &&
                    hasModifier(node, ts.SyntaxKind.AsyncKeyword)
                ) {
                    exportsAsyncMigration = true;
                }
                if (
                    ts.isCallExpression(node) &&
                    ts.isPropertyAccessExpression(node.expression) &&
                    ts.isIdentifier(node.expression.expression) &&
                    node.expression.expression.text === "database" &&
                    ["all", "get", "run"].includes(node.expression.name.text)
                ) {
                    expect(isAwaited(node), `${name}: database.${node.expression.name.text}`).toBe(
                        true,
                    );
                }
                ts.forEachChild(node, visit);
            };
            visit(file);

            expect(exportsAsyncMigration, name).toBe(true);
        }
    });
});

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
    return ts.canHaveModifiers(node)
        ? (ts.getModifiers(node)?.some((modifier) => modifier.kind === kind) ?? false)
        : false;
}

function isAwaited(call: ts.CallExpression): boolean {
    let parent: ts.Node = call.parent;
    while (ts.isParenthesizedExpression(parent)) parent = parent.parent;
    return ts.isAwaitExpression(parent);
}
