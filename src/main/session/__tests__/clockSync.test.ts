import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ClockSync } from '../clockSync';
import type { PeerMesh } from '../peerMesh';
import {
    type Testnet,
    makeMesh,
    newTestSession,
    startTestnet,
    waitFor,
    waitForPeers,
} from './meshTestUtils';

let testnet: Testnet;
const cleanup: Array<() => Promise<void> | void> = [];

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

/** A host clock running `skewMicros` away from every other peer's. */
function clockWithSkew(skewMicros: number): () => number {
    return () => Number(process.hrtime.bigint() / 1000n) + skewMicros;
}

function sync(mesh: PeerMesh, skewMicros: number): ClockSync {
    const clock = new ClockSync({
        fastIntervalMs: 20,
        heartbeatMs: 100,
        mesh,
        now: clockWithSkew(skewMicros),
        slowIntervalMs: 100,
    });
    cleanup.push(async () => {
        clock.stop();
        await mesh.stop();
    });
    return clock;
}

/** How far apart two peers' session clocks read, in microseconds. */
function disagreement(a: ClockSync, b: ClockSync): number {
    return Math.abs(a.sessionNow()! - b.sessionNow()!);
}

describe('ClockSync', () => {
    it('makes a peer with a skewed clock agree with the reference', async () => {
        const session = newTestSession();
        const meshA = makeMesh(testnet, session);
        const meshB = makeMesh(testnet, session);
        const a = sync(meshA, 0);
        const b = sync(meshB, 7_000_000);
        a.setReference(meshA.localId);
        b.setReference(meshA.localId);
        expect(a.isSynced()).toBe(true);
        expect(b.isSynced()).toBe(false);
        await Promise.all([meshA.start(), meshB.start()]);
        await waitForPeers(meshB, [meshA.localId]);
        await waitFor(() => b.isSynced());
        // Local loopback: well within a millisecond in practice; a bar is
        // seconds long.
        expect(disagreement(a, b)).toBeLessThan(5_000);
    });

    it('syncs a peer that can only reach the reference through another peer', async () => {
        const session = newTestSession();
        let aId = '';
        let cId = '';
        const meshA = makeMesh(testnet, session, {
            firewall: (k) => k.toString('hex') === cId,
        });
        const meshB = makeMesh(testnet, session);
        const meshC = makeMesh(testnet, session, {
            firewall: (k) => k.toString('hex') === aId,
        });
        aId = meshA.localId;
        cId = meshC.localId;
        const [a, b, c] = [
            sync(meshA, 0),
            sync(meshB, -2_000_000),
            sync(meshC, 9_000_000),
        ];
        for (const clock of [a, b, c]) {
            clock.setReference(aId);
        }
        await Promise.all([meshA.start(), meshB.start(), meshC.start()]);
        await waitFor(() => b.isSynced() && c.isSynced());
        expect(meshC.isConnected(aId)).toBe(false);
        expect(disagreement(a, c)).toBeLessThan(10_000);
    });

    it('keeps session time unbroken when another peer takes over as reference', async () => {
        const session = newTestSession();
        const meshA = makeMesh(testnet, session);
        const meshB = makeMesh(testnet, session);
        const meshC = makeMesh(testnet, session);
        const a = new ClockSync({
            fastIntervalMs: 20,
            heartbeatMs: 100,
            mesh: meshA,
            now: clockWithSkew(0),
        });
        const b = sync(meshB, 3_000_000);
        const c = sync(meshC, -4_000_000);
        for (const clock of [a, b, c]) {
            clock.setReference(meshA.localId);
        }
        await Promise.all([meshA.start(), meshB.start(), meshC.start()]);
        await waitFor(() => b.isSynced() && c.isSynced());
        const before = b.sessionNow()! - Number(process.hrtime.bigint() / 1000n);

        a.stop();
        await meshA.stop();
        b.setReference(meshB.localId);
        c.setReference(meshB.localId);
        // The new reference keeps the offset it had.
        const after = b.sessionNow()! - Number(process.hrtime.bigint() / 1000n);
        expect(Math.abs(after - before)).toBeLessThan(1_000);
        await new Promise((resolve) => setTimeout(resolve, 300));
        expect(disagreement(b, c)).toBeLessThan(5_000);
    });

    it('tracks which peers are present from heartbeats', async () => {
        const session = newTestSession();
        let aId = '';
        let cId = '';
        const meshA = makeMesh(testnet, session, {
            firewall: (k) => k.toString('hex') === cId,
        });
        const meshB = makeMesh(testnet, session);
        const meshC = makeMesh(testnet, session, {
            firewall: (k) => k.toString('hex') === aId,
        });
        aId = meshA.localId;
        cId = meshC.localId;
        const a = sync(meshA, 0);
        sync(meshB, 0);
        sync(meshC, 0);
        await Promise.all([meshA.start(), meshB.start(), meshC.start()]);
        // C is not connected to A but is heard through B's relays.
        await waitFor(() => a.presentPeers().has(cId));
        expect(meshA.isConnected(cId)).toBe(false);
        expect(a.presentPeers().has(meshB.localId)).toBe(true);
    });
});
