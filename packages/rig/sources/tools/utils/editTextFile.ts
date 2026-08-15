import { Type } from "@sinclair/typebox";

import type { AgentContext } from "../../agent/context/AgentContext.js";
import { assertReadBeforeModify } from "./assertReadBeforeModify.js";
import type { EditFileOptions, EditFileResult } from "./editFileTypes.js";
import { planTextEdit } from "./planTextEdit.js";
import { recordWriteAsRead } from "./recordWriteAsRead.js";

export type { EditFileOptions, EditFileResult } from "./editFileTypes.js";

export const fileDiffReturnSchema = Type.Object({
    hunks: Type.Array(
        Type.Object({
            lines: Type.Array(
                Type.Object({
                    kind: Type.Union([
                        Type.Literal("add"),
                        Type.Literal("context"),
                        Type.Literal("delete"),
                    ]),
                    text: Type.String(),
                }),
            ),
            newStart: Type.Number(),
            oldStart: Type.Number(),
        }),
    ),
    kind: Type.Union([Type.Literal("add"), Type.Literal("delete"), Type.Literal("update")]),
    path: Type.String(),
    added: Type.Optional(Type.Number()),
    deleted: Type.Optional(Type.Number()),
    omittedLines: Type.Optional(Type.Number()),
});

export const editFileReturnSchema = Type.Object({
    path: Type.String(),
    replacements: Type.Number(),
    fuzzy: Type.Boolean(),
    oldString: Type.String(),
    newString: Type.String(),
    fileDiff: fileDiffReturnSchema,
});

export async function editTextFile(
    options: EditFileOptions,
    context: AgentContext,
): Promise<EditFileResult> {
    const plan = await planTextEdit(options, context);
    await assertReadBeforeModify(plan.path, context);
    await context.fs.writeFile(plan.path, plan.nextContent);
    await recordWriteAsRead(plan.path, context);

    return {
        path: plan.path,
        replacements: plan.replacements,
        fuzzy: plan.fuzzy,
        oldString: options.oldString,
        newString: options.newString,
        fileDiff: plan.fileDiff,
    };
}
