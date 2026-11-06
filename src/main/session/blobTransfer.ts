import * as fs from 'fs';
import { Channel, type ChannelId } from './frames';
import { MAX_SHARED_BLOB_BYTES } from '../../shared/sessionWorkspace';
import { type BlobStore, type IncomingBlob, isBlobHash } from './blobStore';
import type { PeerMesh } from './peerMesh';

/**
 * Moves asset files between directly connected peers. A peer that wants a
 * blob asks its peers in turn; one that has it streams it back in chunks,
 * paced by the connection, and the receiver checks the hash before keeping
 * it. Every peer mirrors every shared asset, so a blob a peer cannot reach
 * directly arrives once a neighbour has fetched it.
 */

const CHUNK_BYTES = 256 * 1024;
/** Hash (32 bytes), offset (8), total size (8). */
const CHUNK_HEADER_BYTES = 48;
/** A source that sends nothing for this long is abandoned for another. */
const STALL_MS = 15_000;
/** How long to wait before asking everyone again after nobody had a blob. */
const RETRY_MS = 3_000;

type TransferMessage =
    | { t: 'blob-want'; hash: string }
    | { t: 'blob-none'; hash: string };

export type TransferMesh = Pick<
    PeerMesh,
    'peers' | 'isConnected' | 'sendDirect' | 'sendPaced' | 'on' | 'off'
>;

export interface TransferProgress {
    /** Blobs wanted and not yet received. */
    pending: number;
    /** Bytes received of the blobs currently arriving. */
    receivedBytes: number;
    /** Total size of the blobs currently arriving, as far as known. */
    totalBytes: number;
}

interface Want {
    hash: string;
    /** The size the session document gives the blob; chunks must agree. */
    size: number;
    /** Peers already asked in the current round. */
    asked: Set<string>;
    source: string | null;
    incoming: IncomingBlob | null;
    total: number;
    stallTimer: NodeJS.Timeout | null;
    retryTimer: NodeJS.Timeout | null;
    waiters: Array<(ok: boolean) => void>;
}

export class BlobTransfer {
    private readonly mesh: TransferMesh;
    private readonly store: BlobStore;
    private readonly onProgress: (progress: TransferProgress) => void;
    private readonly wants = new Map<string, Want>();
    /** Uploads in flight, so one peer is served one blob at a time. */
    private readonly serving = new Map<string, Promise<void>>();
    private stopped = false;
    private readonly onDirect = (from: string, body: unknown) =>
        this.handleMessage(from, body as TransferMessage);
    private readonly onData = (from: string, channel: ChannelId, payload: Buffer) => {
        if (channel === Channel.Blob) {
            this.handleChunk(from, payload);
        }
    };
    private readonly onPeerOpen = () => this.resumeWaiting();
    private readonly onPeerClose = (peerId: string) => this.dropSource(peerId);

    constructor(
        mesh: TransferMesh,
        store: BlobStore,
        onProgress: (progress: TransferProgress) => void = () => {},
    ) {
        this.mesh = mesh;
        this.store = store;
        this.onProgress = onProgress;
        mesh.on('direct', this.onDirect);
        mesh.on('data', this.onData);
        mesh.on('peer-open', this.onPeerOpen);
        mesh.on('peer-close', this.onPeerClose);
    }

    stop(): void {
        this.stopped = true;
        this.mesh.off('direct', this.onDirect);
        this.mesh.off('data', this.onData);
        this.mesh.off('peer-open', this.onPeerOpen);
        this.mesh.off('peer-close', this.onPeerClose);
        for (const want of this.wants.values()) {
            this.clearTimers(want);
            want.incoming?.abort();
            for (const waiter of want.waiters) {
                waiter(false);
            }
        }
        this.wants.clear();
    }

    /**
     * Resolve once the blob is in the store; false if stopped first or the
     * size is impossible. `size` is the size the session document records.
     */
    fetch(hash: string, size: number): Promise<boolean> {
        if (this.store.has(hash)) {
            return Promise.resolve(true);
        }
        if (
            this.stopped ||
            !isBlobHash(hash) ||
            !Number.isInteger(size) ||
            size < 0 ||
            size > MAX_SHARED_BLOB_BYTES
        ) {
            return Promise.resolve(false);
        }
        return new Promise((resolve) => {
            const existing = this.wants.get(hash);
            if (existing) {
                existing.waiters.push(resolve);
                return;
            }
            const want: Want = {
                asked: new Set(),
                hash,
                incoming: null,
                retryTimer: null,
                size,
                source: null,
                stallTimer: null,
                total: 0,
                waiters: [resolve],
            };
            this.wants.set(hash, want);
            this.askNext(want);
            this.reportProgress();
        });
    }

    progress(): TransferProgress {
        let receivedBytes = 0;
        let totalBytes = 0;
        for (const want of this.wants.values()) {
            receivedBytes += want.incoming?.bytesWritten ?? 0;
            totalBytes += want.total;
        }
        return { pending: this.wants.size, receivedBytes, totalBytes };
    }

    private askNext(want: Want): void {
        if (this.stopped || want.source) {
            return;
        }
        const candidate = this.mesh
            .peers()
            .map((p) => p.id)
            .find((id) => !want.asked.has(id));
        if (!candidate) {
            // Nobody connected has it yet; ask everyone again shortly.
            want.asked.clear();
            want.retryTimer ??= setTimeout(() => {
                want.retryTimer = null;
                this.askNext(want);
            }, RETRY_MS);
            return;
        }
        want.asked.add(candidate);
        want.source = candidate;
        this.armStall(want);
        this.mesh.sendDirect(candidate, { hash: want.hash, t: 'blob-want' });
    }

