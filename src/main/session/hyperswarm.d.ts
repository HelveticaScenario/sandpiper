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

    export default class Hyperswarm extends EventEmitter {
        constructor(options?: HyperswarmOptions);
        readonly keyPair: { publicKey: Buffer; secretKey: Buffer };
        readonly connections: Set<NoiseSecretStream>;
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
    }
}

declare module 'hyperdht/testnet' {
    interface Testnet {
        bootstrap: Array<{ host: string; port: number }>;
        destroy(): Promise<void>;
    }
    export default function createTestnet(size?: number): Promise<Testnet>;
}
