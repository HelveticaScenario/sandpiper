import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { PatchGraph } from '@modular/core';
import type { SessionPeer } from '../../../shared/session';
import { barOf } from '../../../shared/sessionTimeline';
import type { PeerMesh } from '../peerMesh';
import { SharedDoc } from '../sharedDoc';
import {
    type SessionClockConfig,
    type SessionEval,
    SessionPlayback,
    meterChange,
    sessionSourceId,
} from '../sessionPlayback';
import {
    type Testnet,
    makeMesh,
    newTestSession,
    startTestnet,
    waitFor,
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

function patchWith(params: Record<string, unknown>): PatchGraph {
    return {
        modules: [{ id: 'ROOT_CLOCK', moduleType: '_clock', params }],
    } as unknown as PatchGraph;
}

interface FakePeer {
    mesh: PeerMesh;
    shared: SharedDoc;
    playback: SessionPlayback;
    configs: Array<SessionClockConfig | null>;
    played: SessionEval[];
    self: SessionPeer;
}

function peer(
    mesh: PeerMesh,
    role: 'host' | 'guest',
    skewMicros: number,
    name: string,
): FakePeer {
    const shared = new SharedDoc(mesh);
    const configs: Array<SessionClockConfig | null> = [];
    const played: SessionEval[] = [];
    const self = { color: '#123456', id: mesh.localId, name };
    const playback = new SessionPlayback(shared.doc, mesh, self, role, {
        currentMeter: () => ({ barBeats: 4, bpm: 120 }),
        hostMicros: () => Number(process.hrtime.bigint() / 1000n) + skewMicros,
        playRemote: (evaluation) => played.push(evaluation),
        setSessionClock: (config) => configs.push(config),
    });
    const fake = { configs, mesh, playback, played, self, shared };
    cleanup.push(async () => {
        playback.dispose();
        shared.destroy();
        await mesh.stop();
    });
    return fake;
}

const lastConfig = (p: FakePeer) => p.configs[p.configs.length - 1];

describe('SessionPlayback', () => {
    it('starts a timeline on the host and configures every engine to it', async () => {
        const session = newTestSession();
        const host = peer(makeMesh(testnet, session), 'host', 0, 'Ada');
        const guest = peer(makeMesh(testnet, session), 'guest', 5_000_000, 'Bo');
        await Promise.all([host.mesh.start(), guest.mesh.start()]);
        await waitFor(() => Boolean(lastConfig(host)) && Boolean(lastConfig(guest)));
        const h = lastConfig(host)!;
        const g = lastConfig(guest)!;
        expect(h.timeline).toEqual(g.timeline);
        expect(h.timeline.bpm).toBe(120);
        // The guest's offset cancels its clock skew.
        expect(Math.abs(g.offsetMicros - (h.offsetMicros - 5_000_000))).toBeLessThan(5_000);
        // Both agree on the bar now.
        expect(
            Math.abs(host.playback.currentBar()! - guest.playback.currentBar()!),
        ).toBeLessThan(0.01);
    });

    it('plays a local evaluation on every peer on the same bar', async () => {
        const session = newTestSession();
        const host = peer(makeMesh(testnet, session), 'host', 0, 'Ada');
        const guest = peer(makeMesh(testnet, session), 'guest', -3_000_000, 'Bo');
        await Promise.all([host.mesh.start(), guest.mesh.start()]);
        await waitFor(() => guest.playback.currentBar() !== null);

        const plan = host.playback.planLocal('file-1')!;
        expect(plan.sourceId).toBe(sessionSourceId('file-1'));
        expect(plan.atBar).toBeGreaterThan(host.playback.currentBar()!);
        expect(plan.originBar).toBe(plan.atBar);
        host.playback.publishLocal(plan, 'code A', patchWith({ tempo: 120 }));

        await waitFor(() => guest.played.length === 1);
        expect(guest.played[0]).toMatchObject({
            atBar: plan.atBar,
            author: { name: 'Ada' },
            fileId: 'file-1',
            originBar: plan.atBar,
            source: 'code A',
        });
        // The author already queued its own evaluation.
        expect(host.played).toEqual([]);

        // Another evaluation of the same file keeps counting bars from the
        // song's start; a different file starts a new song.
        const again = guest.playback.planLocal('file-1')!;
        expect(again.originBar).toBe(plan.atBar);
        const other = guest.playback.planLocal('file-2')!;
        expect(other.originBar).toBe(other.atBar);
    });

    it('leaves room for slow builds when choosing the bar', async () => {
        const session = newTestSession();
        const host = peer(makeMesh(testnet, session), 'host', 0, 'Ada');
        await host.mesh.start();
        await waitFor(() => host.playback.isReady());
        const quick = host.playback.planLocal('f', 0)!;
        // At 120 bpm in 4/4 a bar is two seconds; a three-second build on
        // each side needs at least three more bars.
        const slow = host.playback.planLocal('f', 3_000_000)!;
        expect(slow.atBar - quick.atBar).toBeGreaterThanOrEqual(2);
    });

    it('schedules a tempo change on the target bar for everyone', async () => {
        const session = newTestSession();
        const host = peer(makeMesh(testnet, session), 'host', 0, 'Ada');
        const guest = peer(makeMesh(testnet, session), 'guest', 0, 'Bo');
        await Promise.all([host.mesh.start(), guest.mesh.start()]);
        await waitFor(() => guest.playback.currentBar() !== null);
        const plan = host.playback.planLocal('f')!;
        host.playback.publishLocal(
            plan,
            'fast',
            patchWith({ denominator: 4, numerator: 3, tempo: 150, tempoSet: true }),
        );
        await waitFor(() => Boolean(lastConfig(guest)?.pending));
        const pending = lastConfig(guest)!.pending!;
        expect(pending).toMatchObject({ anchorBar: plan.atBar, barBeats: 3, bpm: 150 });
        const state = guest.playback.timelineState()!;
        expect(barOf(state, pending.anchorMicros)).toBeCloseTo(plan.atBar, 9);
    });

    it('lets a late joiner play what is already playing once it is in sync', async () => {
        const session = newTestSession();
        const host = peer(makeMesh(testnet, session), 'host', 0, 'Ada');
        await host.mesh.start();
        await waitFor(() => host.playback.currentBar() !== null);
        const plan = host.playback.planLocal('f')!;
        host.playback.publishLocal(plan, 'already playing', patchWith({}));

        const guest = peer(makeMesh(testnet, session), 'guest', 1_000_000, 'Bo');
        await guest.mesh.start();
        await waitFor(() => guest.played.length === 1);
        expect(guest.played[0].source).toBe('already playing');
        expect(guest.playback.currentBar()).not.toBeNull();
    });

    it('resolves concurrent evaluations to the same winner everywhere', async () => {
        const session = newTestSession();
        const host = peer(makeMesh(testnet, session), 'host', 0, 'Ada');
        const guest = peer(makeMesh(testnet, session), 'guest', 0, 'Bo');
        await Promise.all([host.mesh.start(), guest.mesh.start()]);
        await waitFor(() => guest.playback.currentBar() !== null);
        const a = host.playback.planLocal('f')!;
        const b = guest.playback.planLocal('f')!;
        host.playback.publishLocal(a, 'from Ada', patchWith({}));
        guest.playback.publishLocal(b, 'from Bo', patchWith({}));
        await waitFor(() => {
            const ha = host.shared.doc.getMap('playback').get('current') as SessionEval;
            const gb = guest.shared.doc.getMap('playback').get('current') as SessionEval;
            return ha?.id === gb?.id;
        });
        const winner = host.shared.doc.getMap('playback').get('current') as SessionEval;
        // Whoever lost plays the winner; the winner's author already queued it.
        const loser = winner.source === 'from Ada' ? guest : host;
        await waitFor(() => loser.played.some((e) => e.id === winner.id));
    });

    it('hands the clock to a remaining peer when the reference leaves', async () => {
        const session = newTestSession();
        const hostMesh = makeMesh(testnet, session);
        const host = peer(hostMesh, 'host', 0, 'Ada');
        const guest = peer(makeMesh(testnet, session), 'guest', 2_000_000, 'Bo');
        await Promise.all([hostMesh.start(), guest.mesh.start()]);
        await waitFor(() => guest.playback.currentBar() !== null);
        const barBefore = guest.playback.currentBar()!;
        host.playback.dispose();
        await hostMesh.stop();
        await waitFor(
            () => guest.playback.clock.getReference() === guest.self.id,
            15_000,
        );
        // The bar keeps counting from where it was.
        const barAfter = guest.playback.currentBar()!;
        expect(barAfter).toBeGreaterThan(barBefore);
        expect(barAfter - barBefore).toBeLessThan(10);
    }, 30_000);
});

describe('meterChange', () => {
    it('takes the tempo only when the patch sets it', () => {
        expect(meterChange(patchWith({ tempo: 90 }), 120)).toEqual({
            barBeats: 4,
            bpm: 120,
        });
        expect(meterChange(patchWith({ tempo: 90, tempoSet: true }), 120)).toEqual({
            barBeats: 4,
            bpm: 90,
        });
        expect(
            meterChange(patchWith({ denominator: 8, numerator: 6 }), 100),
        ).toEqual({ barBeats: 3, bpm: 100 });
        expect(
            meterChange({ modules: [] } as unknown as PatchGraph, 120),
        ).toBeNull();
    });
});
