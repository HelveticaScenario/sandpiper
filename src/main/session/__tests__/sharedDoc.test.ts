import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import * as awarenessProtocol from 'y-protocols/awareness';
import type { PeerMesh } from '../peerMesh';
import { SharedDoc } from '../sharedDoc';
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

function peer(mesh: PeerMesh): SharedDoc {
    const shared = new SharedDoc(mesh);
    cleanup.push(async () => {
        shared.destroy();
        await mesh.stop();
    });
    return shared;
}

/** A renderer replica wired to a SharedDoc the way the IPC bridge wires it. */
function renderer(shared: SharedDoc) {
    const doc = new Y.Doc();
    const awareness = new awarenessProtocol.Awareness(doc);
    const seed = shared.connectRenderer({
        awarenessUpdate: (u) =>
            awarenessProtocol.applyAwarenessUpdate(awareness, u, 'main'),
        docUpdate: (u) => Y.applyUpdate(doc, u, 'main'),
    });
    Y.applyUpdate(doc, seed.doc, 'main');
    awarenessProtocol.applyAwarenessUpdate(awareness, seed.awareness, 'main');
    doc.on('update', (u, origin) => {
        if (origin !== 'main') shared.applyRendererUpdate(u);
    });
    awareness.on('update', (change: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => {
        if (origin === 'main') return;
        const changed = [...change.added, ...change.updated, ...change.removed];
        shared.applyRendererAwareness(
            awarenessProtocol.encodeAwarenessUpdate(awareness, changed),
        );
    });
    cleanup.push(() => awareness.destroy());
    return { awareness, doc };
}

describe('SharedDoc', () => {
    it('syncs existing content to a peer that joins later', async () => {
        const session = newTestSession();
        const meshA = makeMesh(testnet, session);
        const a = peer(meshA);
        a.doc.getText('t').insert(0, 'before join');
        await meshA.start();
        const meshB = makeMesh(testnet, session);
        const b = peer(meshB);
        await meshB.start();
        await waitFor(() => b.doc.getText('t').toJSON() === 'before join');
        b.doc.getText('t').insert(0, '> ');
        await waitFor(() => a.doc.getText('t').toJSON() === '> before join');
    });

    it('converges three peers when two cannot reach each other', async () => {
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
        const [a, , c] = [peer(meshA), peer(meshB), peer(meshC)];
        await Promise.all([meshA.start(), meshB.start(), meshC.start()]);
        await waitForPeers(meshB, [aId, cId]);
        a.doc.getText('t').insert(0, 'A');
        c.doc.getText('t').insert(0, 'C');
        await waitFor(
            () =>
                a.doc.getText('t').toJSON().length === 2 &&
                a.doc.getText('t').toJSON() === c.doc.getText('t').toJSON(),
        );
        expect(meshA.isConnected(cId)).toBe(false);
    });

    it('bridges renderer replicas: edits and presence cross peers', async () => {
        const session = newTestSession();
        const meshA = makeMesh(testnet, session);
        const meshB = makeMesh(testnet, session);
        const a = peer(meshA);
        const b = peer(meshB);
        const ra = renderer(a);
        const rb = renderer(b);
        await Promise.all([meshA.start(), meshB.start()]);
        await waitForPeers(meshA, [meshB.localId]);

        ra.doc.getText('t').insert(0, 'typed in A');
        await waitFor(() => rb.doc.getText('t').toJSON() === 'typed in A');

        ra.awareness.setLocalStateField('user', { name: 'Ada' });
        await waitFor(
            () => rb.awareness.getStates().get(ra.doc.clientID)?.user?.name === 'Ada',
        );
        // The main processes relay presence but never announce their own.
        expect(rb.awareness.getStates().has(a.doc.clientID)).toBe(false);
    });

    it('drops a peer’s presence when it leaves', async () => {
        const session = newTestSession();
        const meshA = makeMesh(testnet, session);
        const meshB = makeMesh(testnet, session);
        const a = peer(meshA);
        const b = new SharedDoc(meshB);
        const ra = renderer(a);
        const rb = renderer(b);
        await Promise.all([meshA.start(), meshB.start()]);
        await waitForPeers(meshA, [meshB.localId]);
        rb.awareness.setLocalStateField('user', { name: 'Bo' });
        await waitFor(() => ra.awareness.getStates().has(rb.doc.clientID));
        b.destroy();
        await meshB.stop();
        await waitFor(() => !ra.awareness.getStates().has(rb.doc.clientID));
    });

    it('drops the renderer’s presence when it disconnects', async () => {
        const session = newTestSession();
        const meshA = makeMesh(testnet, session);
        const meshB = makeMesh(testnet, session);
        const a = peer(meshA);
        const b = peer(meshB);
        const ra = renderer(a);
        const rb = renderer(b);
        await Promise.all([meshA.start(), meshB.start()]);
        await waitForPeers(meshA, [meshB.localId]);
        ra.awareness.setLocalStateField('user', { name: 'Ada' });
        await waitFor(() => rb.awareness.getStates().has(ra.doc.clientID));
        a.disconnectRenderer();
        await waitFor(() => !rb.awareness.getStates().has(ra.doc.clientID));
    });

    it('survives malformed sync and presence frames', async () => {
        const session = newTestSession();
        const meshA = makeMesh(testnet, session);
        const meshB = makeMesh(testnet, session);
        const a = peer(meshA);
        peer(meshB);
        await Promise.all([meshA.start(), meshB.start()]);
        await waitForPeers(meshB, [meshA.localId]);
        meshB.send(meshA.localId, 1, Buffer.from([0, 255, 255, 255, 255]));
        meshB.send(meshA.localId, 2, Buffer.from([9, 9, 9]));
        a.doc.getText('t').insert(0, 'still fine');
        expect(a.doc.getText('t').toJSON()).toBe('still fine');
    });
});
