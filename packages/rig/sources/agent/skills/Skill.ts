export type SkillSource =
    | { type: "file" }
    | { folder: string; plugin: string; type: "plugin" };

export interface Skill {
    name: string;
    description: string;
    filePath: string;
    baseDir: string;
    source: SkillSource;
}

export interface SkillRoot {
    path: string;
    source: SkillSource;
}
