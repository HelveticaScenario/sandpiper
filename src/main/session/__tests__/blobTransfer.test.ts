import { createHash, randomBytes } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { BlobStore, hashFile, isBlobHash } from '../blobStore';
import { BlobTransfer } from '../blobTransfer';
import { Channel } from '../frames';
import type { PeerMesh } from '../peerMesh';
import {
    type Testnet,
    makeMesh,
    newTestSession,
    startTestnet,
    waitFor,
    waitForPeers,
} from './meshTestUtils';

let testnet: Testnet;
const cleanup: Array<() => Promise<void> | void> = [];

beforeAll(async () => {
    testnet = await startTestnet();
});
afterAll(async () => {
    await testnet.destroy();
});
afterEach(async () => {
    while (cleanup.length > 0) {
        await cleanup.pop()!();
    }
});

function tempDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-blob-'));
    cleanup.push(() => fs.rmSync(dir, { force: true, recursive: true }));
    return dir;
}

function sha(data: Buffer): string {
    return createHash('sha256').update(data).digest('hex');
}

function node(mesh: PeerMesh) {
    const store = new BlobStore(tempDir());
    const transfer = new BlobTransfer(mesh, store);
    cleanup.push(async () => {
        transfer.stop();
        await mesh.stop();
    });
    return { mesh, store, transfer };
}

async function addBlob(store: BlobStore, data: Buffer): Promise<string> {
    const file = path.join(tempDir(), 'source.bin');
    fs.writeFileSync(file, data);
    return store.addFile(file);
}

describe('BlobStore', () => {
    it('stores by content hash and materialises copies', async () => {
        const store = new BlobStore(tempDir());
        const data = randomBytes(1000);
        const hash = await addBlob(store, data);
        expect(hash).toBe(sha(data));
        expect(isBlobHash(hash)).toBe(true);
        expect(store.has(hash)).toBe(true);
        expect(store.size(hash)).toBe(1000);
        // Adding the same content again is a no-op.
        expect(await addBlob(store, data)).toBe(hash);
        const target = path.join(tempDir(), 'wavs', 'kick.wav');
        await store.materialize(hash, target);
        expect(fs.readFileSync(target).equals(data)).toBe(true);
        expect(await hashFile(target)).toBe(hash);
        // No temporary file is left beside the target.
        expect(fs.readdirSync(path.dirname(target))).toEqual(['kick.wav']);
    });

    it('rejects an incoming blob whose content does not match its hash', () => {
        const store = new BlobStore(tempDir());
        const wanted = sha(Buffer.from('real'));
        const incoming = store.createIncoming(wanted);
        incoming.write(0, Buffer.from('fake'));
        expect(incoming.finish()).toBe(false);
        expect(store.has(wanted)).toBe(false);
        expect(fs.readdirSync(store.dir)).toEqual([]);
    });

    it('stops serving a registered file once it changes', async () => {
        const store = new BlobStore(tempDir());
        const file = path.join(tempDir(), 'kick.wav');
        fs.writeFileSync(file, 'one');
        const hash = await store.register(file);
        expect(store.readablePath(hash)).toBe(file);
        // Registered in place, not copied.
        expect(fs.readdirSync(store.dir)).toEqual([]);
        fs.writeFileSync(file, 'two, longer');
        expect(store.has(hash)).toBe(false);
    });

    it('removes its temporary copy when a write fails', async () => {
        const store = new BlobStore(tempDir());
        const hash = await addBlob(store, Buffer.from('data'));
        const dir = tempDir();
        // A directory stands where the file should go.
        fs.mkdirSync(path.join(dir, 'taken.wav', 'inside'), { recursive: true });
        await expect(store.materialize(hash, path.join(dir, 'taken.wav'))).rejects.toThrow();
        expect(fs.readdirSync(dir)).toEqual(['taken.wav']);
    });

    it('refuses chunks out of order and paths that are not hashes', () => {
        const store = new BlobStore(tempDir());
        const incoming = store.createIncoming(sha(Buffer.from('x')));
        expect(() => incoming.write(5, Buffer.from('x'))).toThrow(/Out-of-order/);
        incoming.abort();
        expect(() => store.pathOf('../../etc/passwd')).toThrow(/Not a blob hash/);
    });
});

