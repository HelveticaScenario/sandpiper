/**
 * The host side of a live share session: a TCP server guests join with the
 * pairing code, and the list of who is in the session.
 */
import { createServer, type AddressInfo, type Server, type Socket } from 'net';
import { networkInterfaces } from 'os';
import { randomUUID } from 'crypto';
import type { SessionPeer } from '../../shared/liveShare';
import { generatePairingCode } from './pairingCode';
import type { GuestMessage, HostMessage } from './protocol';
import { acceptGuest, type MessageChannel } from './secureChannel';
import { peerColor } from './peerColors';

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
    private nextColor = 1;

    private constructor(
        private readonly hostName: string,
        private readonly events: HostSessionEvents,
    ) {
        this.server = createServer((socket) => void this.admit(socket));
    }

    /** Open a session on an OS-chosen port, on every interface. */
    static async open(
        hostName: string,
        events: HostSessionEvents,
    ): Promise<HostSession> {
        const session = new HostSession(hostName, events);
        await new Promise<void>((resolve, reject) => {
            session.server.once('error', reject);
            session.server.listen(0, () => resolve());
        });
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
        for (const guest of this.guests.values()) {
            guest.channel.close('The host ended the session');
        }
        this.guests.clear();
        this.server.close();
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
