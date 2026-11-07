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

    constructor(
        private readonly displayName: () => string,
        private readonly events: LiveShareEvents,
    ) {}

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
        this.leave();
        const name = this.displayName();
        this.host = await HostSession.open(name, {
            peersChanged: () => this.report(),
        });
        this.stopAdvertising = advertiseSession(
            this.host.sessionId,
            name,
            this.host.port,
        );
        this.report();
        return this.status();
    }

    async joinSession(request: JoinSessionRequest): Promise<LiveShareStatus> {
        this.leave();
        this.joining = request.address;
        this.report();
        try {
            const guest = await GuestSession.join(request, this.displayName(), {
                closed: (reason) => {
                    if (this.guest === guest) {
                        this.guest = null;
                        this.events.ended(reason);
                        this.report();
                    }
                },
                statusChanged: () => this.report(),
            });
            this.guest = guest;
        } finally {
            this.joining = null;
            this.report();
        }
        return this.status();
    }

    leave(): void {
        this.stopAdvertising?.();
        this.stopAdvertising = null;
        this.host?.close();
        this.host = null;
        const guest = this.guest;
        this.guest = null;
        guest?.leave();
        this.report();
    }

    browse(onChange: (sessions: DiscoveredSession[]) => void): () => void {
        return browseSessions(onChange);
    }

    private report(): void {
        this.events.status(this.status());
    }
}
