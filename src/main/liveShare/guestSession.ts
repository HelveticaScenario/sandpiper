/**
 * The guest side of a live share session: the connection to the host, this
 * peer's view of the session clock, and following the host's playback.
 *
 * A guest plays only once its bar numbers agree with the host's. Until then
 * it records what the session is playing and catches up the moment its
 * clock comes into sync.
 */
import { connect } from 'net';
import { randomUUID } from 'crypto';
import type { QueuedTrigger } from '@modular/core';
import type { DSLExecuteResult } from '../../shared/ipcTypes';
import type { SessionPeer } from '../../shared/liveShare';
import type { GuestMessage, HostMessage, PlaybackState } from './protocol';
import { joinHost, type MessageChannel } from './secureChannel';
import { GuestClock } from './sessionClock';
import {
    startLink,
    type SessionEngine,
    type SharedPatch,
} from './sessionEngine';
import { applySharedPatch, joinPlayback } from './sessionPlayback';

/** How long a run waits for the host's patch before failing. */
const RUN_TIMEOUT_MS = 10_000;
const CONNECT_TIMEOUT_MS = 10_000;

type HostChannel = MessageChannel<HostMessage, GuestMessage>;

export interface GuestSessionEvents {
    /** The peer list or the clock's sync state changed. */
    statusChanged(): void;
    /** A patch authored by another peer applied on this engine. */
    remotePatch(patch: SharedPatch, result: DSLExecuteResult): void;
    /** Another peer stopped playback. */
    remoteStop(by: SessionPeer): void;
    /** The session ended or the connection dropped. */
    closed(reason: string): void;
}

interface PendingRun {
    resolve(result: DSLExecuteResult): void;
    timer: NodeJS.Timeout;
}

export class GuestSession {
    private readonly clock = new GuestClock();
    private readonly pendingRuns = new Map<string, PendingRun>();
    private peerList: SessionPeer[];
    private playback: PlaybackState;
    private closed = false;

    private constructor(
        private readonly engine: SessionEngine,
        private readonly channel: HostChannel,
        readonly hostName: string,
        readonly selfId: string,
        welcome: Extract<HostMessage, { t: 'welcome' }>,
        private readonly events: GuestSessionEvents,
    ) {
        this.peerList = welcome.peers;
        this.playback = welcome.playback;
        channel.onMessage((message) => this.receive(message));
        channel.onClose((reason) => this.finish(reason));
    }

    /** Connect to a host and complete the pairing handshake. */
    static async join(
        engine: SessionEngine,
        target: { address: string; port: number; pairingCode: string },
        name: string,
        events: GuestSessionEvents,
    ): Promise<GuestSession> {
        await startLink(engine);
        const socket = connect({ host: target.address, port: target.port });
        socket.setTimeout(CONNECT_TIMEOUT_MS, () =>
            socket.destroy(new Error('Could not reach the host')),
        );
        await new Promise<void>((resolve, reject) => {
            socket.once('connect', resolve);
            socket.once('error', reject);
        });
        socket.setTimeout(0);
        const { channel, hostName } = await joinHost<HostMessage, GuestMessage>(
            socket,
            target.pairingCode,
            name,
        );
        const welcome = await new Promise<
            Extract<HostMessage, { t: 'welcome' }>
        >((resolve, reject) => {
            channel.onMessage((message) => {
                if (message.t === 'welcome') {
                    resolve(message);
                }
            });
            channel.onClose((reason) => reject(new Error(reason)));
        });
        return new GuestSession(
            engine,
            channel,
            hostName,
            welcome.selfId,
            welcome,
            events,
        );
    }

    get peers(): SessionPeer[] {
        return this.peerList;
    }

    get clockSynced(): boolean {
        return this.clock.synced;
    }

    /** Ask the host to build and play `source` for everyone. */
    run(
        source: string,
        sourceId: string | null,
        trigger: QueuedTrigger | null,
    ): Promise<DSLExecuteResult> {
        const requestId = randomUUID();
        return new Promise((resolve) => {
            const timer = setTimeout(() => {
                this.pendingRuns.delete(requestId);
                resolve({
                    errorMessage: 'The host did not answer in time',
                    success: false,
                });
            }, RUN_TIMEOUT_MS);
            this.pendingRuns.set(requestId, { resolve, timer });
            this.channel.send({
                requestId,
                source,
                sourceId,
                t: 'run',
                trigger,
            });
        });
    }

    /** Stop playback for everyone; this engine stops at once. */
    stop(): void {
        this.engine.stop();
        this.channel.send({ t: 'stop' });
    }

    leave(): void {
        this.channel.close('Left the session');
    }

    private receive(message: HostMessage): void {
        switch (message.t) {
            case 'welcome':
                return;
            case 'peers':
                this.peerList = message.peers;
                this.events.statusChanged();
                return;
            case 'clock':
                this.onClock(message.sessionBars);
                return;
            case 'patch':
                this.onPatch(message.patch);
                return;
            case 'stop':
                this.playback = {
                    ...this.playback,
                    patch: null,
                    playing: false,
                };
                this.engine.stop();
                {
                    const by = this.peerList.find((p) => p.id === message.by);
                    if (by && by.id !== this.selfId) {
                        this.events.remoteStop(by);
                    }
                }
                return;
            case 'runFailed': {
                const pending = this.takePending(message.requestId);
                pending?.resolve({ ...message.failure, success: false });
                return;
            }
        }
    }

    private onClock(sessionBars: number): void {
        const { linkBars, linkPeers } = this.engine.transport();
        const wasSynced = this.clock.synced;
        if (!this.clock.heartbeat(sessionBars, linkBars, linkPeers)) {
            return;
        }
        this.engine.setSessionTimeline(this.clock.offset);
        if (!wasSynced && this.clock.synced) {
            joinPlayback(this.engine, this.playback);
        }
        this.events.statusChanged();
    }

    private onPatch(patch: SharedPatch): void {
        this.playback = {
            patch,
            playing: true,
            songOrigin:
                patch.startBar ??
                (patch.resetClock && patch.atBar !== null
                    ? patch.atBar
                    : this.playback.songOrigin),
        };
        const pending =
            patch.requestId !== null && patch.authorId === this.selfId
                ? this.takePending(patch.requestId)
                : undefined;
        if (!this.clock.synced) {
            // Plays once the clock syncs; the author's editor still learns
            // what the patch contains.
            pending?.resolve({
                ...patch.meta,
                appliedPatch: patch.patch,
                success: true,
            });
            return;
        }
        const result = applySharedPatch(this.engine, patch);
        if (pending) {
            pending.resolve(result);
        } else {
            this.events.remotePatch(patch, result);
        }
    }

    private takePending(requestId: string): PendingRun | undefined {
        const pending = this.pendingRuns.get(requestId);
        if (pending) {
            clearTimeout(pending.timer);
            this.pendingRuns.delete(requestId);
        }
        return pending;
    }

    private finish(reason: string): void {
        if (this.closed) {
            return;
        }
        this.closed = true;
        for (const [id, pending] of this.pendingRuns) {
            clearTimeout(pending.timer);
            pending.resolve({ errorMessage: reason, success: false });
            this.pendingRuns.delete(id);
        }
        this.clock.reset();
        this.engine.setSessionTimeline(null);
        this.events.closed(reason);
    }
}
