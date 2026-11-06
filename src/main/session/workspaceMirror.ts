import * as fs from 'fs';
import * as path from 'path';
import * as Y from 'yjs';
import type { BlobStore } from './blobStore';
import {
    type FileEntry,
    MAX_SHARED_BLOB_BYTES,
    MAX_SHARED_FILES,
    MAX_SHARED_TEXT_BYTES,
    MAX_SHARED_TOTAL_TEXT_BYTES,
    applyTextDiff,
    createBlobEntry,
    createDirEntry,
    createTextEntry,
    filesMap,
    isAtOrUnder,
    isSharedTextPath,
    listEntries,
    normalizeSessionPath,
    resolveEffectivePaths,
} from '../../shared/sessionWorkspace';

/** Transaction origin of changes the mirror makes from disk or local ops. */
export const MIRROR_ORIGIN = 'mirror';

const RECONCILE_DEBOUNCE_MS = 40;
const DISK_DEBOUNCE_MS = 100;

export interface WorkspaceMirrorOptions {
    /** Prepare text for disk (the patch version stamp). */
    toDisk: (relativePath: string, content: string) => string;
    /** Undo `toDisk` on text read from disk. */
    fromDisk: (relativePath: string, content: string) => string;
    /** Called after files appear, disappear or move on disk. */
    onTreeChanged: () => void;
    /** Shares asset files; without it only text files are shared. */
    blobs?: MirrorBlobs;
}

export interface MirrorBlobs {
    store: BlobStore;
    /** Get a blob of `size` bytes from peers into the store; false if that became impossible. */
    fetch: (hash: string, size: number) => Promise<boolean>;
    /** A peer's asset finished arriving on disk. */
    onArrived: () => void;
}

interface Mirrored {
    path: string;
    kind: 'text' | 'blob' | 'dir';
    /**
     * Text as last written to or read from disk (before `toDisk`), or a
     * blob's hash.
     */
    content: string;
}

/**
 * Keeps a folder on disk and the shared workspace document in step. Remote
 * changes are written to disk; changes made on disk by other programs flow
 * into the document; local file operations (save, rename, delete) apply to
 * the document first and reach disk through the same reconcile.
 *
 * Shared text lives in the document, so it always wins: an external edit to
 * a file is taken only while the document holds exactly what was last written
 * to that file, and is overwritten otherwise.
 */
export class WorkspaceMirror {
    readonly root: string;
    private readonly doc: Y.Doc;
    private readonly options: WorkspaceMirrorOptions;
    private readonly mirrored = new Map<string, Mirrored>();
    private watcher: fs.FSWatcher | null = null;
    private reconcileTimer: NodeJS.Timeout | null = null;
    private readonly diskTimers = new Map<string, NodeJS.Timeout>();
    private disposed = false;
    /** Blobs being fetched or written, by `${id}:${hash}`. */
    private readonly blobsInFlight = new Set<string>();
    /** Asset paths whose first hashing (seeding) has not finished. */
    private readonly seedingBlobs = new Set<string>();
    /** Blobs that could not be written here, by `${id}:${hash}`; not retried. */
    private readonly failedBlobs = new Set<string>();
    private readonly observer = () => this.scheduleReconcile();

    constructor(doc: Y.Doc, root: string, options: WorkspaceMirrorOptions) {
        this.doc = doc;
        this.root = path.resolve(root);
        this.options = options;
    }

    /**
     * Begin mirroring. With `seed`, the folder's shareable files are added
     * to the document first, making them the session's starting point.
     */
    start({ seed }: { seed: boolean }): void {
        fs.mkdirSync(this.root, { recursive: true });
        if (seed) {
            this.seedFromDisk();
        }
        filesMap(this.doc).observeDeep(this.observer);
        this.reconcileNow();
        try {
            this.watcher = fs.watch(
                this.root,
                { recursive: true },
                (_event, filename) => {
                    if (filename) {
                        this.scheduleDiskCheck(filename.toString());
                    }
                },
            );
            this.watcher.on('error', (error) =>
                console.warn('[session] workspace watch failed', error),
            );
        } catch (error) {
            console.warn('[session] cannot watch the workspace', error);
        }
    }

