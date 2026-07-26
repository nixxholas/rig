const maximumHyperlinkBytes = 2_048;

export function isValidGridStyles(styles: unknown): boolean {
    if (!Array.isArray(styles) || styles.length < 1 || styles.length > 4_096) return false;
    return styles.every((style: unknown) => {
        if (typeof style !== "object" || style === null || Array.isArray(style)) return false;
        const hyperlink = (style as Readonly<Record<string, unknown>>).hyperlink;
        return (
            hyperlink === null ||
            (typeof hyperlink === "string" &&
                Buffer.byteLength(hyperlink, "utf8") <= maximumHyperlinkBytes)
        );
    });
}
