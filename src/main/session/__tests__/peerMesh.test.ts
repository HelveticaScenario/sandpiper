import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import Hyperswarm from 'hyperswarm';
import { Channel, encodeFrame } from '../frames';
import type { MeshRejection, PeerMesh } from '../peerMesh';
import {
    type Testnet,
    makeMesh,
    newTestSession,
    sleep,
    startTestnet,
    waitFor,
    waitForPeers,
} from './meshTestUtils';

let testnet: Testnet;
const cleanup: Array<() => Promise<void>> = [];

beforeAll(async () => {
    testnet = await startTestnet();
});

afterAll(async () => {
    await testnet.destroy();
});

afterEach(async () => {
    while (cleanup.length > 0) {
        await cleanup.pop()!();
    }
});

function track<T extends { stop?: () => Promise<void> }>(mesh: T): T {
    cleanup.push(async () => {
        await mesh.stop?.();
    });
    return mesh;
}

async function startAll(...meshes: PeerMesh[]): Promise<void> {
    await Promise.all(meshes.map((m) => m.start()));
}

function collectRejections(mesh: PeerMesh): MeshRejection[] {
    const rejections: MeshRejection[] = [];
    mesh.on('rejected', (r) => rejections.push(r));
    return rejections;
}

describe('PeerMesh', () => {
    it('connects two peers and exchanges identities', async () => {
        const session = newTestSession();
        const a = track(
            makeMesh(testnet, session, {
                identity: { color: '#111111', name: 'Ada' },
            }),
        );
        const b = track(
            makeMesh(testnet, session, {
                identity: { color: '#222222', name: 'Bo' },
            }),
        );
        await startAll(a, b);
        await waitForPeers(a, [b.localId]);
        await waitForPeers(b, [a.localId]);
        expect(a.peers()).toEqual([
            { color: '#222222', id: b.localId, name: 'Bo' },
        ]);
        expect(b.peers()).toEqual([
            { color: '#111111', id: a.localId, name: 'Ada' },
        ]);
    });

    it('carries direct messages and binary frames, including large ones', async () => {
        const session = newTestSession();
        const a = track(makeMesh(testnet, session));
        const b = track(makeMesh(testnet, session));
        await startAll(a, b);
        await waitForPeers(a, [b.localId]);
        await waitForPeers(b, [a.localId]);

        const directs: unknown[] = [];
        const data: Buffer[] = [];
        b.on('direct', (from, body) => {
            expect(from).toBe(a.localId);
            directs.push(body);
        });
        b.on('data', (from, channel, payload) => {
            expect(from).toBe(a.localId);
            expect(channel).toBe(Channel.Blob);
            data.push(payload);
        });

        const big = Buffer.alloc(4 * 1024 * 1024);
        for (let i = 0; i < big.length; i++) {
            big[i] = (i * 31) & 0xff;
        }
        expect(a.sendDirect(b.localId, { hello: 'there' })).toBe(true);
        expect(a.send(b.localId, Channel.Blob, big)).toBe(true);
        await waitFor(() => directs.length === 1 && data.length === 1);
        expect(directs[0]).toEqual({ hello: 'there' });
        expect(data[0].equals(big)).toBe(true);
    });

    it('reports send to an unknown peer as undelivered', async () => {
        const a = track(makeMesh(testnet, newTestSession()));
        expect(a.sendDirect('00'.repeat(32), {})).toBe(false);
        expect(a.send('00'.repeat(32), Channel.Doc, Buffer.alloc(1))).toBe(
            false,
        );
    });

    it('refuses a peer that does not know the secret', async () => {
        const session = newTestSession();
        const a = track(makeMesh(testnet, session));
        // Same topic, different secret: the DHT topic is public.
        const intruder = track(
            makeMesh(testnet, { ...newTestSession(), topic: session.topic }),
        );
        const aRejections = collectRejections(a);
        const intruderRejections = collectRejections(intruder);
        const opened: string[] = [];
        a.on('peer-open', (p) => opened.push(p.id));
        intruder.on('peer-open', (p) => opened.push(p.id));
        await startAll(a, intruder);
        // Whichever side checks first closes the socket, so the other side
        // may see the connection end before its own check runs.
        await waitFor(
            () => aRejections.length + intruderRejections.length > 0,
        );
        await sleep(300);
        expect(
            [...aRejections, ...intruderRejections].every(
                (r) => r.reason === 'auth',
            ),
        ).toBe(true);
        for (const r of aRejections) {
            expect(r.peerId).toBe(intruder.localId);
        }
        expect(opened).toEqual([]);
        expect(a.peers()).toEqual([]);
    });

    it('refuses a peer with a different compatibility key on both sides', async () => {
        const session = newTestSession();
        const a = track(makeMesh(testnet, session, { compat: 'v1' }));
        const b = track(makeMesh(testnet, session, { compat: 'v2' }));
        const aRejections = collectRejections(a);
        const bRejections = collectRejections(b);
        await startAll(a, b);
        await waitFor(
            () => aRejections.length > 0 && bRejections.length > 0,
        );
        expect(aRejections[0]).toMatchObject({
            reason: 'incompatible',
            remoteCompat: 'v2',
        });
        expect(bRejections[0]).toMatchObject({
            reason: 'incompatible',
            remoteCompat: 'v1',
        });
        expect(a.peers()).toEqual([]);
        expect(b.peers()).toEqual([]);
    });

    it('drops a connection that never says hello, without banning it', async () => {
        const session = newTestSession();
        const a = track(makeMesh(testnet, session, { helloTimeoutMs: 300 }));
        const rejections = collectRejections(a);
        await a.start();
        const silent = new Hyperswarm({ bootstrap: testnet.bootstrap });
        cleanup.push(() => silent.destroy());
        silent.on('connection', (socket) => socket.on('error', () => {}));
        await silent.join(session.topic, { client: true, server: false }).flushed();
        await waitFor(() => rejections.length > 0);
        expect(rejections[0]).toMatchObject({
            peerId: silent.keyPair.publicKey.toString('hex'),
            reason: 'timeout',
        });
    });

    it('drops a connection that sends garbage', async () => {
        const session = newTestSession();
        const a = track(makeMesh(testnet, session));
        const rejections = collectRejections(a);
        await a.start();
        const noisy = new Hyperswarm({ bootstrap: testnet.bootstrap });
        cleanup.push(() => noisy.destroy());
        noisy.on('connection', (socket) => {
            socket.on('error', () => {});
            socket.write(Buffer.from([0xff, 0xff, 0xff, 0xff, 0]));
        });
        await noisy.join(session.topic, { client: true, server: false }).flushed();
        await waitFor(() => rejections.length > 0);
        expect(rejections[0].reason).toBe('malformed');
    });

    it('drops a connection that sends data before authenticating', async () => {
        const session = newTestSession();
        const a = track(makeMesh(testnet, session));
        const rejections = collectRejections(a);
        await a.start();
        const eager = new Hyperswarm({ bootstrap: testnet.bootstrap });
        cleanup.push(() => eager.destroy());
        eager.on('connection', (socket) => {
            socket.on('error', () => {});
            socket.write(encodeFrame(Channel.Doc, Buffer.from([1, 2, 3])));
        });
        await eager.join(session.topic, { client: true, server: false }).flushed();
        await waitFor(() => rejections.length > 0);
        expect(rejections[0].reason).toBe('malformed');
    });

    it('relays gossip between peers that cannot reach each other', async () => {
        const session = newTestSession();
        let aId = '';
        let cId = '';
        // A and C refuse each other, so the only path is through B.
        const a = track(
            makeMesh(testnet, session, {
                firewall: (key) => key.toString('hex') === cId,
            }),
        );
        const b = track(makeMesh(testnet, session));
        const c = track(
            makeMesh(testnet, session, {
                firewall: (key) => key.toString('hex') === aId,
            }),
        );
        aId = a.localId;
        cId = c.localId;
        await startAll(a, b, c);
        await waitForPeers(b, [a.localId, c.localId]);
        await waitForPeers(a, [b.localId]);
        await waitForPeers(c, [b.localId]);
        expect(a.isConnected(c.localId)).toBe(false);

        const atC: Array<{ origin: string; body: unknown; via: string }> = [];
        const atA: Array<{ origin: string; body: unknown }> = [];
        const atB: unknown[] = [];
        c.on('gossip', (origin, body, via) => atC.push({ body, origin, via }));
        a.on('gossip', (origin, body) => atA.push({ body, origin }));
        b.on('gossip', (_origin, body) => atB.push(body));

        a.publish({ n: 1 });
        c.publish({ n: 2 });
        await waitFor(() => atC.length === 1 && atA.length === 1);
        await sleep(200);
        expect(atC).toEqual([
            { body: { n: 1 }, origin: a.localId, via: b.localId },
        ]);
        expect(atA).toEqual([{ body: { n: 2 }, origin: c.localId }]);
        expect(atB).toHaveLength(2);
    });

    it('reports peers it found and why it could not reach them', async () => {
        const session = newTestSession();
        const a = track(makeMesh(testnet, session, { firewall: () => true }));
        const b = track(makeMesh(testnet, session));
        const updates: number[] = [];
        b.on('network', (network) => updates.push(network.found));
        await startAll(a, b);
        await waitFor(() => b.network().lastError !== null, 20_000);
        expect(b.network().found).toBe(1);
        expect(b.peers()).toEqual([]);
        expect(updates.length).toBeGreaterThan(0);
    });

    it('delivers each gossip message once in a full mesh', async () => {
        const session = newTestSession();
        const meshes = Array.from({ length: 4 }, () =>
            track(makeMesh(testnet, session)),
        );
        await startAll(...meshes);
        for (const mesh of meshes) {
            await waitForPeers(
                mesh,
                meshes.filter((m) => m !== mesh).map((m) => m.localId),
            );
        }
        const received = meshes.map(() => [] as unknown[]);
        meshes.forEach((mesh, i) =>
            mesh.on('gossip', (_origin, body) => received[i].push(body)),
        );
        meshes[0].publish('x');
        await waitFor(() => received.slice(1).every((r) => r.length >= 1));
        await sleep(300);
        expect(received.map((r) => r.length)).toEqual([0, 1, 1, 1]);
    });

    it('reports a peer leaving', async () => {
        const session = newTestSession();
        const a = track(makeMesh(testnet, session));
        const b = makeMesh(testnet, session);
        await startAll(a, b);
        await waitForPeers(a, [b.localId]);
        const closed: string[] = [];
        a.on('peer-close', (id) => closed.push(id));
        await b.stop();
        await waitFor(() => closed.length === 1);
        expect(closed).toEqual([b.localId]);
        expect(a.peers()).toEqual([]);
    });

    it('reports every peer closed on its own stop', async () => {
        const session = newTestSession();
        const a = makeMesh(testnet, session);
        const b = track(makeMesh(testnet, session));
        await startAll(a, b);
        await waitForPeers(a, [b.localId]);
        const closed: string[] = [];
        a.on('peer-close', (id) => closed.push(id));
        await a.stop();
        expect(closed).toEqual([b.localId]);
        // A second stop is harmless.
        await a.stop();
    });
});