    dispose(): void {
        this.disposed = true;
        filesMap(this.doc).unobserveDeep(this.observer);
        this.watcher?.close();
        this.watcher = null;
        if (this.reconcileTimer) {
            clearTimeout(this.reconcileTimer);
        }
        for (const timer of this.diskTimers.values()) {
            clearTimeout(timer);
        }
        this.diskTimers.clear();
    }

    /** The workspace-relative path of `absolutePath`, or null outside it. */
    relative(absolutePath: string): string | null {
        const rel = path.relative(this.root, path.resolve(absolutePath));
        if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
            return null;
        }
        return normalizeSessionPath(rel.split(path.sep).join('/'));
    }

    /** The shared text at `absolutePath`, or null when it is not shared. */
    readText(absolutePath: string): string | null {
        const entry = this.entryAt(absolutePath);
        return entry?.text ? entry.text.toJSON() : null;
    }

    isSharedFile(absolutePath: string): boolean {
        return this.entryAt(absolutePath)?.kind === 'text';
    }

    /** The id of the shared file at `absolutePath`, or null. */
    fileIdAt(absolutePath: string): string | null {
        const entry = this.entryAt(absolutePath);
        return entry?.kind === 'text' ? entry.id : null;
    }

    /** Where the shared file `fileId` is on disk, or null. */
    pathOf(fileId: string): string | null {
        const mirrored = this.mirrored.get(fileId);
        return mirrored?.kind === 'text' ? this.absolute(mirrored.path) : null;
    }

    /**
     * Handle a save. Saving a shared file's buffer needs nothing, since the
     * document is already current; `replace` (saving other content over the
     * file) puts the content into the document. A new shareable file joins
     * the document, and anything else is left to the caller. Returns whether
     * the mirror handled it.
     */
    write(
        absolutePath: string,
        rawContent: string,
        { replace = false }: { replace?: boolean } = {},
    ): boolean {
        const content = normalizeLineEndings(rawContent);
        const shared = this.entryAt(absolutePath);
        if (shared?.kind === 'text') {
            if (replace && shared.text) {
                const text = shared.text;
                this.doc.transact(() => applyTextDiff(text, content), MIRROR_ORIGIN);
                this.reconcileNow();
            }
            return true;
        }
        const rel = this.relative(absolutePath);
        if (!rel || !isSharedTextPath(rel) || !this.hasRoomFor(content)) {
            return false;
        }
        this.doc.transact(() => {
            createTextEntry(this.doc, rel, content);
        }, MIRROR_ORIGIN);
        this.reconcileNow();
        return true;
    }

    /**
     * Move every entry at or under `from` to the same place under `to`.
     * Returns false when nothing shared lives there, leaving the move to the
     * caller.
     */
    rename(fromAbsolute: string, toAbsolute: string): boolean {
        const from = this.relative(fromAbsolute);
        const to = this.relative(toAbsolute);
        if (!from || !to) {
            return false;
        }
        const moving = listEntries(this.doc).filter((e) =>
            isAtOrUnder(e.path, from),
        );
        if (moving.length === 0) {
            return false;
        }
        // On a case-insensitive disk a rename that only changes case names
        // the same directory entry; renaming it through a temporary name
        // gives the folder its new spelling there.
        const sameEntry =
            from !== to &&
            from.toLowerCase() === to.toLowerCase() &&
            isSameEntry(fromAbsolute, toAbsolute);
        if (sameEntry) {
            const temp = path.join(
                path.dirname(fromAbsolute),
                `.shoreline-rename-${Date.now()}`,
            );
            fs.renameSync(fromAbsolute, temp);
            fs.renameSync(temp, toAbsolute);
        }
        this.doc.transact(() => {
            const map = filesMap(this.doc);
            for (const entry of moving) {
                map.get(entry.id)?.set('path', to + entry.path.slice(from.length));
            }
        }, MIRROR_ORIGIN);
        this.reconcileNow();
        // Unshared files under a moved folder follow it on disk.
        if (!sameEntry && fs.existsSync(fromAbsolute)) {
            fs.mkdirSync(path.dirname(toAbsolute), { recursive: true });
            mergeMove(fromAbsolute, toAbsolute);
        }
        return true;
    }

    /** Remove every entry at or under `absolutePath` from the session. */
    delete(absolutePath: string): void {
        const rel = this.relative(absolutePath);
        if (!rel) {
            return;
        }
        const doomed = listEntries(this.doc).filter((e) =>
            isAtOrUnder(e.path, rel),
        );
        if (doomed.length === 0) {
            return;
        }
        this.doc.transact(() => {
            for (const entry of doomed) {
                filesMap(this.doc).delete(entry.id);
            }
        }, MIRROR_ORIGIN);
        this.reconcileNow();
    }

    createFolder(absolutePath: string): void {
        const rel = this.relative(absolutePath);
        if (!rel || listEntries(this.doc).some((e) => e.path === rel)) {
            return;
        }
        this.doc.transact(() => {
            createDirEntry(this.doc, rel);
        }, MIRROR_ORIGIN);
        this.reconcileNow();
    }

    /** The size of a file worth sharing as an asset, or null. */
    private blobSize(absolute: string): number | null {
        if (!this.options.blobs) {
            return null;
        }
        try {
            const { size } = fs.statSync(absolute);
            return size <= MAX_SHARED_BLOB_BYTES ? size : null;
        } catch {
            return null;
        }
    }

    /** Hash the host's assets in the background and add them to the document. */
    private async seedBlobs(
        blobs: Array<{ rel: string; absolute: string; size: number }>,
    ): Promise<void> {
        const store = this.options.blobs?.store;
        try {
            await this.seedEach(blobs, store);
        } finally {
            for (const blob of blobs) {
                this.seedingBlobs.delete(blob.rel);
            }
        }
        if (!this.disposed) {
            this.scheduleReconcile();
        }
    }

    private async seedEach(
        blobs: Array<{ rel: string; absolute: string; size: number }>,
        store: BlobStore | undefined,
    ): Promise<void> {
        for (const blob of blobs) {
            try {
                if (!store || this.disposed) {
                    return;
                }
                if (listEntries(this.doc).length >= MAX_SHARED_FILES) {
                    return;
                }
                const hash = await store.register(blob.absolute);
                if (this.disposed) {
                    return;
                }
                let id = '';
                this.doc.transact(() => {
                    id = createBlobEntry(this.doc, blob.rel, hash, blob.size);
                }, MIRROR_ORIGIN);
                this.mirrored.set(id, { content: hash, kind: 'blob', path: blob.rel });
            } catch (error) {
                console.warn(`[session] cannot share ${blob.rel}`, error);
            } finally {
                this.seedingBlobs.delete(blob.rel);
            }
        }
    }

    /** Fetch and write a blob entry whose content is not on disk yet. */
    private syncBlob(entry: FileEntry, mirrored: Mirrored | undefined): void {
        const blobs = this.options.blobs;
        const hash = entry.hash;
        if (!blobs || !hash || mirrored?.content === hash) {
            return;
        }
        const key = `${entry.id}:${hash}`;
        if (this.blobsInFlight.has(key) || this.failedBlobs.has(key)) {
            return;
        }
        this.blobsInFlight.add(key);
        void (async () => {
            let settled = true;
            try {
                const available =
                    blobs.store.has(hash) ||
                    (await blobs.fetch(hash, entry.size ?? 0));
                if (!available || this.disposed) {
                    return;
                }
                // The entry may have moved, changed or gone while fetching.
                const now = listEntries(this.doc);
                const current = now.find((e) => e.id === entry.id);
                if (current?.hash !== hash) {
                    return;
                }
                const target = resolveEffectivePaths(now).get(entry.id)!;
                const before = this.mirrored.get(entry.id);
                await blobs.store.materialize(hash, this.absolute(target));
                if (this.disposed) {
                    return;
                }
                this.mirrored.set(entry.id, { content: hash, kind: 'blob', path: target });
                if (before && before.path !== target) {
                    this.removeFile(before.path);
                }
                this.options.onTreeChanged();
                blobs.onArrived();
            } catch (error) {
                // Something on this disk (a folder in the way, permissions)
                // stops the write; retrying would only repeat the copy.
                settled = false;
                this.failedBlobs.add(key);
                console.warn(`[session] cannot write ${entry.path}`, error);
            } finally {
                this.blobsInFlight.delete(key);
                if (settled) {
                    this.scheduleReconcile();
                }
            }
        })();
    }

    /** Take an asset another program added or changed into the document. */
    private async checkBlob(rel: string, absolute: string, size: number): Promise<void> {
        const store = this.options.blobs?.store;
        if (!store || this.seedingBlobs.has(rel)) {
            return;
        }
        let hash: string;
        try {
            hash = await store.register(absolute);
        } catch {
            return;
        }
        if (this.disposed) {
            return;
        }
        const id = this.idAt(rel);
        const mirrored = id ? this.mirrored.get(id) : undefined;
        if (id && mirrored) {
            if (mirrored.kind !== 'blob' || mirrored.content === hash) {
                return;
            }
            const entry = filesMap(this.doc).get(id);
            if (!entry) {
                return;
            }
            mirrored.content = hash;
            this.doc.transact(() => {
                entry.set('hash', hash);
                entry.set('size', size);
            }, MIRROR_ORIGIN);
            return;
        }
        if (listEntries(this.doc).length >= MAX_SHARED_FILES) {
            return;
        }
        let newId = '';
        this.doc.transact(() => {
            newId = createBlobEntry(this.doc, rel, hash, size);
        }, MIRROR_ORIGIN);
        this.mirrored.set(newId, { content: hash, kind: 'blob', path: rel });
        this.reconcileNow();
        this.options.onTreeChanged();
    }

    /** Whether one more file of `content` fits within the session's limits. */
    private hasRoomFor(content: string): boolean {
        const bytes = Buffer.byteLength(content);
        if (bytes > MAX_SHARED_TEXT_BYTES) {
            return false;
        }
        const entries = listEntries(this.doc);
        if (entries.length >= MAX_SHARED_FILES) {
            return false;
        }
        const total = entries.reduce(
            (sum, e) => sum + (e.text ? Buffer.byteLength(e.text.toJSON()) : 0),
            0,
        );
        return total + bytes <= MAX_SHARED_TOTAL_TEXT_BYTES;
    }

    private entryAt(absolutePath: string): FileEntry | null {
        const rel = this.relative(absolutePath);
        if (!rel) {
            return null;
        }
        for (const [id, mirrored] of this.mirrored) {
            if (mirrored.path === rel) {
                const entry = filesMap(this.doc).get(id);
                if (!entry) {
                    return null;
                }
                const text = entry.get('text');
                return {
                    id,
                    kind: mirrored.kind,
                    path: rel,
                    text: text instanceof Y.Text ? text : undefined,
                };
            }
        }
        return null;
    }

    private seedFromDisk(): void {
        const found: Array<{ rel: string; content: string } | { dir: string }> =
            [];
        const blobs: Array<{ rel: string; absolute: string; size: number }> = [];
        let totalBytes = 0;
        const walk = (dir: string, relDir: string) => {
            let names: fs.Dirent[];
            try {
                names = fs.readdirSync(dir, { withFileTypes: true });
            } catch {
                return;
            }
            let sawEntry = false;
            for (const dirent of names) {
                if (found.length >= MAX_SHARED_FILES) {
                    return;
                }
                const rel = normalizeSessionPath(
                    relDir ? `${relDir}/${dirent.name}` : dirent.name,
                );
                if (!rel || dirent.name === 'node_modules') {
                    continue;
                }
                const absolute = path.join(dir, dirent.name);
                if (dirent.isDirectory()) {
                    sawEntry = true;
                    walk(absolute, rel);
                } else if (dirent.isFile() && !isSharedTextPath(rel)) {
                    const size = this.blobSize(absolute);
                    if (size !== null) {
                        sawEntry = true;
                        blobs.push({ absolute, rel, size });
                    }
                } else if (dirent.isFile()) {
                    const content = this.readShareable(absolute, rel);
                    const bytes = content === null ? 0 : Buffer.byteLength(content);
                    if (
                        content !== null &&
                        totalBytes + bytes <= MAX_SHARED_TOTAL_TEXT_BYTES
                    ) {
                        totalBytes += bytes;
                        sawEntry = true;
                        found.push({ content, rel });
                    }
                }
            }
            if (!sawEntry && relDir) {
                found.push({ dir: relDir });
            }
        };
        walk(this.root, '');
        for (const blob of blobs) {
            this.seedingBlobs.add(blob.rel);
        }
        void this.seedBlobs(blobs);
        // Seeded files are already on disk as they are; recording them as
        // mirrored keeps the first reconcile from rewriting them.
        this.doc.transact(() => {
            for (const item of found) {
                if ('dir' in item) {
                    const id = createDirEntry(this.doc, item.dir);
                    this.mirrored.set(id, { content: '', kind: 'dir', path: item.dir });
                } else {
                    const id = createTextEntry(this.doc, item.rel, item.content);
                    this.mirrored.set(id, {
                        content: item.content,
                        kind: 'text',
                        path: item.rel,
                    });
                }
            }
        }, MIRROR_ORIGIN);
    }

    private readShareable(absolute: string, rel: string): string | null {
        try {
            const stat = fs.statSync(absolute);
            if (!stat.isFile() || stat.size > MAX_SHARED_TEXT_BYTES) {
                return null;
            }
            return normalizeLineEndings(
                this.options.fromDisk(rel, fs.readFileSync(absolute, 'utf8')),
            );
        } catch {
            return null;
        }
    }

    private scheduleReconcile(): void {
        if (this.disposed || this.reconcileTimer) {
            return;
        }
        this.reconcileTimer = setTimeout(() => {
            this.reconcileTimer = null;
            try {
                this.reconcileNow();
            } catch (error) {
                console.warn('[session] workspace reconcile failed', error);
            }
        }, RECONCILE_DEBOUNCE_MS);
    }

    /** Bring the folder in line with the document. */
    reconcileNow(): void {
        if (this.disposed) {
            return;
        }
        if (this.reconcileTimer) {
            clearTimeout(this.reconcileTimer);
            this.reconcileTimer = null;
        }
        const entries = listEntries(this.doc);
        const effective = resolveEffectivePaths(entries);
        const byId = new Map(entries.map((e) => [e.id, e]));
        let treeChanged = false;

        // Removed entries.
        for (const [id, mirrored] of [...this.mirrored]) {
            if (byId.has(id)) {
                continue;
            }
            this.mirrored.delete(id);
            if (mirrored.kind === 'dir') {
                this.removeDirIfEmpty(mirrored.path);
            } else {
                this.removeFile(mirrored.path);
            }
            treeChanged = true;
        }

        // Moves go through temporary names first, so swaps and chains of
        // renames never overwrite a file that is about to move away.
        const moves: Array<{ id: string; from: string; to: string; temp: string }> =
            [];
        for (const [id, mirrored] of this.mirrored) {
            const target = effective.get(id);
            if (target && target !== mirrored.path && mirrored.kind !== 'dir') {
                moves.push({
                    from: mirrored.path,
                    id,
                    temp: `.shoreline-move-${id}`,
                    to: target,
                });
            }
        }
        for (const move of moves) {
            this.tryRename(move.from, move.temp);
        }
        for (const move of moves) {
            if (!this.tryRename(move.temp, move.to)) {
                // The source vanished (deleted on disk); rewrite it below.
                this.mirrored.delete(move.id);
            } else {
                this.mirrored.get(move.id)!.path = move.to;
            }
            this.removeEmptyParents(move.from);
            treeChanged = true;
        }

        // Directories, new files and changed text.
        for (const entry of entries) {
            const target = effective.get(entry.id)!;
            const mirrored = this.mirrored.get(entry.id);
            if (entry.kind === 'dir') {
                if (!mirrored || mirrored.path !== target) {
                    try {
                        fs.mkdirSync(this.absolute(target), { recursive: true });
                    } catch (error) {
                        // A file stands where a peer put a folder; skip it.
                        console.warn(`[session] cannot create ${target}`, error);
                        continue;
                    }
                    this.mirrored.set(entry.id, {
                        content: '',
                        kind: 'dir',
                        path: target,
                    });
                    if (mirrored) {
                        this.removeDirIfEmpty(mirrored.path);
                    }
                    treeChanged = true;
                }
                continue;
            }
            if (entry.kind === 'blob') {
                this.syncBlob(entry, mirrored);
                continue;
            }
            const content = entry.text?.toJSON() ?? '';
            if (!mirrored || mirrored.content !== content) {
                if (this.writeFile(target, content)) {
                    treeChanged ||= !mirrored;
                    this.mirrored.set(entry.id, { content, kind: 'text', path: target });
                }
            }
        }
        if (treeChanged) {
            this.options.onTreeChanged();
        }
    }

    private scheduleDiskCheck(filename: string): void {
        if (this.disposed) {
            return;
        }
        const rel = normalizeSessionPath(filename.split(path.sep).join('/'));
        if (!rel || rel.split('/').includes('node_modules')) {
            return;
        }
        clearTimeout(this.diskTimers.get(rel));
        this.diskTimers.set(
            rel,
            setTimeout(() => {
                this.diskTimers.delete(rel);
                this.checkDisk(rel);
            }, DISK_DEBOUNCE_MS),
        );
    }

    /** Take a change another program made to `rel` into the document. */
    private checkDisk(rel: string): void {
        if (this.disposed) {
            return;
        }
        const id = this.idAt(rel);
        const absolute = this.absolute(rel);
        let stat: fs.Stats | null = null;
        try {
            stat = fs.statSync(absolute);
        } catch {
            stat = null;
        }
        if (!stat) {
            const kind = id ? this.mirrored.get(id)?.kind : undefined;
            if (id && (kind === 'text' || kind === 'blob')) {
                this.mirrored.delete(id);
                this.doc.transact(() => filesMap(this.doc).delete(id), MIRROR_ORIGIN);
                this.options.onTreeChanged();
            }
            return;
        }
        if (stat.isDirectory()) {
            // The Linux watcher can miss a file removed just after its folder
            // appeared; the folder's own event still reports that removal.
            for (const mirrored of [...this.mirrored.values()]) {
                if (
                    mirrored.kind !== 'dir' &&
                    mirrored.path.startsWith(`${rel}/`) &&
                    !fs.existsSync(this.absolute(mirrored.path))
                ) {
                    this.checkDisk(mirrored.path);
                }
            }
            const covered = listEntries(this.doc).some((e) => isAtOrUnder(e.path, rel));
            if (!covered && isEmptyDir(absolute)) {
                this.doc.transact(() => createDirEntry(this.doc, rel), MIRROR_ORIGIN);
            }
            return;
        }
        if (!stat.isFile()) {
            return;
        }
        if (!isSharedTextPath(rel)) {
            const size = this.blobSize(absolute);
            const inFlight = id
                ? [...this.blobsInFlight].some((key) => key.startsWith(`${id}:`))
                : false;
            if (size !== null && !inFlight) {
                void this.checkBlob(rel, absolute, size);
            }
            return;
        }
        const content = this.readShareable(absolute, rel);
        if (content === null) {
            return;
        }
        if (id) {
            const mirrored = this.mirrored.get(id)!;
            if (mirrored.kind !== 'text' || mirrored.content === content) {
                return;
            }
            const text = filesMap(this.doc).get(id)?.get('text');
            if (!(text instanceof Y.Text) || text.toJSON() !== mirrored.content) {
                // The document moved on since the last write; it wins.
                this.scheduleReconcile();
                return;
            }
            mirrored.content = content;
            this.doc.transact(() => applyTextDiff(text, content), MIRROR_ORIGIN);
            return;
        }
        if (!this.hasRoomFor(content)) {
            return;
        }
        let newId = '';
        this.doc.transact(() => {
            newId = createTextEntry(this.doc, rel, content);
        }, MIRROR_ORIGIN);
        this.mirrored.set(newId, { content, kind: 'text', path: rel });
        // A concurrent remote file may hold this path; reconcile settles it.
        this.reconcileNow();
        this.options.onTreeChanged();
    }

    private idAt(rel: string): string | null {
        for (const [id, mirrored] of this.mirrored) {
            if (mirrored.path === rel) {
                return id;
            }
        }
        return null;
    }

    private absolute(rel: string): string {
        return path.join(this.root, ...rel.split('/'));
    }

    private writeFile(rel: string, content: string): boolean {
        const absolute = this.absolute(rel);
        try {
            fs.mkdirSync(path.dirname(absolute), { recursive: true });
            fs.writeFileSync(absolute, this.options.toDisk(rel, content), 'utf8');
            return true;
        } catch (error) {
            console.warn(`[session] cannot write ${rel}`, error);
            return false;
        }
    }

    private tryRename(from: string, to: string): boolean {
        try {
            fs.mkdirSync(path.dirname(this.absolute(to)), { recursive: true });
            fs.renameSync(this.absolute(from), this.absolute(to));
            return true;
        } catch {
            return false;
        }
    }

    private removeFile(rel: string): void {
        try {
            fs.rmSync(this.absolute(rel), { force: true });
        } catch (error) {
            console.warn(`[session] cannot remove ${rel}`, error);
        }
        this.removeEmptyParents(rel);
    }

    private removeDirIfEmpty(rel: string): void {
        if (this.dirClaimed(rel)) {
            return;
        }
        try {
            fs.rmdirSync(this.absolute(rel));
        } catch {
            // Not empty, or already gone.
        }
        this.removeEmptyParents(rel);
    }

    /** Remove directories left empty above `rel` that no entry claims. */
    private removeEmptyParents(rel: string): void {
        const segments = rel.split('/');
        for (let i = segments.length - 1; i > 0; i--) {
            const dir = segments.slice(0, i).join('/');
            if (this.dirClaimed(dir)) {
                return;
            }
            try {
                fs.rmdirSync(this.absolute(dir));
            } catch {
                return;
            }
        }
    }

    private dirClaimed(rel: string): boolean {
        for (const mirrored of this.mirrored.values()) {
            if (isAtOrUnder(mirrored.path, rel)) {
                return true;
            }
        }
        return false;
    }
}

/**
 * Editors bind shared text with LF line endings, so offsets in the document
 * and in every editor agree.
 */
function normalizeLineEndings(content: string): string {
    return content.replace(/\r\n?/g, '\n');
}

function isEmptyDir(absolute: string): boolean {
    try {
        return fs.readdirSync(absolute).length === 0;
    } catch {
        return false;
    }
}

/** Move `from` onto `to`, merging into an existing directory there. */
function isSameEntry(a: string, b: string): boolean {
    try {
        const sa = fs.statSync(a);
        const sb = fs.statSync(b);
        return sa.dev === sb.dev && sa.ino === sb.ino;
    } catch {
        return false;
    }
}

function mergeMove(from: string, to: string): void {
    if (!fs.existsSync(to)) {
        fs.renameSync(from, to);
        return;
    }
    if (fs.statSync(from).isDirectory() && fs.statSync(to).isDirectory()) {
        for (const name of fs.readdirSync(from)) {
            mergeMove(path.join(from, name), path.join(to, name));
        }
        fs.rmdirSync(from);
    }
}
