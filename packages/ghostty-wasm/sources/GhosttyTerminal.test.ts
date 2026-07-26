import { afterEach, describe, expect, it } from "vitest";

import { createGhosttyTerminal, type GhosttyTerminal } from "./node.js";

describe("GhosttyTerminal", () => {
    let terminal: GhosttyTerminal | undefined;

    afterEach(() => terminal?.dispose());

    it("loads the bundled WASM in Node and preserves terminal styling", async () => {
        terminal = await createGhosttyTerminal({ cols: 10, rows: 3 });
        terminal.write("plain\r\n\u001b[1;3;4;31;48;2;4;5;6mstyled\u001b[0m");

        const snapshot = terminal.snapshot();
        const styled = snapshot.rows[1]?.cells[0];

        expect(snapshot.rows[0]?.cells.map((cell) => cell.text).join("")).toBe("plain");
        expect(styled).toMatchObject({
            style: {
                background: { blue: 6, green: 5, kind: "rgb", red: 4 },
                bold: true,
                foreground: { index: 1, kind: "palette" },
                italic: true,
                underline: "single",
            },
            text: "s",
        });
    });

    it("never reuses stale render styles for default cells", async () => {
        terminal = await createGhosttyTerminal({ cols: 12, rows: 2 });
        terminal.write("\x1b[1;38;5;202;48;5;235mstyled\x1b[0m");
        terminal.snapshot();
        terminal.write("\r\x1b[2Kplain");

        expect(terminal.snapshot().rows[0]?.cells).toEqual([
            expect.objectContaining({
                style: {
                    background: null,
                    blink: false,
                    bold: false,
                    dim: false,
                    foreground: null,
                    invisible: false,
                    inverse: false,
                    italic: false,
                    overline: false,
                    strikethrough: false,
                    underline: "none",
                    underlineColor: null,
                },
                text: "p",
            }),
            expect.objectContaining({
                style: expect.objectContaining({ background: null, foreground: null }),
                text: "l",
            }),
            expect.objectContaining({
                style: expect.objectContaining({ background: null, foreground: null }),
                text: "a",
            }),
            expect.objectContaining({
                style: expect.objectContaining({ background: null, foreground: null }),
                text: "i",
            }),
            expect.objectContaining({
                style: expect.objectContaining({ background: null, foreground: null }),
                text: "n",
            }),
        ]);
    });

    it("preserves parsed OSC 8 hyperlinks across labels, adjacent links, styles, and closes", async () => {
        terminal = await createGhosttyTerminal({ cols: 24, rows: 2 });
        terminal.write(
            [
                osc8("https://example.test/docs", "manual"),
                osc8("file:///tmp/exact path", "file"),
                "\x1b[1;4;31m",
                osc8("javascript:alert(1)", "styled"),
                "\x1b[0m",
                osc8("https://space.test", " "),
                " plain https://visible.test",
            ].join(""),
        );

        const cells = terminal.snapshot().rows.flatMap((row) => row.cells);
        expect(cells.slice(0, 6).map(cellLink)).toEqual([
            ["m", "https://example.test/docs"],
            ["a", "https://example.test/docs"],
            ["n", "https://example.test/docs"],
            ["u", "https://example.test/docs"],
            ["a", "https://example.test/docs"],
            ["l", "https://example.test/docs"],
        ]);
        expect(cells.slice(6, 10).map(cellLink)).toEqual([
            ["f", "file:///tmp/exact path"],
            ["i", "file:///tmp/exact path"],
            ["l", "file:///tmp/exact path"],
            ["e", "file:///tmp/exact path"],
        ]);
        expect(cells.slice(10, 16).map(cellLink)).toEqual([
            ["s", "javascript:alert(1)"],
            ["t", "javascript:alert(1)"],
            ["y", "javascript:alert(1)"],
            ["l", "javascript:alert(1)"],
            ["e", "javascript:alert(1)"],
            ["d", "javascript:alert(1)"],
        ]);
        expect(cells[10]).toMatchObject({
            hyperlink: "javascript:alert(1)",
            style: {
                bold: true,
                foreground: { index: 1, kind: "palette" },
                underline: "single",
            },
        });
        expect(cells[16]).toMatchObject({ hyperlink: "https://space.test", text: " " });
        expect(cells.slice(17).every((cell) => cell.hyperlink === null)).toBe(true);
    });

    it("preserves links through wrapping and scrollback snapshots", async () => {
        terminal = await createGhosttyTerminal({ cols: 5, rows: 2 });
        terminal.write(`${osc8("https://wrapped.test/a", "wrapped-link")}\r\nnext\r\nlast`);

        const scrollback = terminal.snapshotScrollback();
        const linked = scrollback.rows
            .flatMap((row) => row.cells)
            .filter((cell) => cell.hyperlink !== null);
        expect(linked.map((cell) => cell.text).join("")).toBe("wrapped-link");
        expect(linked.every((cell) => cell.hyperlink === "https://wrapped.test/a")).toBe(true);
        expect(scrollback.rows.some((row) => row.wrapped)).toBe(true);
    });

    it("preserves hyperlink metadata through resize reflow and redraw", async () => {
        terminal = await createGhosttyTerminal({ cols: 8, rows: 2 });
        terminal.write(osc8("https://resize.test", "resized"));
        terminal.resize(4, 3);

        const linked = terminal
            .snapshot()
            .rows.flatMap((row) => row.cells)
            .filter((cell) => cell.hyperlink !== null);
        expect(linked.map((cell) => cell.text).join("")).toBe("resized");
        expect(linked.every((cell) => cell.hyperlink === "https://resize.test")).toBe(true);
    });

    it("removes hyperlink metadata when cells are overwritten or cleared", async () => {
        terminal = await createGhosttyTerminal({ cols: 8, rows: 2 });
        terminal.write(osc8("https://replace.test", "linked"));
        expect(terminal.snapshot().rows[0]?.cells.map((cell) => cell.hyperlink)).toEqual(
            Array.from({ length: 6 }, () => "https://replace.test"),
        );

        terminal.write("\rX");
        expect(terminal.snapshot().rows[0]?.cells[0]).toMatchObject({
            hyperlink: null,
            text: "X",
        });
        expect(terminal.snapshot().rows[0]?.cells[1]).toMatchObject({
            hyperlink: "https://replace.test",
            text: "i",
        });

        terminal.write("\r\x1b[2K");
        expect(terminal.snapshot().rows[0]?.cells).toEqual([]);
    });

    it("does not create links for malformed, unsupported, visible, or oversized OSC data", async () => {
        terminal = await createGhosttyTerminal({ cols: 40, rows: 3 });
        terminal.write(
            [
                "\x1b]8;id=broken;\x1b\\malformed ",
                "\x1b]9;;https://unsupported.test\x1b\\unsupported ",
                "https://visible.test ",
                `\x1b]8;;https://oversized.test/${"a".repeat(2_048)}\x1b\\oversized`,
            ].join(""),
        );

        expect(
            terminal
                .snapshot()
                .rows.flatMap((row) => row.cells)
                .every((cell) => cell.hyperlink === null),
        ).toBe(true);
    });

    it("keeps grapheme clusters, wide cells, wrapping, scrollback, and split titles", async () => {
        terminal = await createGhosttyTerminal({ cols: 4, rows: 2 });
        terminal.write("e\u0301界");

        const unicodeCells = terminal.snapshot().rows.flatMap((row) => row.cells);
        expect(unicodeCells).toContainEqual(expect.objectContaining({ text: "é", width: 1 }));
        expect(unicodeCells).toContainEqual(expect.objectContaining({ text: "界", width: 2 }));

        terminal.write("12345\u001b]2;split");
        expect(terminal.snapshot().rows.some((row) => row.wrapped)).toBe(true);
        terminal.write(" title\u001b\\\r\nnext\r\nlast");

        const snapshot = terminal.snapshot();
        expect(snapshot.title).toBe("split title");
        expect(snapshot.totalRows).toBeGreaterThan(snapshot.rows.length);
        expect(snapshot.startRow).toBe(snapshot.totalRows - snapshot.rows.length);
    });

    it("scrolls the native Ghostty viewport and restores it after reading any history page", async () => {
        terminal = await createGhosttyTerminal({ cols: 12, rows: 3 });
        terminal.write(Array.from({ length: 10 }, (_, index) => `line-${index}`).join("\r\n"));

        const bottom = terminal.snapshot();
        expect(bottom.startRow).toBe(bottom.totalRows - bottom.visibleRows);

        terminal.scrollToTop();
        expect(terminal.snapshot()).toMatchObject({ startRow: 0 });
        terminal.scrollBy(2);
        expect(terminal.snapshot()).toMatchObject({ startRow: 2 });

        const scrollback = terminal.snapshotScrollback();
        expect(scrollback).toMatchObject({ startRow: 0, totalRows: bottom.totalRows });
        expect(scrollback.rows).toHaveLength(scrollback.totalRows);
        expect(scrollback.rows.map(rowText)).toEqual(
            Array.from({ length: 10 }, (_, index) => `line-${index}`),
        );
        expect(terminal.snapshot()).toMatchObject({ startRow: 2 });

        const history = terminal.snapshotPage(1, 7);
        expect(history.startRow).toBe(1);
        expect(history.rows.map(rowText)).toEqual([
            "line-1",
            "line-2",
            "line-3",
            "line-4",
            "line-5",
            "line-6",
            "line-7",
        ]);
        expect(terminal.snapshot()).toMatchObject({ startRow: 2 });

        terminal.scrollToBottom();
        expect(terminal.snapshot().startRow).toBe(bottom.startRow);
    });

    it("preserves split UTF-8 and grapheme clusters across individual writes", async () => {
        terminal = await createGhosttyTerminal({ cols: 20, rows: 2 });
        const bytes = new TextEncoder().encode("A🙂\u0301界 e\u0301");
        for (const byte of bytes) terminal.write(Uint8Array.of(byte));

        expect(terminal.snapshot().rows.map(rowText).join("\n")).toContain("A🙂́界 é");
    });

    it("preserves a surrogate pair across the bounded text flush boundary", async () => {
        terminal = await createGhosttyTerminal({ cols: 80, rows: 3 });
        const maximumBufferedText = 1024 * 1024;
        terminal.write(`${"a".repeat(maximumBufferedText - 64)}🙂${"b".repeat(63)}`);

        const rendered = terminal
            .snapshot()
            .rows.flatMap((row) => row.cells)
            .map((cell) => cell.text)
            .join("");
        expect(rendered).toContain("🙂");
        expect(rendered).not.toContain("�");
    }, 15_000);

    it("emits terminal replies and reports color-scheme and synchronized-output modes", async () => {
        terminal = await createGhosttyTerminal({ cols: 10, rows: 2 });
        const replies: string[] = [];
        terminal.onPtyWrite((data) => replies.push(new TextDecoder().decode(data)));

        terminal.write("\x1b]10;");
        terminal.write("?\x1b]11;?\x1b[c");
        expect(replies).toEqual([
            "\x1b]10;rgb:eeee/eeee/eeee\x1b\\",
            "\x1b]11;rgb:0d0d/0d0d/0d0d\x1b\\",
            "\x1b[?62;22c",
        ]);

        terminal.write("\x1b[?2026h\x1b[?2031h");
        expect(terminal.snapshot().synchronizedOutputActive).toBe(true);
        terminal.setColorScheme("light");
        expect(terminal.snapshot()).toMatchObject({
            defaultBackground: { blue: 238, green: 238, kind: "rgb", red: 238 },
            defaultForeground: { blue: 13, green: 13, kind: "rgb", red: 13 },
        });
        expect(replies.at(-1)).toBe("\x1b[?997;2n");

        const replyCount = replies.length;
        terminal.write("\x1b[?2026l\x1b[?2031l");
        expect(terminal.snapshot().synchronizedOutputActive).toBe(false);
        terminal.setColorScheme("dark");
        expect(replies).toHaveLength(replyCount);
    });

    it("is safe to dispose more than once and rejects later use", async () => {
        terminal = await createGhosttyTerminal();
        terminal.dispose();
        terminal.dispose();

        expect(() => terminal?.write("late")).toThrow("disposed");
        terminal = undefined;
    });
});

function rowText(row: { cells: readonly { text: string; width: number; x: number }[] }): string {
    let result = "";
    let column = 0;
    for (const cell of row.cells) {
        result += " ".repeat(Math.max(0, cell.x - column));
        result += cell.text;
        column = cell.x + cell.width;
    }
    return result.trimEnd();
}

function osc8(uri: string, label: string): string {
    return `\x1b]8;;${uri}\x1b\\${label}\x1b]8;;\x1b\\`;
}

function cellLink(cell: { hyperlink: string | null; text: string }): [string, string | null] {
    return [cell.text, cell.hyperlink];
}
