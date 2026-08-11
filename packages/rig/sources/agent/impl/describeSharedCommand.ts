const MAX_SHARED_COMMAND_LENGTH = 200;

/**
 * How a shared transcript names a command the agent ran.
 *
 * Naming the command is the point: a friend cannot follow the work without it.
 * But a command line is not always just a command. A heredoc writes a whole
 * file, a `curl` carries a bearer token, a connection string carries a
 * password, and any of them can run to thousands of characters. So a shared
 * transcript gets the first line, kept to the length of something a person
 * would read, and says plainly when there was more.
 */
export function describeSharedCommand(command: string): string {
    const firstLine = command.split("\n", 1)[0] ?? "";
    const trimmed = firstLine.trim();
    const shortened =
        trimmed.length > MAX_SHARED_COMMAND_LENGTH
            ? trimmed.slice(0, MAX_SHARED_COMMAND_LENGTH)
            : trimmed;
    const abbreviated = shortened !== command.trim();
    if (shortened === "") return "Ran a command.";
    return abbreviated
        ? `Ran the command \`${shortened}\`, abbreviated here.`
        : `Ran the command \`${shortened}\`.`;
}
