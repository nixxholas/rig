import type { FileDiff } from "../../agent/ToolResultPresentation.js";

type Mutable<Value> = Value extends readonly (infer Item)[]
    ? Mutable<Item>[]
    : Value extends object
      ? { -readonly [Key in keyof Value]: Mutable<Value[Key]> }
      : Value;

export type MutableFileDiff = Mutable<FileDiff>;

export interface EditFileOptions {
    path: string;
    oldString: string;
    newString: string;
    replaceAll?: boolean;
    cwd?: string;
    fuzzy?: boolean;
}

export interface EditFileResult {
    path: string;
    replacements: number;
    fuzzy: boolean;
    oldString: string;
    newString: string;
    fileDiff: MutableFileDiff;
}

export interface TextEditPlan {
    path: string;
    nextContent: string;
    replacements: number;
    fuzzy: boolean;
    fileDiff: MutableFileDiff;
}

export interface EditMatch {
    start: number;
    end: number;
    replacements: number;
    fuzzy: boolean;
}

export interface BatchEdit {
    oldText: string;
    newText: string;
}

export interface BatchEditFileOptions {
    path: string;
    edits: readonly BatchEdit[];
    cwd?: string;
    fuzzy?: boolean;
}

export interface BatchEditFileResult {
    path: string;
    replacements: number;
    fuzzy: boolean;
}
