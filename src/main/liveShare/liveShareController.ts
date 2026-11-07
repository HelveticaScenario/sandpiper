/**
 * The app's single live share session, if any: hosting or joining one,
 * routing this peer's runs and stops through it, and reporting its state to
 * the renderer.
 */
import type { QueuedTrigger } from '@modular/core';
import type { DSLExecuteResult } from '../../shared/ipcTypes';
import type {
    DiscoveredSession,
    JoinSessionRequest,
    LiveShareStatus,
    SessionPeer,
} from '../../shared/liveShare';
import { advertiseSession, browseSessions } from './discovery';
import { GuestSession } from './guestSession';
import { HostSession } from './hostSession';
import type { SessionEngine, SharedPatch } from './sessionEngine';

export interface LiveShareEvents {
    status(status: LiveShareStatus): void;
    /** A patch another peer ran applied on this engine. */
    remotePatch(
        patch: SharedPatch,
        result: DSLExecuteResult,
        author: SessionPeer | null,
    ): void;
    remoteStop(by: SessionPeer): void;
    /** The session ended without this peer leaving it. */
    ended(reason: string): void;
}

export class LiveShareController {
    private host: HostSession | null = null;
    private guest: GuestSession | null = null;
    private joining: string | null = null;
    private stopAdvertising: (() => void) | null = null;
    /**
     * Whether Link was on before this peer entered a session, so leaving
     * the session puts it back; null outside a session.
     */
    private linkBefore: boolean | null = null;

    constructor(
        private readonly engine: SessionEngine,
        private readonly displayName: () => string,
        private readonly events: LiveShareEvents,
    ) {}

    /** Whether this peer is in a session, so runs and stops go through it. */
    get active(): boolean {
        return this.host !== null || this.guest !== null;
    }

    status(): LiveShareStatus {
        if (this.host) {
            return {
                addresses: this.host.addresses,
                pairingCode: this.host.pairingCode,
                peers: this.host.peers(),
                port: this.host.port,
                role: 'host',
                selfId: this.host.selfId,
            };
        }
        if (this.guest) {
            return {
                clockSynced: this.guest.clockSynced,
                hostName: this.guest.hostName,
                peers: this.guest.peers,
                role: 'guest',
                selfId: this.guest.selfId,
            };
        }
        if (this.joining !== null) {
            return { hostName: this.joining, role: 'joining' };
        }
        return { role: 'idle' };
    }

    async hostSession(): Promise<LiveShareStatus> {
        this.endSession(false);
        this.rememberLink();
        const name = this.displayName();
        try {
            this.host = await HostSession.open(this.engine, name, {
                peersChanged: () => this.report(),
                remotePatch: (patch, result) =>
                    this.events.remotePatch(patch, result, this.author(patch)),
                remoteStop: (by) => this.events.remoteStop(by),
            });
        } catch (err) {
            this.restoreLink();
            throw err;
        }
        this.stopAdvertising = advertiseSession(
            this.host.sessionId,
            name,
            this.host.port,
        );
        this.report();
        return this.status();
    }

    async joinSession(request: JoinSessionRequest): Promise<LiveShareStatus> {
        this.endSession(false);
        this.rememberLink();
        this.joining = request.address;
        this.report();
        try {
            const guest = await GuestSession.join(
                this.engine,
                request,
                this.displayName(),
                {
                    closed: (reason) => {
                        if (this.guest === guest) {
                            this.guest = null;
                            this.restoreLink();
                            this.events.ended(reason);
                            this.report();
                        }
                    },
                    remotePatch: (patch, result) =>
                        this.events.remotePatch(
                            patch,
                            result,
                            this.author(patch),
                        ),
                    remoteStop: (by) => this.events.remoteStop(by),
                    statusChanged: () => this.report(),
                },
            );
            this.guest = guest;
        } catch (err) {
            this.restoreLink();
            throw err;
        } finally {
            this.joining = null;
            this.report();
        }
        return this.status();
    }

    leave(): void {
        this.endSession(true);
    }

    private endSession(restoreLink: boolean): void {
        this.stopAdvertising?.();
        this.stopAdvertising = null;
        this.host?.close();
        this.host = null;
        const guest = this.guest;
        this.guest = null;
        guest?.leave();
        if (restoreLink) {
            this.restoreLink();
        }
        this.report();
    }

    private rememberLink(): void {
        this.linkBefore ??= this.engine.transport().linkEnabled;
    }

    /** Turn Link back off if the session turned it on. */
    private restoreLink(): void {
        if (this.linkBefore === false) {
            this.engine.setLinkEnabled(false);
        }
        this.linkBefore = null;
    }

    run(
        source: string,
        sourceId: string | null,
        trigger: QueuedTrigger | null,
    ): DSLExecuteResult | Promise<DSLExecuteResult> {
        if (this.host) {
            return this.host.run(source, sourceId, trigger);
        }
        if (this.guest) {
            return this.guest.run(source, sourceId, trigger);
        }
        throw new Error('Not in a live share session');
    }

    stop(): void {
        if (this.host) {
            this.host.stop();
        } else if (this.guest) {
            this.guest.stop();
        }
    }

    browse(onChange: (sessions: DiscoveredSession[]) => void): () => void {
        return browseSessions(onChange);
    }

    private author(patch: SharedPatch): SessionPeer | null {
        const peers = this.host?.peers() ?? this.guest?.peers ?? [];
        return peers.find((p) => p.id === patch.authorId) ?? null;
    }

    private report(): void {
        this.events.status(this.status());
    }
}
