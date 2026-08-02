export interface FileSystemStat {
    isFile: boolean;
    isDirectory: boolean;
    isSymbolicLink: boolean;
    mode?: number;
    size: number;
    mtimeMs: number;
}

export interface FileSystemReadOptions {
    /** Refuse the read after this many bytes without buffering the rest of the file. */
    maxBytes?: number;
    /** Refuse a symbolic link at the final path component when opening the file. */
    noFollow?: boolean;
}

export interface FileSystemContext {
    cwd: string;
    home?: string;
    chmod(path: string, mode: number): Promise<void>;
    exists(path: string): Promise<boolean>;
    lstat(path: string): Promise<FileSystemStat>;
    mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
    move(source: string, destination: string): Promise<void>;
    realpath(path: string): Promise<string>;
    readFile(path: string): Promise<string>;
    readFileBuffer(path: string, options?: FileSystemReadOptions): Promise<Uint8Array>;
    readdir(path: string): Promise<readonly string[]>;
    rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void>;
    setModificationTime(path: string, mtimeMs: number): Promise<void>;
    stat(path: string): Promise<FileSystemStat>;
    writeFile(path: string, content: string | Uint8Array): Promise<void>;
}
