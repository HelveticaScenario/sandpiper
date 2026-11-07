/**
 * The host side of a live share session: a TCP server guests join with the
 * pairing code, the list of who is in the session, and the session clock
 * heartbeat.
 */
import { createServer, type AddressInfo, type Server, type Socket } from 'net';
import { networkInterfaces } from 'os';
import { randomUUID } from 'crypto';
import type { SessionPeer } from '../../shared/liveShare';
import { generatePairingCode } from './pairingCode';
import type { GuestMessage, HostMessage } from './protocol';
import { acceptGuest, type MessageChannel } from './secureChannel';
import { HostClock } from './sessionClock';
import { startLink, type SessionEngine } from './sessionEngine';
import { peerColor } from './peerColors';

/** How often the host broadcasts its session position. */
export const CLOCK_HEARTBEAT_MS = 250;

/** Failed pairing attempts one address may make per window. */
const MAX_FAILED_ATTEMPTS = 5;
const FAILED_ATTEMPT_WINDOW_MS = 60_000;

type GuestChannel = MessageChannel<GuestMessage, HostMessage>;

interface Guest {
    peer: SessionPeer;
    channel: GuestChannel;
}

export interface HostSessionEvents {
    /** The peer list changed. */
    peersChanged(): void;
}

export class HostSession {
    readonly selfId = 'host';
    /** Identifies this session in discovery. */
    readonly sessionId = randomUUID();
    readonly pairingCode = generatePairingCode();
    private readonly server: Server;
    private readonly guests = new Map<string, Guest>();
    private readonly failedAttempts = new Map<string, number[]>();
    private readonly clock: HostClock;
    private heartbeat: NodeJS.Timeout | null = null;
    private nextColor = 1;

    private constructor(
        private readonly engine: SessionEngine,
        private readonly hostName: string,
        private readonly events: HostSessionEvents,
    ) {
        this.clock = new HostClock(engine.transport().linkBars, Date.now());
        this.server = createServer((socket) => void this.admit(socket));
    }

    /** Open a session on an OS-chosen port, on every interface. */
    static async open(
        engine: SessionEngine,
        hostName: string,
        events: HostSessionEvents,
    ): Promise<HostSession> {
        await startLink(engine);
        const session = new HostSession(engine, hostName, events);
        await new Promise<void>((resolve, reject) => {
            session.server.once('error', reject);
            session.server.listen(0, () => resolve());
        });
        session.heartbeat = setInterval(
            () => session.tick(),
            CLOCK_HEARTBEAT_MS,
        );
        return session;
    }

    get port(): number {
        return (this.server.address() as AddressInfo).port;
    }

    /** This machine's IPv4 addresses on the local network. */
    get addresses(): string[] {
        return Object.values(networkInterfaces())
            .flat()
            .filter(
                (iface) =>
                    iface !== undefined &&
                    iface.family === 'IPv4' &&
                    !iface.internal,
            )
            .map((iface) => iface!.address);
    }

    peers(): SessionPeer[] {
        return [
            {
                color: peerColor(0),
                id: this.selfId,
                isHost: true,
                name: this.hostName,
            },
            ...[...this.guests.values()].map((g) => g.peer),
        ];
    }

    close(): void {
        if (this.heartbeat) {
            clearInterval(this.heartbeat);
        }
        for (const guest of this.guests.values()) {
            guest.channel.close('The host ended the session');
        }
        this.guests.clear();
        this.server.close();
    }

    private sessionBars(): number {
        return this.engine.transport().linkBars + this.clock.offset;
    }

    private tick(): void {
        const { linkBars, bpm } = this.engine.transport();
        this.clock.sample(linkBars, bpm, Date.now());
        this.broadcast({ sessionBars: this.sessionBars(), t: 'clock' });
    }

    private async admit(socket: Socket): Promise<void> {
        const address = socket.remoteAddress ?? 'unknown';
        if (this.recentFailures(address) >= MAX_FAILED_ATTEMPTS) {
            socket.destroy();
            return;
        }
        let accepted;
        try {
            accepted = await acceptGuest<GuestMessage, HostMessage>(
                socket,
                this.pairingCode,
                this.hostName,
            );
        } catch {
            this.failedAttempts.set(address, [
                ...(this.failedAttempts.get(address) ?? []),
                Date.now(),
            ]);
            return;
        }
        const id = randomUUID();
        const guest: Guest = {
            channel: accepted.channel,
            peer: {
                color: peerColor(this.nextColor++),
                id,
                isHost: false,
                name: accepted.guest.name,
            },
        };
        this.guests.set(id, guest);
        guest.channel.onClose(() => {
            if (this.guests.delete(id)) {
                this.announcePeers();
            }
        });
        guest.channel.send({
            peers: this.peers(),
            selfId: id,
            t: 'welcome',
        });
        this.announcePeers();
    }

    private recentFailures(address: string): number {
        const since = Date.now() - FAILED_ATTEMPT_WINDOW_MS;
        const recent = (this.failedAttempts.get(address) ?? []).filter(
            (at) => at > since,
        );
        this.failedAttempts.set(address, recent);
        return recent.length;
    }

    private announcePeers(): void {
        this.broadcast({ peers: this.peers(), t: 'peers' });
        this.events.peersChanged();
    }

    private broadcast(message: HostMessage): void {
        for (const guest of this.guests.values()) {
            guest.channel.send(message);
        }
    }
}
