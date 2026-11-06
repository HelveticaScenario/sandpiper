import * as Y from 'yjs';

/**
 * The shared workspace document. `files` maps a stable file id to an entry
 * holding its path; renaming changes the path, so a file keeps its identity
 * (and its text's edit history) across renames.
 *
 * Paths are workspace-relative, '/'-separated and NFC-normalised. Two entries
 * may claim the same path when peers create files concurrently, or paths that
 * differ only by case, which collide on case-insensitive disks. Every peer
 * resolves those the same way (see `resolveEffectivePaths`), so the doc never
 * needs repairing.
 */

export const FILES_KEY = 'files';

export type FileKind = 'text' | 'dir';

export const MAX_SHARED_TEXT_BYTES = 1024 * 1024;
export const MAX_SHARED_FILES = 2000;
/**
 * Total shared text. A joining peer receives the whole document in one
 * message, which must stay under the session's frame limit.
 */
export const MAX_SHARED_TOTAL_TEXT_BYTES = 24 * 1024 * 1024;
const MAX_PATH_LENGTH = 512;

/** Extensions shared as live-editable text; other files stay local. */
const TEXT_EXTENSIONS = new Set([
    '.js',
    '.mjs',
    '.cjs',
    '.ts',
    '.json',
    '.md',
    '.txt',
    '.glsl',
    '.frag',
    '.vert',
    '.csv',
]);

export function filesMap(doc: Y.Doc): Y.Map<Y.Map<unknown>> {
    return doc.getMap(FILES_KEY);
}

export interface FileEntry {
    id: string;
    path: string;
    kind: FileKind;
    text?: Y.Text;
}

export function readEntry(id: string, entry: Y.Map<unknown>): FileEntry | null {
    const path = entry.get('path');
    const kind = entry.get('kind');
    if (typeof path !== 'string' || (kind !== 'text' && kind !== 'dir')) {
        return null;
    }
    const text = entry.get('text');
    return {
        id,
        kind,
        path,
        text: kind === 'text' && text instanceof Y.Text ? text : undefined,
    };
}

export function listEntries(doc: Y.Doc): FileEntry[] {
    const entries: FileEntry[] = [];
    filesMap(doc).forEach((entry, id) => {
        const read = readEntry(id, entry);
        if (read && normalizeSessionPath(read.path) === read.path) {
            entries.push(read);
        }
    });
    return entries;
}

/**
 * Canonical form of a workspace-relative path, or null when it could escape
 * the workspace or is not a plain relative path. Remote peers supply paths, so
 * everything written to disk goes through here.
 */
export function normalizeSessionPath(input: string): string | null {
    if (typeof input !== 'string' || input.length === 0) {
        return null;
    }
    const path = input.normalize('NFC');
    if (
        path.length > MAX_PATH_LENGTH ||
        path.includes('\\') ||
        path.includes('\0') ||
        path.startsWith('/') ||
        /^[A-Za-z]:/.test(path)
    ) {
        return null;
    }
    const segments = path.split('/');
    for (const segment of segments) {
        if (
            segment === '' ||
            segment === '.' ||
            segment === '..' ||
            segment.startsWith('.') ||
            hasForbiddenCharacter(segment) ||
            isReservedDeviceName(segment) ||
            segment.endsWith(' ') ||
            segment.endsWith('.')
        ) {
            return null;
        }
    }
    return segments.join('/');
}

/** Names Windows reserves for devices, with or without an extension. */
const RESERVED_DEVICE_NAMES = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i;

function isReservedDeviceName(segment: string): boolean {
    return RESERVED_DEVICE_NAMES.test(segment);
}

/** Characters Windows forbids in file names, including control characters. */
function hasForbiddenCharacter(segment: string): boolean {
    for (const char of segment) {
        if (char.charCodeAt(0) < 0x20 || '<>:"|?*'.includes(char)) {
            return true;
        }
    }
    return false;
}

export function isSharedTextPath(path: string): boolean {
    const dot = path.lastIndexOf('.');
    const slash = path.lastIndexOf('/');
    if (dot <= slash + 1) {
        return false;
    }
    return TEXT_EXTENSIONS.has(path.slice(dot).toLowerCase());
}

