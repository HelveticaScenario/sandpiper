import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import {
    createBlobEntry,
    createDirEntry,
    createTextEntry,
    filesMap,
    listEntries,
} from '../../../shared/sessionWorkspace';
import { BlobStore } from '../blobStore';
import { type MirrorBlobs, WorkspaceMirror } from '../workspaceMirror';
import { sleep, waitFor } from './meshTestUtils';

type WatchListener = (event: fs.WatchEventType, filename: string | Buffer | null) => void;

/** Disk events the workspace watcher drops, as a lagging watcher would. */
let dropDiskEvent: (filename: string) => boolean = () => false;
/** The listener of the most recently started workspace watcher. */
let lastWatchListener: WatchListener | null = null;

vi.mock('fs', async (importOriginal) => {
    const actual = await importOriginal<typeof import('fs')>();
    const watch = (target: string, options: fs.WatchOptions, listener: WatchListener) => {
        lastWatchListener = listener;
        return actual.watch(target, options, (event, filename) => {
            if (!filename || !dropDiskEvent(filename.toString())) {
                listener(event, filename);
            }
        });
    };
    return { ...actual, watch };
});

const STAMP = '/* stamp */\n';
const mirrors: WorkspaceMirror[] = [];
const dirs: string[] = [];

afterEach(() => {
    dropDiskEvent = () => false;
    for (const mirror of mirrors.splice(0)) {
        mirror.dispose();
    }
    for (const dir of dirs.splice(0)) {
        fs.rmSync(dir, { force: true, recursive: true });
    }
});

function tempDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-mirror-'));
    dirs.push(dir);
    return dir;
}

