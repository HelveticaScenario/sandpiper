import { EventEmitter } from 'events';
import { randomUUID } from 'crypto';
import Hyperswarm, { type NoiseSecretStream } from 'hyperswarm';
import { Channel, type ChannelId, FrameDecoder, encodeFrame } from './frames';
import { authProof, verifyAuthProof } from './invite';
import type { SessionNetwork } from '../../shared/session';

/**
 * Bumped whenever the wire format changes incompatibly. Peers on different
 * protocol versions refuse each other during the handshake.
 */
export const SESSION_PROTOCOL_VERSION = 1;

/** How many relays a gossip message may cross before it is dropped. */
const MAX_GOSSIP_HOPS = 16;
const SEEN_GOSSIP_TTL_MS = 5 * 60_000;
const SEEN_GOSSIP_MAX = 10_000;
const DEFAULT_HELLO_TIMEOUT_MS = 15_000;

export interface PeerIdentity {
    name: string;
    color: string;
}

export interface MeshPeer extends PeerIdentity {
    /** Hex of the peer's Noise public key; unique per running session. */
    id: string;
}

export type RejectReason =
    | 'auth'
    | 'incompatible'
    | 'protocol'
    | 'timeout'
    | 'malformed';

export interface MeshRejection {
    peerId: string;
    reason: RejectReason;
    /** The remote compatibility key, when the handshake got that far. */
    remoteCompat?: string;
}

type ControlMessage =
    | {
          t: 'hello';
          protocol: number;
          compat: string;
          proof: string;
          name: string;
          color: string;
      }
    | { t: 'reject'; reason: 'incompatible' | 'protocol'; compat: string }
    | { t: 'gossip'; id: string; origin: string; hops: number; body: unknown }
    | { t: 'direct'; body: unknown };

export interface PeerMeshOptions {
    /** DHT topic the session announces and looks up. */
    topic: Buffer;
    /** Session secret every peer must prove knowledge of. */
    secret: Buffer;
    /**
     * Peers connect only when their keys match exactly: it encodes the app
     * version and module schemas, which must agree for every peer to build the
     * same patch from the same source.
     */
    compat: string;
    identity: PeerIdentity;
    /** DHT bootstrap nodes; the public network when omitted. */
    bootstrap?: Array<{ host: string; port: number }>;
    /** Extra connection filter: return true to refuse a remote key. */
    firewall?: (remotePublicKey: Buffer) => boolean;
    helloTimeoutMs?: number;
}

interface Connection {
    socket: NoiseSecretStream;
    peer: MeshPeer | null;
}

export interface PeerMeshEvents {
    'peer-open': [peer: MeshPeer];
    'peer-close': [peerId: string];
    gossip: [origin: string, body: unknown, viaPeerId: string];
    direct: [fromPeerId: string, body: unknown];
    data: [fromPeerId: string, channel: ChannelId, payload: Buffer];
    rejected: [rejection: MeshRejection];
    /** Discovery, connection attempts or the NAT type changed. */
    network: [network: SessionNetwork];
}

/**
 * The set of authenticated connections in a session. Every peer connects to
 * every peer it can reach; peers that cannot reach each other directly still
 * hear each other through gossip, which every peer relays.
 */
export class PeerMesh extends EventEmitter<PeerMeshEvents> {
    readonly localId: string;
    private readonly swarm: Hyperswarm;
    private readonly options: PeerMeshOptions;
    private readonly open = new Map<string, Connection>();
    private readonly banned = new Set<string>();
    private readonly seenGossip = new Map<string, number>();
    private stopped = false;
    private lastConnectError: string | null = null;
    private lastNetwork = '';
    private lastNat: SessionNetwork['nat'] | null = null;

    constructor(options: PeerMeshOptions) {
        super();
        this.options = options;
        this.swarm = new Hyperswarm({
            bootstrap: options.bootstrap,
            firewall: (key) =>
                this.banned.has(key.toString('hex')) ||
                (options.firewall?.(key) ?? false),
        });
        this.localId = this.swarm.keyPair.publicKey.toString('hex');
        this.swarm.on('connection', (socket) => this.handleConnection(socket));
        this.watchNetwork();
    }

