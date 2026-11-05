import { EventEmitter } from 'events';
import type { PeerMesh } from './peerMesh';

/**
 * Estimates this peer's offset to the session clock: session time equals the
 * local host clock plus the offset. One peer, the reference, defines session
 * time; every other peer pings a directly connected peer that is already in
 * sync (the reference itself when reachable) and keeps the lowest-latency of
 * its recent samples, NTP style. Peers that cannot reach the reference still
 * sync through a neighbour.
 *
 * Precision needs to be good enough that every peer agrees which bar it is
 * in, well under a bar; it does not need to be sample accurate, since each
 * peer only hears its own machine.
 */

export type ClockMesh = Pick<
    PeerMesh,
    'localId' | 'peers' | 'isConnected' | 'sendDirect' | 'publish' | 'on' | 'off'
>;

export interface ClockSyncOptions {
    mesh: ClockMesh;
    /** The local host clock in microseconds (monotonic). */
    now: () => number;
    /** Ping interval while gathering the first samples. */
    fastIntervalMs?: number;
    /** Ping interval once in sync. */
    slowIntervalMs?: number;
    /** How often this peer announces it is present. */
    heartbeatMs?: number;
}

const SAMPLE_WINDOW = 12;
const FAST_SAMPLES = 8;
/** Offset changes smaller than this are not worth retuning the engine. */
const OFFSET_EPSILON_MICROS = 500;

interface Sample {
    rtt: number;
    offset: number;
}

type ClockMessage =
    | { t: 'clock-ping'; id: number; t0: number }
    | { t: 'clock-pong'; id: number; t0: number; ts: number | null }
    | { t: 'clock-alive'; synced: boolean };

export interface ClockSyncEvents {
    /** The offset was set or moved noticeably; null when sync was lost. */
    offset: [offset: number | null];
    /** The set of present peers changed. */
    presence: [];
}

export class ClockSync extends EventEmitter<ClockSyncEvents> {
    private readonly options: ClockSyncOptions;
    private readonly mesh: ClockMesh;
    private reference: string | null = null;
    private offset: number | null = null;
    private samples: Sample[] = [];
    private target: string | null = null;
    private nextPingId = 1;
    private readonly pending = new Map<number, string>();
    /** Peers heard from recently, by id, with whether they were in sync. */
    private readonly seen = new Map<string, { at: number; synced: boolean }>();
    private pingTimer: NodeJS.Timeout | null = null;
    private heartbeatTimer: NodeJS.Timeout | null = null;
    private stopped = false;
    private readonly onDirect = (from: string, body: unknown) =>
        this.handleDirect(from, body as ClockMessage);
    private readonly onGossip = (origin: string, body: unknown) =>
        this.handleGossip(origin, body as ClockMessage);
    private readonly onPeerClose = (peerId: string) => {
        if (peerId === this.target) {
            this.retarget();
        }
        this.emit('presence');
    };

    constructor(options: ClockSyncOptions) {
        super();
        this.options = options;
        this.mesh = options.mesh;
        this.mesh.on('direct', this.onDirect);
        this.mesh.on('gossip', this.onGossip);
        this.mesh.on('peer-close', this.onPeerClose);
        this.heartbeatTimer = setInterval(
            () => this.heartbeat(),
            options.heartbeatMs ?? 2000,
        );
        this.schedulePing(0);
    }

