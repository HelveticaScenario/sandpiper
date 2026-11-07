declare module 'hyperswarm' {
    import type { EventEmitter } from 'events';
    import type { Duplex } from 'stream';

    export interface NoiseSecretStream extends Duplex {
        readonly publicKey: Buffer;
        readonly remotePublicKey: Buffer;
    }

    export interface PeerInfo {
        readonly publicKey: Buffer;
    }

    export interface Discovery {
        flushed(): Promise<void>;
        destroy(): Promise<void>;
    }

    export interface HyperswarmOptions {
        bootstrap?: Array<{ host: string; port: number }>;
        keyPair?: { publicKey: Buffer; secretKey: Buffer };
        firewall?: (remotePublicKey: Buffer) => boolean;
        maxPeers?: number;
    }

    export interface HyperDHTConnection extends EventEmitter {
        on(event: 'error', listener: (error: Error & { code?: string }) => void): this;
    }

    export interface HyperDHT extends EventEmitter {
        readonly firewalled: boolean;
        readonly host: string | null;
        readonly port: number;
        readonly randomized: boolean;
        connect(publicKey: Buffer, options?: unknown): HyperDHTConnection;
        on(event: 'nat-update', listener: () => void): this;
    }

    export default class Hyperswarm extends EventEmitter {
        constructor(options?: HyperswarmOptions);
        readonly keyPair: { publicKey: Buffer; secretKey: Buffer };
        readonly connections: Set<NoiseSecretStream>;
        readonly dht: HyperDHT;
        /** Peers discovered on joined topics, keyed by hex public key. */
        readonly peers: Map<string, PeerInfo>;
        readonly connecting: number;
        join(
            topic: Buffer,
            options?: { server?: boolean; client?: boolean },
        ): Discovery;
        leave(topic: Buffer): Promise<void>;
        flush(): Promise<void>;
        destroy(): Promise<void>;
        on(
            event: 'connection',
            listener: (socket: NoiseSecretStream, info: PeerInfo) => void,
        ): this;
        on(event: 'update', listener: () => void): this;
    }
}

declare module 'hyperdht/testnet' {
    interface Testnet {
        bootstrap: Array<{ host: string; port: number }>;
        destroy(): Promise<void>;
    }
    export default function createTestnet(size?: number): Promise<Testnet>;
}