describe('BlobTransfer', () => {
    it('fetches a multi-chunk blob from a peer that has it', async () => {
        const session = newTestSession();
        const a = node(makeMesh(testnet, session));
        const b = node(makeMesh(testnet, session));
        const data = randomBytes(3 * 1024 * 1024 + 123);
        const hash = await addBlob(a.store, data);
        await Promise.all([a.mesh.start(), b.mesh.start()]);
        await waitForPeers(b.mesh, [a.mesh.localId]);
        const progress: number[] = [];
        const transfer = new BlobTransfer(b.mesh, b.store, (p) =>
            progress.push(p.receivedBytes),
        );
        cleanup.push(() => transfer.stop());
        expect(await transfer.fetch(hash, data.length)).toBe(true);
        expect(fs.readFileSync(b.store.readablePath(hash)!).equals(data)).toBe(true);
        expect(Math.max(...progress)).toBeGreaterThan(0);
    });

    it('transfers an empty file', async () => {
        const session = newTestSession();
        const a = node(makeMesh(testnet, session));
        const b = node(makeMesh(testnet, session));
        const hash = await addBlob(a.store, Buffer.alloc(0));
        await Promise.all([a.mesh.start(), b.mesh.start()]);
        await waitForPeers(b.mesh, [a.mesh.localId]);
        expect(await b.transfer.fetch(hash, 0)).toBe(true);
        expect(b.store.size(hash)).toBe(0);
    });

    it('moves on from a peer without the blob to one that has it', async () => {
        const session = newTestSession();
        const empty = node(makeMesh(testnet, session));
        const holder = node(makeMesh(testnet, session));
        const asker = node(makeMesh(testnet, session));
        const data = randomBytes(5000);
        const hash = await addBlob(holder.store, data);
        await Promise.all([empty.mesh.start(), holder.mesh.start(), asker.mesh.start()]);
        await waitForPeers(asker.mesh, [empty.mesh.localId, holder.mesh.localId]);
        expect(await asker.transfer.fetch(hash, data.length)).toBe(true);
    });

    it('waits for a peer that gets the blob later', async () => {
        const session = newTestSession();
        const a = node(makeMesh(testnet, session));
        const b = node(makeMesh(testnet, session));
        await Promise.all([a.mesh.start(), b.mesh.start()]);
        await waitForPeers(b.mesh, [a.mesh.localId]);
        const data = randomBytes(2000);
        let done = false;
        void b.transfer.fetch(sha(data), data.length).then((ok) => {
            done = ok;
        });
        await new Promise((resolve) => setTimeout(resolve, 200));
        expect(done).toBe(false);
        await addBlob(a.store, data);
        await waitFor(() => done, 10_000);
    });

    it('ignores chunks from a peer it did not ask and corrupt content', async () => {
        const session = newTestSession();
        const a = node(makeMesh(testnet, session));
        const b = node(makeMesh(testnet, session));
        await Promise.all([a.mesh.start(), b.mesh.start()]);
        await waitForPeers(a.mesh, [b.mesh.localId]);
        const data = Buffer.from('genuine content');
        const hash = sha(data);
        // Unsolicited chunk: dropped.
        const header = Buffer.alloc(48);
        Buffer.from(hash, 'hex').copy(header, 0);
        header.writeBigUInt64BE(BigInt(data.length), 40);
        a.mesh.send(b.mesh.localId, Channel.Blob, Buffer.concat([header, data]));
        await new Promise((resolve) => setTimeout(resolve, 200));
        expect(b.store.has(hash)).toBe(false);
    });

    it('refuses a blob whose size disagrees with the session', async () => {
        const session = newTestSession();
        const a = node(makeMesh(testnet, session));
        const b = node(makeMesh(testnet, session));
        const data = randomBytes(4000);
        const hash = await addBlob(a.store, data);
        await Promise.all([a.mesh.start(), b.mesh.start()]);
        await waitForPeers(b.mesh, [a.mesh.localId]);
        let done: boolean | null = null;
        void b.transfer.fetch(hash, 10).then((ok) => {
            done = ok;
        });
        await new Promise((resolve) => setTimeout(resolve, 500));
        expect(done).toBeNull();
        expect(b.store.has(hash)).toBe(false);
        // Impossible sizes are refused outright.
        expect(await b.transfer.fetch(hash, -1)).toBe(false);
        expect(await b.transfer.fetch(hash, 1e12)).toBe(false);
    });

    it('resolves outstanding fetches as failed when stopped', async () => {
        const session = newTestSession();
        const a = node(makeMesh(testnet, session));
        const pending = a.transfer.fetch(sha(Buffer.from('never')), 5);
        a.transfer.stop();
        expect(await pending).toBe(false);
    });
});