    stop(): void {
        this.stopped = true;
        this.mesh.off('direct', this.onDirect);
        this.mesh.off('gossip', this.onGossip);
        this.mesh.off('peer-close', this.onPeerClose);
        if (this.pingTimer) {
            clearTimeout(this.pingTimer);
        }
        if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer);
        }
    }

    getOffset(): number | null {
        return this.offset;
    }

    isSynced(): boolean {
        return this.offset !== null;
    }

    /** Session time now, or null before sync. */
    sessionNow(): number | null {
        return this.offset === null ? null : this.options.now() + this.offset;
    }

    getReference(): string | null {
        return this.reference;
    }

    /**
     * Follow `peerId` as the reference. Becoming the reference keeps the
     * current offset, so session time carries on unbroken; a peer that was
     * never in sync starts session time from its own clock.
     */
    setReference(peerId: string | null): void {
        if (peerId === this.reference) {
            return;
        }
        this.reference = peerId;
        if (peerId === this.mesh.localId) {
            this.samples = [];
            this.target = null;
            this.setOffset(this.offset ?? 0);
            return;
        }
        this.retarget();
    }

    /**
     * Ids of peers present in the session: directly connected, or heard from
     * through gossip within the last few heartbeats. Includes this peer.
     */
    presentPeers(): Set<string> {
        const horizon = Date.now() - 3 * (this.options.heartbeatMs ?? 2000);
        const present = new Set<string>([this.mesh.localId]);
        for (const peer of this.mesh.peers()) {
            present.add(peer.id);
        }
        for (const [id, seen] of this.seen) {
            if (seen.at >= horizon) {
                present.add(id);
            }
        }
        return present;
    }

    private heartbeat(): void {
        this.mesh.publish({ synced: this.isSynced(), t: 'clock-alive' });
        // Peers whose heartbeats stopped have gone.
        const before = this.presentPeers().size;
        const horizon = Date.now() - 3 * (this.options.heartbeatMs ?? 2000);
        for (const [id, seen] of [...this.seen]) {
            if (seen.at < horizon) {
                this.seen.delete(id);
            }
        }
        if (this.presentPeers().size !== before) {
            this.emit('presence');
        }
    }

    private handleGossip(origin: string, message: ClockMessage): void {
        if (message?.t !== 'clock-alive') {
            return;
        }
        const isNew = !this.seen.has(origin);
        this.seen.set(origin, { at: Date.now(), synced: Boolean(message.synced) });
        if (isNew) {
            this.emit('presence');
        }
    }

    private handleDirect(from: string, message: ClockMessage): void {
        if (message?.t === 'clock-ping' && typeof message.t0 === 'number') {
            this.mesh.sendDirect(from, {
                id: message.id,
                t: 'clock-pong',
                t0: message.t0,
                ts: this.sessionNow(),
            } satisfies ClockMessage);
            return;
        }
        if (message?.t !== 'clock-pong' || this.pending.get(message.id) !== from) {
            return;
        }
        this.pending.delete(message.id);
        const seen = this.seen.get(from);
        if (seen) {
            seen.synced = message.ts !== null;
        }
        if (from !== this.target || this.reference === this.mesh.localId) {
            return;
        }
        if (typeof message.ts !== 'number' || !Number.isFinite(message.ts)) {
            // The target lost sync; find one that has it.
            this.retarget();
            return;
        }
        const t3 = this.options.now();
        const rtt = t3 - message.t0;
        if (rtt < 0) {
            return;
        }
        this.samples.push({ offset: message.ts - (message.t0 + t3) / 2, rtt });
        if (this.samples.length > SAMPLE_WINDOW) {
            this.samples.shift();
        }
        const best = this.samples.reduce((a, b) => (b.rtt < a.rtt ? b : a));
        this.setOffset(best.offset);
    }

    private setOffset(offset: number): void {
        if (
            this.offset !== null &&
            Math.abs(offset - this.offset) < OFFSET_EPSILON_MICROS
        ) {
            return;
        }
        this.offset = offset;
        this.emit('offset', offset);
    }

    /**
     * Choose whom to ping: the reference when directly connected, otherwise
     * a connected peer known to be in sync.
     */
    private retarget(): void {
        const reference = this.reference;
        let target: string | null = null;
        if (reference && reference !== this.mesh.localId) {
            if (this.mesh.isConnected(reference)) {
                target = reference;
            } else {
                target =
                    this.mesh
                        .peers()
                        .map((p) => p.id)
                        .find((id) => this.seen.get(id)?.synced) ?? null;
            }
        }
        if (target !== this.target) {
            this.target = target;
            this.samples = [];
        }
    }

    private schedulePing(delayMs: number): void {
        if (this.stopped) {
            return;
        }
        this.pingTimer = setTimeout(() => {
            this.pingTimer = null;
            this.ping();
            const fast = this.samples.length < FAST_SAMPLES;
            this.schedulePing(
                fast
                    ? (this.options.fastIntervalMs ?? 250)
                    : (this.options.slowIntervalMs ?? 2000),
            );
        }, delayMs);
    }

    private ping(): void {
        if (this.reference === this.mesh.localId) {
            return;
        }
        if (!this.target || !this.mesh.isConnected(this.target)) {
            this.retarget();
        }
        if (!this.target) {
            return;
        }
        const id = this.nextPingId++;
        this.pending.set(id, this.target);
        if (this.pending.size > 64) {
            const oldest = this.pending.keys().next().value;
            if (oldest !== undefined) {
                this.pending.delete(oldest);
            }
        }
        this.mesh.sendDirect(this.target, {
            id,
            t: 'clock-ping',
            t0: this.options.now(),
        } satisfies ClockMessage);
    }
}
