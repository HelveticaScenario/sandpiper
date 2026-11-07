/**
 * The guest side of a live share session: the connection to the host and
 * the list of who is in the session.
 */
import { connect } from 'net';
import type { SessionPeer } from '../../shared/liveShare';
import type { GuestMessage, HostMessage } from './protocol';
import { joinHost, type MessageChannel } from './secureChannel';

const CONNECT_TIMEOUT_MS = 10_000;

type HostChannel = MessageChannel<HostMessage, GuestMessage>;

export interface GuestSessionEvents {
    /** The peer list changed. */
    statusChanged(): void;
    /** The session ended or the connection dropped. */
    closed(reason: string): void;
}

export class GuestSession {
    private peerList: SessionPeer[];
    private closed = false;

    private constructor(
        private readonly channel: HostChannel,
        readonly hostName: string,
        readonly selfId: string,
        welcome: Extract<HostMessage, { t: 'welcome' }>,
        private readonly events: GuestSessionEvents,
    ) {
        this.peerList = welcome.peers;
        channel.onMessage((message) => this.receive(message));
        channel.onClose((reason) => this.finish(reason));
    }

    /** Connect to a host and complete the pairing handshake. */
    static async join(
        target: { address: string; port: number; pairingCode: string },
        name: string,
        events: GuestSessionEvents,
    ): Promise<GuestSession> {
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
        }
    }

    private finish(reason: string): void {
        if (this.closed) {
            return;
        }
        this.closed = true;
        this.events.closed(reason);
    }
}