    network(): SessionNetwork {
        const dht = this.swarm.dht;
        let nat: SessionNetwork['nat'] = 'checking';
        if (!dht.firewalled) {
            nat = 'open';
        } else if (dht.randomized) {
            nat = 'randomized';
        } else if (dht.host !== null) {
            nat = 'consistent';
        }
        return {
            connecting: this.swarm.connecting,
            found: this.swarm.peers.size,
            lastError: this.lastConnectError,
            nat,
        };
    }

    /** Announce on the topic and resolve once the announcement is flushed. */
    async start(): Promise<void> {
        await this.swarm
            .join(this.options.topic, { client: true, server: true })
            .flushed();
    }

    async stop(): Promise<void> {
        if (this.stopped) {
            return;
        }
        this.stopped = true;
        const ids = [...this.open.keys()];
        this.open.clear();
        for (const id of ids) {
            this.emit('peer-close', id);
        }
        await this.swarm.destroy();
    }

    /**
     * Report network changes, and record why outgoing connections fail:
     * Hyperswarm retries them without surfacing the error.
     */
    private watchNetwork(): void {
        const dht = this.swarm.dht;
        const connect = dht.connect.bind(dht);
        dht.connect = (publicKey, options) => {
            const connection = connect(publicKey, options);
            connection.on('error', (error) => {
                this.lastConnectError = error.code ?? error.message;
                console.info(
                    `[session] connecting to ${publicKey.toString('hex').slice(0, 8)} failed: ${this.lastConnectError}`,
                );
                this.reportNetwork();
            });
            return connection;
        };
        this.swarm.on('update', () => this.reportNetwork());
        dht.on('nat-update', () => this.reportNetwork());
    }

    private reportNetwork(): void {
        if (this.stopped) {
            return;
        }
        const network = this.network();
        const key = JSON.stringify(network);
        if (key === this.lastNetwork) {
            return;
        }
        if (network.nat !== this.lastNat) {
            this.lastNat = network.nat;
            console.info(`[session] network: ${network.nat}`);
        }
        this.lastNetwork = key;
        this.emit('network', network);
    }

    peers(): MeshPeer[] {
        return [...this.open.values()].flatMap((c) => (c.peer ? [c.peer] : []));
    }

    isConnected(peerId: string): boolean {
        return this.open.has(peerId);
    }

    /** Send raw bytes on a data channel to one directly connected peer. */
    send(peerId: string, channel: ChannelId, payload: Uint8Array): boolean {
        const connection = this.open.get(peerId);
        if (!connection) {
            return false;
        }
        connection.socket.write(encodeFrame(channel, payload));
        return true;
    }

    /**
     * Send bytes and resolve once the connection can take more, so bulk
     * transfers do not buffer without bound. Resolves false if the peer is
     * not (or no longer) connected.
     */
    async sendPaced(
        peerId: string,
        channel: ChannelId,
        payload: Uint8Array,
    ): Promise<boolean> {
        const connection = this.open.get(peerId);
        if (!connection) {
            return false;
        }
        if (connection.socket.write(encodeFrame(channel, payload))) {
            return true;
        }
        await new Promise<void>((resolve) => {
            const done = () => {
                connection.socket.off('drain', done);
                connection.socket.off('close', done);
                resolve();
            };
            connection.socket.on('drain', done);
            connection.socket.on('close', done);
        });
        return this.open.get(peerId) === connection;
    }

    /** Send a JSON message to one directly connected peer. */
    sendDirect(peerId: string, body: unknown): boolean {
        return this.sendControl(peerId, { t: 'direct', body });
    }

    /**
     * Deliver a JSON message to every peer in the session, including those
     * reachable only through other peers. The sender does not receive it.
     */
    publish(body: unknown): void {
        const id = randomUUID();
        this.markSeen(id);
        const message: ControlMessage = {
            t: 'gossip',
            id,
            origin: this.localId,
            hops: 0,
            body,
        };
        for (const peerId of this.open.keys()) {
            this.sendControl(peerId, message);
        }
    }

