import createTestnet from 'hyperdht/testnet';
import { PeerMesh, type PeerMeshOptions } from '../peerMesh';
import { createSessionSecret, sessionTopic } from '../invite';

export type Testnet = Awaited<ReturnType<typeof createTestnet>>;

/** A local DHT, so mesh tests never touch the public network. */
export function startTestnet(): Promise<Testnet> {
    return createTestnet(3);
}

export interface TestSession {
    secret: Buffer;
    topic: Buffer;
}

export function newTestSession(): TestSession {
    const secret = createSessionSecret();
    return { secret, topic: sessionTopic(secret) };
}

export function makeMesh(
    testnet: Testnet,
    session: TestSession,
    overrides: Partial<PeerMeshOptions> = {},
): PeerMesh {
    return new PeerMesh({
        bootstrap: testnet.bootstrap,
        compat: 'test-compat',
        identity: { color: '#ff0000', name: 'peer' },
        secret: session.secret,
        topic: session.topic,
        ...overrides,
    });
}

/** Resolve when `mesh` reports an open connection to every id in `peerIds`. */
export function waitForPeers(
    mesh: PeerMesh,
    peerIds: string[],
    timeoutMs = 20_000,
): Promise<void> {
    return waitFor(
        () => peerIds.every((id) => mesh.isConnected(id)),
        timeoutMs,
        `peers ${peerIds.map((id) => id.slice(0, 8)).join(', ')} on ${mesh.localId.slice(0, 8)}`,
    );
}

export async function waitFor(
    condition: () => boolean,
    timeoutMs = 20_000,
    label = 'condition',
): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!condition()) {
        if (Date.now() > deadline) {
            throw new Error(`Timed out waiting for ${label}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
}

export function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
