import * as fs from 'fs';
import * as path from 'path';
import * as Y from 'yjs';
import {
    type FileEntry,
    MAX_SHARED_FILES,
    MAX_SHARED_TEXT_BYTES,
    applyTextDiff,
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
}

interface Mirrored {
    path: string;
    kind: 'text' | 'dir';
    /** Text as last written to or read from disk, before `toDisk`. */
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

    /**
     * Handle a save. Saving a shared file's buffer needs nothing, since the
     * document is already current; `replace` (saving other content over the
     * file) puts the content into the document. A new shareable file joins
     * the document, and anything else is left to the caller. Returns whether
     * the mirror handled it.
     */
    write(
        absolutePath: string,
        content: string,
        { replace = false }: { replace?: boolean } = {},
    ): boolean {
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
        if (
            !rel ||
            !isSharedTextPath(rel) ||
            Buffer.byteLength(content) > MAX_SHARED_TEXT_BYTES ||
            listEntries(this.doc).length >= MAX_SHARED_FILES
        ) {
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
        this.doc.transact(() => {
            const map = filesMap(this.doc);
            for (const entry of moving) {
                map.get(entry.id)?.set('path', to + entry.path.slice(from.length));
            }
        }, MIRROR_ORIGIN);
        this.reconcileNow();
        // Unshared files under a moved folder follow it on disk.
        if (fs.existsSync(fromAbsolute)) {
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
                } else if (dirent.isFile() && isSharedTextPath(rel)) {
                    const content = this.readShareable(absolute, rel);
                    if (content !== null) {
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
            // Editors bind shared text with LF line endings, so offsets in
            // the document and the editor agree.
            return this.options
                .fromDisk(rel, fs.readFileSync(absolute, 'utf8'))
                .replace(/\r\n?/g, '\n');
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
            this.reconcileNow();
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
            if (mirrored.kind === 'text') {
                this.removeFile(mirrored.path);
            } else {
                this.removeDirIfEmpty(mirrored.path);
            }
            treeChanged = true;
        }

        // Moves go through temporary names first, so swaps and chains of
        // renames never overwrite a file that is about to move away.
        const moves: Array<{ id: string; from: string; to: string; temp: string }> =
            [];
        for (const [id, mirrored] of this.mirrored) {
            const target = effective.get(id);
            if (target && target !== mirrored.path && mirrored.kind === 'text') {
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
                    fs.mkdirSync(this.absolute(target), { recursive: true });
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
            if (id && this.mirrored.get(id)?.kind === 'text') {
                this.mirrored.delete(id);
                this.doc.transact(() => filesMap(this.doc).delete(id), MIRROR_ORIGIN);
                this.options.onTreeChanged();
            }
            return;
        }
        if (stat.isDirectory()) {
            const covered = listEntries(this.doc).some((e) => isAtOrUnder(e.path, rel));
            if (!covered && fs.readdirSync(absolute).length === 0) {
                this.doc.transact(() => createDirEntry(this.doc, rel), MIRROR_ORIGIN);
            }
            return;
        }
        if (!stat.isFile() || !isSharedTextPath(rel)) {
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
        if (listEntries(this.doc).length >= MAX_SHARED_FILES) {
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

/** Move `from` onto `to`, merging into an existing directory there. */
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