    private handleConnection(socket: NoiseSecretStream): void {
        const peerId = socket.remotePublicKey.toString('hex');
        if (this.stopped || this.banned.has(peerId)) {
            socket.destroy();
            return;
        }
        const connection: Connection = { socket, peer: null };
        const decoder = new FrameDecoder();
        const helloTimer = setTimeout(
            () => this.refuse(connection, peerId, { peerId, reason: 'timeout' }),
            this.options.helloTimeoutMs ?? DEFAULT_HELLO_TIMEOUT_MS,
        );

        socket.on('error', () => {
            // Closing follows an error; 'close' does the cleanup.
        });
        socket.on('close', () => {
            clearTimeout(helloTimer);
            if (this.open.get(peerId) === connection) {
                this.open.delete(peerId);
                this.emit('peer-close', peerId);
            }
        });
        socket.on('data', (chunk: Buffer) => {
            let frames;
            try {
                frames = decoder.push(chunk);
            } catch {
                this.refuse(connection, peerId, { peerId, reason: 'malformed' });
                return;
            }
            for (const frame of frames) {
                if (socket.destroyed) {
                    return;
                }
                if (frame.channel !== Channel.Control) {
                    if (connection.peer) {
                        this.emit('data', peerId, frame.channel, frame.payload);
                    } else {
                        this.refuse(connection, peerId, {
                            peerId,
                            reason: 'malformed',
                        });
                    }
                    continue;
                }
                let message: ControlMessage;
                try {
                    message = JSON.parse(frame.payload.toString('utf8'));
                } catch {
                    this.refuse(connection, peerId, {
                        peerId,
                        reason: 'malformed',
                    });
                    return;
                }
                this.handleControl(connection, peerId, message, helloTimer);
            }
        });

        socket.write(
            encodeFrame(
                Channel.Control,
                Buffer.from(
                    JSON.stringify({
                        t: 'hello',
                        protocol: SESSION_PROTOCOL_VERSION,
                        compat: this.options.compat,
                        proof: authProof(
                            this.options.secret,
                            socket.publicKey,
                            socket.remotePublicKey,
                        ).toString('base64'),
                        name: this.options.identity.name,
                        color: this.options.identity.color,
                    } satisfies ControlMessage),
                ),
            ),
        );
    }

    private handleControl(
        connection: Connection,
        peerId: string,
        message: ControlMessage,
        helloTimer: NodeJS.Timeout,
    ): void {
        if (!connection.peer) {
            if (message?.t === 'reject') {
                this.refuse(connection, peerId, {
                    peerId,
                    reason: message.reason,
                    remoteCompat: message.compat,
                });
                return;
            }
            if (message?.t !== 'hello') {
                this.refuse(connection, peerId, { peerId, reason: 'malformed' });
                return;
            }
            this.handleHello(connection, peerId, message, helloTimer);
            return;
        }
        switch (message?.t) {
            case 'gossip':
                this.handleGossip(peerId, message);
                return;
            case 'direct':
                this.emit('direct', peerId, message.body);
                return;
            default:
                // A late or unknown control message from an authenticated peer
                // is ignored, so newer peers can add message kinds.
                return;
        }
    }