/** Paths are compared case-insensitively so every disk can hold them. */
function pathKey(path: string): string {
    return path.toLowerCase();
}

function withSuffix(path: string, n: number): string {
    const slash = path.lastIndexOf('/');
    const dot = path.lastIndexOf('.');
    if (dot > slash + 1) {
        return `${path.slice(0, dot)} (${n})${path.slice(dot)}`;
    }
    return `${path} (${n})`;
}

/**
 * The path each entry occupies on disk. An entry whose path is taken by
 * another entry, or which names a directory other entries live in, is moved
 * to `name (2).ext` (or the next free number). The entry with the smallest id
 * keeps a contested path, so every peer reaches the same answer.
 */
export function resolveEffectivePaths(entries: FileEntry[]): Map<string, string> {
    const sorted = [...entries].sort((a, b) =>
        a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
    );
    const directoryKeys = new Set<string>();
    for (const entry of sorted) {
        const segments = entry.path.split('/');
        for (let i = 1; i < segments.length; i++) {
            directoryKeys.add(pathKey(segments.slice(0, i).join('/')));
        }
        if (entry.kind === 'dir') {
            directoryKeys.add(pathKey(entry.path));
        }
    }
    const taken = new Set<string>();
    const resolved = new Map<string, string>();
    for (const entry of sorted) {
        if (entry.kind === 'dir') {
            resolved.set(entry.id, entry.path);
            continue;
        }
        let candidate = entry.path;
        let n = 2;
        while (
            taken.has(pathKey(candidate)) ||
            directoryKeys.has(pathKey(candidate))
        ) {
            candidate = withSuffix(entry.path, n++);
        }
        taken.add(pathKey(candidate));
        resolved.set(entry.id, candidate);
    }
    return resolved;
}

/** Apply the smallest single replacement that turns `text` into `next`. */
export function applyTextDiff(text: Y.Text, next: string): void {
    const current = text.toJSON();
    if (current === next) {
        return;
    }
    let start = 0;
    const maxStart = Math.min(current.length, next.length);
    while (start < maxStart && current[start] === next[start]) {
        start++;
    }
    let endCurrent = current.length;
    let endNext = next.length;
    while (
        endCurrent > start &&
        endNext > start &&
        current[endCurrent - 1] === next[endNext - 1]
    ) {
        endCurrent--;
        endNext--;
    }
    // Keep surrogate pairs whole so the replacement never splits a character.
    if (start > 0 && isHighSurrogate(current.charCodeAt(start - 1))) {
        start--;
    }
    if (endCurrent < current.length && isLowSurrogate(current.charCodeAt(endCurrent))) {
        endCurrent++;
        endNext++;
    }
    if (endCurrent > start) {
        text.delete(start, endCurrent - start);
    }
    if (endNext > start) {
        text.insert(start, next.slice(start, endNext));
    }
}

function isHighSurrogate(code: number): boolean {
    return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
    return code >= 0xdc00 && code <= 0xdfff;
}

export function newFileId(): string {
    return crypto.randomUUID();
}

export function createTextEntry(doc: Y.Doc, path: string, content: string): string {
    const id = newFileId();
    const entry = new Y.Map<unknown>();
    const text = new Y.Text();
    text.insert(0, content);
    entry.set('path', path);
    entry.set('kind', 'text');
    entry.set('text', text);
    filesMap(doc).set(id, entry);
    return id;
}

export function createDirEntry(doc: Y.Doc, path: string): string {
    const id = newFileId();
    const entry = new Y.Map<unknown>();
    entry.set('path', path);
    entry.set('kind', 'dir');
    filesMap(doc).set(id, entry);
    return id;
}

/** Whether `path` is `prefix` or lies inside the directory `prefix`. */
export function isAtOrUnder(path: string, prefix: string): boolean {
    return (
        pathKey(path) === pathKey(prefix) ||
        pathKey(path).startsWith(`${pathKey(prefix)}/`)
    );
}
