export function humanizeTaskName(taskName: string): string {
    const leaf = taskName.split("/").filter(Boolean).at(-1) ?? taskName;
    const words = leaf.replaceAll("_", " ").trim();
    return words.length === 0 ? "Delegated task" : words[0]?.toUpperCase() + words.slice(1);
}