    private armStall(want: Want): void {
        if (want.stallTimer) {
            clearTimeout(want.stallTimer);
        }
        want.stallTimer = setTimeout(() => {
            want.stallTimer = null;
            this.abandonSource(want);
        }, STALL_MS);
    }

    private abandonSource(want: Want): void {
        if (want.stallTimer) {
            clearTimeout(want.stallTimer);
            want.stallTimer = null;
        }
        want.incoming?.abort();
        want.incoming = null;
        want.total = 0;
        want.source = null;
        this.askNext(want);
    }

    private dropSource(peerId: string): void {
        for (const want of this.wants.values()) {
            if (want.source === peerId) {
                this.abandonSource(want);
            }
        }
    }

    private resumeWaiting(): void {
        for (const want of this.wants.values()) {
            if (!want.source) {
                if (want.retryTimer) {
                    clearTimeout(want.retryTimer);
                    want.retryTimer = null;
                }
                this.askNext(want);
            }
        }
    }

    private handleMessage(from: string, message: TransferMessage): void {
        if (!message || !isBlobHash(message.hash)) {
            return;
        }
        if (message.t === 'blob-want') {
            this.serve(from, message.hash);
        } else if (message.t === 'blob-none') {
            const want = this.wants.get(message.hash);
            if (want && want.source === from && !want.incoming) {
                if (want.stallTimer) {
                    clearTimeout(want.stallTimer);
                    want.stallTimer = null;
                }
                want.source = null;
                this.askNext(want);
            }
        }
    }

    private serve(peerId: string, hash: string): void {
        if (!this.store.has(hash)) {
            this.mesh.sendDirect(peerId, { hash, t: 'blob-none' });
            return;
        }
        const previous = this.serving.get(peerId) ?? Promise.resolve();
        const next = previous
            .then(() => this.upload(peerId, hash))
            .catch((error) => {
                console.warn('[session] asset upload failed', error);
                // Let the requester move on to another peer at once.
                this.mesh.sendDirect(peerId, { hash, t: 'blob-none' });
            });
        this.serving.set(peerId, next);
        void next.finally(() => {
            if (this.serving.get(peerId) === next) {
                this.serving.delete(peerId);
            }
        });
    }

    private async upload(peerId: string, hash: string): Promise<void> {
        const readable = this.store.readablePath(hash);
        if (!readable) {
            this.mesh.sendDirect(peerId, { hash, t: 'blob-none' });
            return;
        }
        const handle = await fs.promises.open(readable, 'r');
        try {
            const { size } = await handle.stat();
            const hashBytes = Buffer.from(hash, 'hex');
            let offset = 0;
            do {
                if (this.stopped || !this.mesh.isConnected(peerId)) {
                    return;
                }
                const length = Math.min(CHUNK_BYTES, size - offset);
                const frame = Buffer.allocUnsafe(CHUNK_HEADER_BYTES + length);
                hashBytes.copy(frame, 0);
                frame.writeBigUInt64BE(BigInt(offset), 32);
                frame.writeBigUInt64BE(BigInt(size), 40);
                const { bytesRead } = await handle.read(
                    frame,
                    CHUNK_HEADER_BYTES,
                    length,
                    offset,
                );
                if (bytesRead !== length) {
                    throw new Error('The asset changed while it was being sent');
                }
                if (!(await this.mesh.sendPaced(peerId, Channel.Blob, frame))) {
                    return;
                }
                offset += length;
            } while (offset < size);
        } finally {
            await handle.close();
        }
    }

    private handleChunk(from: string, payload: Buffer): void {
        if (payload.byteLength < CHUNK_HEADER_BYTES) {
            return;
        }
        const hash = payload.subarray(0, 32).toString('hex');
        const want = this.wants.get(hash);
        if (!want || want.source !== from) {
            return;
        }
        const offset = Number(payload.readBigUInt64BE(32));
        const total = Number(payload.readBigUInt64BE(40));
        const data = payload.subarray(CHUNK_HEADER_BYTES);
        if (total !== want.size || offset + data.byteLength > total) {
            // Not the blob the session describes.
            this.abandonSource(want);
            return;
        }
        try {
            if (!want.incoming) {
                if (offset !== 0) {
                    return;
                }
                want.incoming = this.store.createIncoming(hash);
                want.total = total;
            }
            want.incoming.write(offset, data);
        } catch (error) {
            console.warn('[session] bad asset chunk', error);
            this.abandonSource(want);
            return;
        }
        this.armStall(want);
        this.reportProgress();
        if (want.incoming.bytesWritten < want.total) {
            return;
        }
        const ok = want.incoming.finish();
        want.incoming = null;
        if (!ok) {
            // Corrupt or lying source: try someone else.
            this.abandonSource(want);
            return;
        }
        this.clearTimers(want);
        this.wants.delete(hash);
        for (const waiter of want.waiters) {
            waiter(true);
        }
        this.reportProgress();
    }

    private clearTimers(want: Want): void {
        if (want.stallTimer) {
            clearTimeout(want.stallTimer);
        }
        if (want.retryTimer) {
            clearTimeout(want.retryTimer);
        }
        want.stallTimer = null;
        want.retryTimer = null;
    }

    private reportProgress(): void {
        this.onProgress(this.progress());
    }
}
