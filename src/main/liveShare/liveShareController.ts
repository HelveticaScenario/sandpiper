/**
 * The app's single live share session, if any: hosting or joining one and
 * reporting its state to the renderer.
 */
import type {
    DiscoveredSession,
    JoinSessionRequest,
    LiveShareStatus,
} from '../../shared/liveShare';
import { advertiseSession, browseSessions } from './discovery';
import { GuestSession } from './guestSession';
import { HostSession } from './hostSession';
import type { SessionEngine } from './sessionEngine';

export interface LiveShareEvents {
    status(status: LiveShareStatus): void;
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

    /** Whether this peer is in a session. */
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

    browse(onChange: (sessions: DiscoveredSession[]) => void): () => void {
        return browseSessions(onChange);
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

    private report(): void {
        this.events.status(this.status());
    }
}