function write(root: string, rel: string, content: string | Buffer): void {
    const file = path.join(root, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
}

function read(root: string, rel: string): string {
    return fs.readFileSync(path.join(root, rel), 'utf8');
}

function exists(root: string, rel: string): boolean {
    return fs.existsSync(path.join(root, rel));
}

function startMirror(
    doc: Y.Doc,
    root: string,
    seed: boolean,
    blobs?: MirrorBlobs,
) {
    let treeChanges = 0;
    const m = new WorkspaceMirror(doc, root, {
        blobs,
        fromDisk: (rel, content) =>
            rel.endsWith('.js') && content.startsWith(STAMP)
                ? content.slice(STAMP.length)
                : content,
        onTreeChanged: () => {
            treeChanges++;
        },
        toDisk: (rel, content) => (rel.endsWith('.js') ? STAMP + content : content),
    });
    mirrors.push(m);
    m.start({ seed });
    return { mirror: m, treeChanges: () => treeChanges };
}

/** Two docs that exchange every update, as connected peers do. */
function linkedDocs(): [Y.Doc, Y.Doc] {
    const a = new Y.Doc();
    const b = new Y.Doc();
    a.on('update', (update, origin) => {
        if (origin !== 'link') Y.applyUpdate(b, update, 'link');
    });
    b.on('update', (update, origin) => {
        if (origin !== 'link') Y.applyUpdate(a, update, 'link');
    });
    return [a, b];
}

function textAt(doc: Y.Doc, rel: string): Y.Text {
    const found = listEntries(doc).find((e) => e.path === rel);
    if (!found?.text) throw new Error(`no text at ${rel}`);
    return found.text;
}

describe('WorkspaceMirror seeding', () => {
    it('shares text files, skips audio, hidden, node_modules and oversize files', () => {
        const root = tempDir();
        write(root, 'patch.js', `${STAMP}$sine("C4").out()`);
        write(root, 'songs/intro.mjs', 'intro');
        write(root, 'notes.json', '{}');
        write(root, 'wavs/kick.wav', Buffer.alloc(100));
        write(root, '.git/config', 'x');
        write(root, '.hidden.js', 'x');
        write(root, 'node_modules/pkg/index.js', 'x');
        write(root, 'huge.js', 'x'.repeat(1024 * 1024 + 1));
        fs.mkdirSync(path.join(root, 'empty'));
        const before = fs.statSync(path.join(root, 'patch.js')).mtimeMs;

        const doc = new Y.Doc();
        startMirror(doc, root, true);

        expect(
            listEntries(doc)
                .map((e) => `${e.kind}:${e.path}`)
                .sort(),
        ).toEqual([
            'dir:empty',
            'text:notes.json',
            'text:patch.js',
            'text:songs/intro.mjs',
            // A folder of unshared files still gives guests the folder.
            'dir:wavs',
        ].sort());
        expect(textAt(doc, 'patch.js').toJSON()).toBe('$sine("C4").out()');
        // Seeding never rewrites the host's files.
        expect(fs.statSync(path.join(root, 'patch.js')).mtimeMs).toBe(before);
    });
});

describe('WorkspaceMirror remote changes', () => {
    it('materialises a joined session into an empty folder', () => {
        const [a, b] = linkedDocs();
        const hostRoot = tempDir();
        write(hostRoot, 'patch.js', 'host code');
        write(hostRoot, 'dir/sub.json', '[1]');
        startMirror(a, hostRoot, true);
        const guestRoot = tempDir();
        startMirror(b, guestRoot, false);
        expect(read(guestRoot, 'patch.js')).toBe(`${STAMP}host code`);
        expect(read(guestRoot, 'dir/sub.json')).toBe('[1]');
    });

    it('writes remote edits, renames and deletes to disk', async () => {
        const [a, b] = linkedDocs();
        const hostRoot = tempDir();
        write(hostRoot, 'a.js', 'one');
        write(hostRoot, 'dir/b.js', 'two');
        startMirror(a, hostRoot, true);
        const guestRoot = tempDir();
        const guest = startMirror(b, guestRoot, false);

        textAt(a, 'a.js').insert(3, ' plus');
        await waitFor(() => read(guestRoot, 'a.js') === `${STAMP}one plus`);

        const bId = listEntries(a).find((e) => e.path === 'dir/b.js')!.id;
        filesMap(a).get(bId)!.set('path', 'moved/b.js');
        await waitFor(() => exists(guestRoot, 'moved/b.js'));
        expect(exists(guestRoot, 'dir/b.js')).toBe(false);
        // The emptied directory goes too.
        expect(exists(guestRoot, 'dir')).toBe(false);

        const aId = listEntries(a).find((e) => e.path === 'a.js')!.id;
        filesMap(a).delete(aId);
        await waitFor(() => !exists(guestRoot, 'a.js'));
        expect(guest.treeChanges()).toBeGreaterThan(0);
    });

    it('swaps two files by name without losing either', async () => {
        const [a, b] = linkedDocs();
        const hostRoot = tempDir();
        write(hostRoot, 'x.js', 'X');
        write(hostRoot, 'y.js', 'Y');
        startMirror(a, hostRoot, true);
        const guestRoot = tempDir();
        startMirror(b, guestRoot, false);
        const x = listEntries(a).find((e) => e.path === 'x.js')!.id;
        const y = listEntries(a).find((e) => e.path === 'y.js')!.id;
        a.transact(() => {
            filesMap(a).get(x)!.set('path', 'y.js');
            filesMap(a).get(y)!.set('path', 'x.js');
        });
        await waitFor(() => read(guestRoot, 'x.js') === `${STAMP}Y`);
        expect(read(guestRoot, 'y.js')).toBe(`${STAMP}X`);
        // The host's files move on disk; their bytes stay as they were.
        expect(read(hostRoot, 'x.js')).toBe('Y');
        expect(read(hostRoot, 'y.js')).toBe('X');
    });

    it('gives both of two same-named files a place, identically on both peers', async () => {
        const a = new Y.Doc();
        const b = new Y.Doc();
        const rootA = tempDir();
        const rootB = tempDir();
        startMirror(a, rootA, false);
        startMirror(b, rootB, false);
        // Created while disconnected, then merged.
        a.transact(() => createTextEntry(a, 'song.js', 'from a'));
        b.transact(() => createTextEntry(b, 'Song.js', 'from b'));
        Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
        Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
        await sleep(150);
        const filesA = fs.readdirSync(rootA).sort();
        const filesB = fs.readdirSync(rootB).sort();
        expect(filesA).toHaveLength(2);
        expect(filesA).toEqual(filesB);
        const contents = (root: string) =>
            fs
                .readdirSync(root)
                .sort()
                .map((f) => read(root, f));
        expect(contents(rootA)).toEqual(contents(rootB));
    });

    it('never writes an entry whose path escapes the workspace', async () => {
        const doc = new Y.Doc();
        const root = tempDir();
        const outside = path.join(path.dirname(root), 'evil-escape.js');
        startMirror(doc, root, false);
        for (const bad of ['../evil-escape.js', '/tmp/evil.js', 'a/../../evil-escape.js']) {
            const entry = new Y.Map<unknown>();
            entry.set('path', bad);
            entry.set('kind', 'text');
            entry.set('text', new Y.Text('pwned'));
            filesMap(doc).set(bad, entry);
        }
        await sleep(100);
        expect(fs.existsSync(outside)).toBe(false);
        expect(fs.readdirSync(root)).toEqual([]);
    });

    it('stops writing once disposed', async () => {
        const doc = new Y.Doc();
        const root = tempDir();
        const { mirror: m } = startMirror(doc, root, false);
        m.dispose();
        createTextEntry(doc, 'late.js', 'x');
        await sleep(100);
        expect(exists(root, 'late.js')).toBe(false);
    });
});

describe('WorkspaceMirror disk changes', () => {
    it('takes an external edit into the document', async () => {
        const doc = new Y.Doc();
        const root = tempDir();
        write(root, 'a.js', 'before');
        startMirror(doc, root, true);
        await sleep(50);
        write(root, 'a.js', `${STAMP}after`);
        await waitFor(() => textAt(doc, 'a.js').toJSON() === 'after', 5000);
    });

    it('lets the document win over an external edit when it moved on', async () => {
        const doc = new Y.Doc();
        const root = tempDir();
        write(root, 'a.js', 'base');
        const { mirror: m } = startMirror(doc, root, true);
        // Stop the reconcile from writing the doc change before the disk edit
        // lands, so the two genuinely race.
        textAt(doc, 'a.js').insert(4, ' doc');
        write(root, 'a.js', 'disk');
        await sleep(400);
        m.reconcileNow();
        expect(textAt(doc, 'a.js').toJSON()).toBe('base doc');
        expect(read(root, 'a.js')).toBe(`${STAMP}base doc`);
    });

    it('adds new external files and removes externally deleted ones', async () => {
        const doc = new Y.Doc();
        const root = tempDir();
        write(root, 'keep.js', 'k');
        write(root, 'gone.js', 'g');
        startMirror(doc, root, true);
        await sleep(50);
        write(root, 'new.js', 'n');
        fs.rmSync(path.join(root, 'gone.js'));
        await waitFor(
            () =>
                listEntries(doc).some((e) => e.path === 'new.js') &&
                !listEntries(doc).some((e) => e.path === 'gone.js'),
            5000,
        );
        expect(textAt(doc, 'new.js').toJSON()).toBe('n');
    });

    it('removes a deleted file when the watcher reports only its folder', async () => {
        const doc = new Y.Doc();
        const root = tempDir();
        write(root, 'drums/kick.js', 'k');
        startMirror(doc, root, true);
        // Let the events from writing the file settle first.
        await sleep(400);
        dropDiskEvent = (filename) => filename.endsWith('kick.js');
        fs.rmSync(path.join(root, 'drums/kick.js'));
        lastWatchListener!('rename', 'drums');
        await waitFor(
            () => !listEntries(doc).some((e) => e.path === 'drums/kick.js'),
            5000,
        );
    });

    it('does not echo its own writes back into the document', async () => {
        const [a, b] = linkedDocs();
        const hostRoot = tempDir();
        write(hostRoot, 'a.js', 'x');
        startMirror(a, hostRoot, true);
        startMirror(b, tempDir(), false);
        let updates = 0;
        a.on('update', () => updates++);
        textAt(a, 'a.js').insert(1, 'y');
        await sleep(400);
        // Only the edit itself; neither mirror's disk write came back.
        expect(updates).toBe(1);
        expect(textAt(a, 'a.js').toJSON()).toBe('xy');
    });
});

describe('WorkspaceMirror local operations', () => {
    it('adds a newly saved shareable file and ignores saves of shared files', () => {
        const doc = new Y.Doc();
        const root = tempDir();
        const { mirror: m } = startMirror(doc, root, false);
        expect(m.write(path.join(root, 'new.js'), 'fresh')).toBe(true);
        expect(read(root, 'new.js')).toBe(`${STAMP}fresh`);
        expect(textAt(doc, 'new.js').toJSON()).toBe('fresh');
        // The document is the source of truth for shared files.
        expect(m.write(path.join(root, 'new.js'), 'stale')).toBe(true);
        expect(textAt(doc, 'new.js').toJSON()).toBe('fresh');
        expect(m.readText(path.join(root, 'new.js'))).toBe('fresh');
        // Saving other content over the file (save-as) replaces it.
        expect(
            m.write(path.join(root, 'new.js'), 'replaced', { replace: true }),
        ).toBe(true);
        expect(textAt(doc, 'new.js').toJSON()).toBe('replaced');
        expect(read(root, 'new.js')).toBe(`${STAMP}replaced`);
        // Non-shareable files are the caller's to write.
        expect(m.write(path.join(root, 'kick.wav'), 'x')).toBe(false);
        expect(m.write(path.join(path.dirname(root), 'out.js'), 'x')).toBe(false);
    });

    it('renames a folder with its shared and unshared contents', () => {
        const doc = new Y.Doc();
        const root = tempDir();
        write(root, 'drums/kick.js', 'k');
        write(root, 'drums/kick.wav', 'RIFF');
        const { mirror: m } = startMirror(doc, root, true);
        expect(m.rename(path.join(root, 'drums'), path.join(root, 'perc'))).toBe(true);
        expect(read(root, 'perc/kick.js')).toBe('k');
        expect(read(root, 'perc/kick.wav')).toBe('RIFF');
        expect(exists(root, 'drums')).toBe(false);
        expect(listEntries(doc).map((e) => e.path)).toEqual(['perc/kick.js']);
    });

    it('leaves renames of unshared files to the caller', () => {
        const doc = new Y.Doc();
        const root = tempDir();
        write(root, 'kick.wav', 'RIFF');
        const { mirror: m } = startMirror(doc, root, true);
        expect(m.rename(path.join(root, 'kick.wav'), path.join(root, 'k.wav'))).toBe(
            false,
        );
    });

    it('deletes a folder of shared files and creates folders', () => {
        const doc = new Y.Doc();
        const root = tempDir();
        write(root, 'a/b.js', 'b');
        write(root, 'a/c.js', 'c');
        const { mirror: m } = startMirror(doc, root, true);
        m.delete(path.join(root, 'a'));
        expect(listEntries(doc)).toEqual([]);
        expect(exists(root, 'a')).toBe(false);
        m.createFolder(path.join(root, 'loops'));
        expect(fs.statSync(path.join(root, 'loops')).isDirectory()).toBe(true);
        expect(listEntries(doc).map((e) => `${e.kind}:${e.path}`)).toEqual(['dir:loops']);
    });
});

describe('WorkspaceMirror robustness', () => {
    it('skips a peer folder that collides with a local file and keeps mirroring the rest', async () => {
        const [a, b] = linkedDocs();
        const guestRoot = tempDir();
        write(guestRoot, 'kick.wav', 'RIFF');
        startMirror(b, guestRoot, false);
        const hostRoot = tempDir();
        startMirror(a, hostRoot, false);
        a.transact(() => {
            createDirEntry(a, 'kick.wav');
            createTextEntry(a, 'after.js', 'still here');
        });
        await waitFor(() => exists(guestRoot, 'after.js'));
        expect(read(guestRoot, 'kick.wav')).toBe('RIFF');
    });

    it('stores saved text with LF line endings', () => {
        const doc = new Y.Doc();
        const root = tempDir();
        const { mirror: m } = startMirror(doc, root, false);
        m.write(path.join(root, 'win.js'), 'a\r\nb\rc\n');
        expect(textAt(doc, 'win.js').toJSON()).toBe('a\nb\nc\n');
        m.write(path.join(root, 'win.js'), 'x\r\ny', { replace: true });
        expect(textAt(doc, 'win.js').toJSON()).toBe('x\ny');
    });

    it('renames a folder by case alone', () => {
        const doc = new Y.Doc();
        const root = tempDir();
        write(root, 'drums/kick.js', 'k');
        const { mirror: m } = startMirror(doc, root, true);
        expect(m.rename(path.join(root, 'drums'), path.join(root, 'Drums'))).toBe(true);
        expect(listEntries(doc).map((e) => e.path)).toEqual(['Drums/kick.js']);
        expect(fs.readdirSync(root)).toContain('Drums');
        expect(read(root, 'Drums/kick.js')).toBe('k');
    });

    it('stops adding files once the session holds its total text limit', () => {
        const doc = new Y.Doc();
        const root = tempDir();
        const { mirror: m } = startMirror(doc, root, false);
        const big = 'x'.repeat(1024 * 1024 - 16);
        let added = 0;
        for (let i = 0; i < 30; i++) {
            if (m.write(path.join(root, `f${i}.txt`), big)) {
                added++;
            }
        }
        expect(added).toBe(24);
    });
});

/**
 * Two peers' asset stores, where fetching copies a blob from whichever other
 * store has it, as the transfer between connected peers does.
 */
function linkedStores() {
    const stores = [new BlobStore(tempDir()), new BlobStore(tempDir())];
    const arrivals = [0, 0];
    const blobs = stores.map(
        (store, i): MirrorBlobs => ({
            fetch: async (hash) => {
                const other = stores[1 - i].readablePath(hash);
                if (!other) {
                    return false;
                }
                await store.addFile(other);
                return true;
            },
            onArrived: () => {
                arrivals[i]++;
            },
            store,
        }),
    );
    return { arrivals, blobs, stores };
}

describe('WorkspaceMirror assets', () => {
    it('shares the host’s assets by hash without copying them', async () => {
        const [a, b] = linkedDocs();
        const { arrivals, blobs, stores } = linkedStores();
        const hostRoot = tempDir();
        const kick = Buffer.from('RIFF....WAVEfmt kick');
        write(hostRoot, 'wavs/kick.wav', kick);
        startMirror(a, hostRoot, true, blobs[0]);
        await waitFor(() => listEntries(a).some((e) => e.kind === 'blob'));
        const entry = listEntries(a).find((e) => e.kind === 'blob')!;
        expect(entry).toMatchObject({ path: 'wavs/kick.wav', size: kick.length });
        // Registered in place, not copied into the store.
        expect(fs.readdirSync(stores[0].dir)).toEqual([]);

        const guestRoot = tempDir();
        startMirror(b, guestRoot, false, blobs[1]);
        await waitFor(() => exists(guestRoot, 'wavs/kick.wav'));
        expect(fs.readFileSync(path.join(guestRoot, 'wavs/kick.wav')).equals(kick)).toBe(
            true,
        );
        expect(arrivals[1]).toBe(1);
    });

    it('follows changes, renames and deletions of assets', async () => {
        const [a, b] = linkedDocs();
        const { blobs } = linkedStores();
        const hostRoot = tempDir();
        write(hostRoot, 'snare.wav', 'v1');
        startMirror(a, hostRoot, true, blobs[0]);
        const guestRoot = tempDir();
        startMirror(b, guestRoot, false, blobs[1]);
        await waitFor(() => exists(guestRoot, 'snare.wav'));

        // Another program replaces the sample on the host.
        write(hostRoot, 'snare.wav', 'v2 longer');
        await waitFor(() => read(guestRoot, 'snare.wav') === 'v2 longer', 5000);

        const id = listEntries(a).find((e) => e.kind === 'blob')!.id;
        filesMap(a).get(id)!.set('path', 'drums/snare.wav');
        await waitFor(
            () =>
                exists(hostRoot, 'drums/snare.wav') &&
                exists(guestRoot, 'drums/snare.wav'),
        );
        expect(exists(guestRoot, 'snare.wav')).toBe(false);

        fs.rmSync(path.join(hostRoot, 'drums/snare.wav'));
        await waitFor(() => !exists(guestRoot, 'drums/snare.wav'), 5000);
    });

    it('shares an asset a guest drops into its folder', async () => {
        const [a, b] = linkedDocs();
        const { blobs } = linkedStores();
        const hostRoot = tempDir();
        startMirror(a, hostRoot, true, blobs[0]);
        const guestRoot = tempDir();
        startMirror(b, guestRoot, false, blobs[1]);
        await sleep(50);
        write(guestRoot, 'loops/break.wav', 'amen');
        await waitFor(() => exists(hostRoot, 'loops/break.wav'), 5000);
        expect(read(hostRoot, 'loops/break.wav')).toBe('amen');
    });

    it('keeps a blob entry off disk until its content can be fetched', async () => {
        const doc = new Y.Doc();
        const root = tempDir();
        let release: (ok: boolean) => void = () => {};
        const store = new BlobStore(tempDir());
        startMirror(doc, root, false, {
            fetch: () => new Promise((resolve) => (release = resolve)),
            onArrived: () => {},
            store,
        });
        doc.transact(() =>
            createBlobEntry(doc, 'far.wav', 'a'.repeat(64), 10),
        );
        await sleep(100);
        expect(exists(root, 'far.wav')).toBe(false);
        release(false);
        await sleep(50);
        expect(exists(root, 'far.wav')).toBe(false);
    });
});