    private handleHello(
        connection: Connection,
        peerId: string,
        hello: Extract<ControlMessage, { t: 'hello' }>,
        helloTimer: NodeJS.Timeout,
    ): void {
        const { socket } = connection;
        const proof =
            typeof hello.proof === 'string'
                ? Buffer.from(hello.proof, 'base64')
                : Buffer.alloc(0);
        if (
            !verifyAuthProof(
                this.options.secret,
                socket.remotePublicKey,
                socket.publicKey,
                proof,
            )
        ) {
            this.refuse(connection, peerId, { peerId, reason: 'auth' });
            return;
        }
        if (hello.protocol !== SESSION_PROTOCOL_VERSION) {
            this.sendRejectAndRefuse(connection, peerId, 'protocol', hello.compat);
            return;
        }
        if (hello.compat !== this.options.compat) {
            this.sendRejectAndRefuse(
                connection,
                peerId,
                'incompatible',
                hello.compat,
            );
            return;
        }
        clearTimeout(helloTimer);
        connection.peer = {
            id: peerId,
            name: typeof hello.name === 'string' ? hello.name : 'Peer',
            color: typeof hello.color === 'string' ? hello.color : '#888888',
        };
        const previous = this.open.get(peerId);
        if (previous) {
            // A reconnect raced the old connection's close. The old socket's
            // close handler sees it is no longer current and stays silent, so
            // the close is reported here, before the new open.
            this.open.delete(peerId);
            previous.socket.destroy();
            this.emit('peer-close', peerId);
        }
        this.open.set(peerId, connection);
        this.emit('peer-open', connection.peer);
    }

    private handleGossip(
        viaPeerId: string,
        message: Extract<ControlMessage, { t: 'gossip' }>,
    ): void {
        if (
            typeof message.id !== 'string' ||
            typeof message.origin !== 'string' ||
            typeof message.hops !== 'number' ||
            this.seenGossip.has(message.id)
        ) {
            return;
        }
        this.markSeen(message.id);
        if (message.origin === this.localId) {
            return;
        }
        this.emit('gossip', message.origin, message.body, viaPeerId);
        if (message.hops + 1 >= MAX_GOSSIP_HOPS) {
            return;
        }
        const relayed: ControlMessage = { ...message, hops: message.hops + 1 };
        for (const peerId of this.open.keys()) {
            if (peerId !== viaPeerId && peerId !== message.origin) {
                this.sendControl(peerId, relayed);
            }
        }
    }

    private markSeen(id: string): void {
        const now = Date.now();
        this.seenGossip.set(id, now);
        if (this.seenGossip.size <= SEEN_GOSSIP_MAX) {
            for (const [seenId, at] of this.seenGossip) {
                if (now - at < SEEN_GOSSIP_TTL_MS) {
                    break;
                }
                this.seenGossip.delete(seenId);
            }
            return;
        }
        // Map iteration is insertion order, so the first entry is the oldest.
        const oldest = this.seenGossip.keys().next().value;
        if (oldest !== undefined) {
            this.seenGossip.delete(oldest);
        }
    }

    private sendControl(peerId: string, message: ControlMessage): boolean {
        const connection = this.open.get(peerId);
        if (!connection) {
            return false;
        }
        connection.socket.write(
            encodeFrame(Channel.Control, Buffer.from(JSON.stringify(message))),
        );
        return true;
    }

    private sendRejectAndRefuse(
        connection: Connection,
        peerId: string,
        reason: 'incompatible' | 'protocol',
        remoteCompat: string,
    ): void {
        connection.socket.write(
            encodeFrame(
                Channel.Control,
                Buffer.from(
                    JSON.stringify({
                        t: 'reject',
                        reason,
                        compat: this.options.compat,
                    } satisfies ControlMessage),
                ),
            ),
        );
        // Ending the stream lets the reject reach the peer before it closes.
        connection.socket.end();
        this.ban(peerId);
        this.emit('rejected', { peerId, reason, remoteCompat });
    }

    /**
     * Drop a connection that failed the handshake. A peer that misbehaved is
     * refused for the rest of the session, since Hyperswarm would otherwise
     * keep reconnecting; a timed-out handshake may be a flaky network, so that
     * peer may try again.
     */
    private refuse(
        connection: Connection,
        peerId: string,
        rejection: MeshRejection,
    ): void {
        if (connection.socket.destroyed) {
            return;
        }
        connection.socket.destroy();
        if (rejection.reason !== 'timeout') {
            this.ban(peerId);
        }
        this.emit('rejected', rejection);
    }

    private ban(peerId: string): void {
        this.banned.add(peerId);
    }
}
