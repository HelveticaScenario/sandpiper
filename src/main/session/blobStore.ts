import { createHash, randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

const HASH_PATTERN = /^[0-9a-f]{64}$/;

export function isBlobHash(value: unknown): value is string {
    return typeof value === 'string' && HASH_PATTERN.test(value);
}

/** SHA-256 of a file's contents, streamed so large files stay out of memory. */
export async function hashFile(filePath: string): Promise<string> {
    const hash = createHash('sha256');
    await new Promise<void>((resolve, reject) => {
        fs.createReadStream(filePath)
            .on('data', (chunk) => hash.update(chunk))
            .on('end', () => resolve())
            .on('error', reject);
    });
    return hash.digest('hex');
}

/**
 * Asset files by content hash. Blobs received from peers are kept in the
 * store directory, which outlives sessions, so a sample is transferred once.
 * Files already on this machine are registered in place, uncopied; one
 * that changes afterwards stops being served under its old hash.
 */
interface LocalFile {
    path: string;
    size: number;
    mtimeMs: number;
}

export class BlobStore {
    readonly dir: string;
    private readonly local = new Map<string, LocalFile>();

    constructor(dir: string) {
        this.dir = dir;
        fs.mkdirSync(dir, { recursive: true });
    }

    pathOf(hash: string): string {
        if (!isBlobHash(hash)) {
            throw new Error(`Not a blob hash: ${String(hash)}`);
        }
        return path.join(this.dir, hash);
    }

    /** Where the blob's content can be read, or null if it is not here. */
    readablePath(hash: string): string | null {
        if (!isBlobHash(hash)) {
            return null;
        }
        const stored = this.pathOf(hash);
        if (fs.existsSync(stored)) {
            return stored;
        }
        const local = this.local.get(hash);
        if (!local) {
            return null;
        }
        // A registered file that changed since it was hashed no longer
        // holds this blob.
        try {
            const stat = fs.statSync(local.path);
            if (stat.size === local.size && stat.mtimeMs === local.mtimeMs) {
                return local.path;
            }
        } catch {
            // Gone.
        }
        this.local.delete(hash);
        return null;
    }

    has(hash: string): boolean {
        return this.readablePath(hash) !== null;
    }

    size(hash: string): number | null {
        const readable = this.readablePath(hash);
        try {
            return readable ? fs.statSync(readable).size : null;
        } catch {
            return null;
        }
    }

    /** Hash a file on this machine and remember where it is. */
    async register(filePath: string): Promise<string> {
        const before = await fs.promises.stat(filePath);
        const hash = await hashFile(filePath);
        const after = await fs.promises.stat(filePath);
        if (before.size === after.size && before.mtimeMs === after.mtimeMs) {
            this.local.set(hash, {
                mtimeMs: after.mtimeMs,
                path: filePath,
                size: after.size,
            });
        }
        return hash;
    }

    /** Copy a file into the store and return its hash. */
    async addFile(filePath: string): Promise<string> {
        const hash = await hashFile(filePath);
        if (!fs.existsSync(this.pathOf(hash))) {
            const temp = this.tempPath();
            await fs.promises.copyFile(filePath, temp);
            await fs.promises.rename(temp, this.pathOf(hash));
        }
        return hash;
    }

    /**
     * Put the blob at `target`, replacing what is there. The copy lands
     * under a hidden name beside the target first, so watchers never see a
     * partial file and the final rename stays on one volume.
     */
    async materialize(hash: string, target: string): Promise<void> {
        const source = this.readablePath(hash);
        if (!source) {
            throw new Error(`Blob ${hash.slice(0, 8)} is not available`);
        }
        await fs.promises.mkdir(path.dirname(target), { recursive: true });
        const temp = path.join(path.dirname(target), `.shoreline-${randomUUID()}`);
        try {
            await fs.promises.copyFile(source, temp);
            await fs.promises.rename(temp, target);
        } catch (error) {
            await fs.promises.rm(temp, { force: true });
            throw error;
        }
    }

    /** A writer for an incoming blob; it joins the store only if the content matches `hash`. */
    createIncoming(hash: string): IncomingBlob {
        return new IncomingBlob(this, hash, this.tempPath());
    }

    tempPath(): string {
        return path.join(this.dir, `.incoming-${randomUUID()}`);
    }
}

export class IncomingBlob {
    readonly hash: string;
    private readonly store: BlobStore;
    private readonly temp: string;
    private readonly digest = createHash('sha256');
    private readonly fd: number;
    private written = 0;
    private closed = false;

    constructor(store: BlobStore, hash: string, temp: string) {
        this.store = store;
        this.hash = hash;
        this.temp = temp;
        this.fd = fs.openSync(temp, 'w');
    }

    get bytesWritten(): number {
        return this.written;
    }

    /** Append the chunk that starts at `offset`; chunks must arrive in order. */
    write(offset: number, chunk: Uint8Array): void {
        if (this.closed || offset !== this.written) {
            throw new Error(`Out-of-order chunk for ${this.hash.slice(0, 8)}`);
        }
        fs.writeSync(this.fd, chunk);
        this.digest.update(chunk);
        this.written += chunk.byteLength;
    }

    /** Finish the blob: true when it matched its hash and is now stored. */
    finish(): boolean {
        this.closeFile();
        if (this.digest.digest('hex') !== this.hash) {
            fs.rmSync(this.temp, { force: true });
            return false;
        }
        fs.renameSync(this.temp, this.store.pathOf(this.hash));
        return true;
    }

    abort(): void {
        this.closeFile();
        fs.rmSync(this.temp, { force: true });
    }

    private closeFile(): void {
        if (!this.closed) {
            this.closed = true;
            fs.closeSync(this.fd);
        }
    }
}
