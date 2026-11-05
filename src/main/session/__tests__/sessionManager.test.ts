import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { SessionState } from '../../../shared/session';
import { buildCompatKey, compatVersion } from '../compat';
import { formatInvite, createSessionSecret } from '../invite';
import { SessionManager, describeRejection } from '../sessionManager';
import { type Testnet, startTestnet, waitFor } from './meshTestUtils';

let testnet: Testnet;
const managers: SessionManager[] = [];

beforeAll(async () => {
    testnet = await startTestnet();
});

afterAll(async () => {
    await testnet.destroy();
});

afterEach(async () => {
    await Promise.all(managers.splice(0).map((m) => m.leave()));
});

function manager(compat = 'test'): SessionManager {
    const m = new SessionManager({ bootstrap: testnet.bootstrap, compat });
    managers.push(m);
    return m;
}

const ada = { color: '#111111', name: 'Ada' };
const bo = { color: '#222222', name: 'Bo' };

function active(state: SessionState) {
    if (state.status !== 'active') {
        throw new Error('expected an active session');
    }
    return state;
}

describe('SessionManager', () => {
    it('starts idle', () => {
        expect(manager().getState()).toEqual({ status: 'idle' });
    });

    it('hosts a session and lets a guest join with its invite', async () => {
        const host = manager();
        const guest = manager();
        const hostState = active(await host.start(ada));
        expect(hostState.role).toBe('host');
        expect(hostState.invite).toMatch(/^shoreline:\/\/join\//);
        expect(hostState.self.name).toBe('Ada');
        expect(hostState.peers).toEqual([]);

        const guestState = active(await guest.join(hostState.invite, bo));
        expect(guestState.role).toBe('guest');
        expect(guestState.invite).toBe(hostState.invite);

        await waitFor(
            () =>
                active(host.getState()).peers.length === 1 &&
                active(guest.getState()).peers.length === 1,
        );
        expect(active(host.getState()).peers[0]).toMatchObject({
            id: guestState.self.id,
            name: 'Bo',
        });
        expect(active(guest.getState()).peers[0].name).toBe('Ada');
    });

    it('pushes state as peers come and go', async () => {
        const host = manager();
        const states: SessionState[] = [];
        host.on('state', (s) => states.push(s));
        const { invite } = active(await host.start(ada));
        const guest = new SessionManager({
            bootstrap: testnet.bootstrap,
            compat: 'test',
        });
        await guest.join(invite, bo);
        await waitFor(() =>
            states.some((s) => s.status === 'active' && s.peers.length === 1),
        );
        await guest.leave();
        await waitFor(() => {
            const last = states[states.length - 1];
            return last.status === 'active' && last.peers.length === 0;
        });
    });

    it('rejects an invalid invite without starting anything', async () => {
        const m = manager();
        await expect(m.join('shoreline://join/nope', ada)).rejects.toThrow(
            /not valid/,
        );
        expect(m.getState()).toEqual({ status: 'idle' });
    });

    it('refuses to start or join while already in a session', async () => {
        const m = manager();
        await m.start(ada);
        await expect(m.start(ada)).rejects.toThrow(/Already in a session/);
        await expect(
            m.join(formatInvite(createSessionSecret()), ada),
        ).rejects.toThrow(/Already in a session/);
    });

    it('returns to idle on leave and emits ended once', async () => {
        const m = manager();
        const ended: unknown[] = [];
        m.on('ended', (s) => ended.push(s));
        await m.start(ada);
        await m.leave();
        await m.leave();
        expect(m.getState()).toEqual({ status: 'idle' });
        expect(ended).toHaveLength(1);
    });

    it('serialises overlapping start and leave calls', async () => {
        const m = manager();
        const started = m.start(ada);
        const left = m.leave();
        await started;
        await left;
        expect(m.getState()).toEqual({ status: 'idle' });
        // Starting again afterwards works.
        expect((await m.start(ada)).status).toBe('active');
    });

    it('explains a peer on a different version in the notices', async () => {
        const host = manager(buildCompatKey('1.0.0', { a: 1 }));
        const guest = manager(buildCompatKey('1.1.0', { a: 1 }));
        const { invite } = active(await host.start(ada));
        await guest.join(invite, bo);
        await waitFor(() => active(host.getState()).notices.length > 0);
        const [notice] = active(host.getState()).notices;
        expect(notice.kind).toBe('incompatible');
        expect(notice.message).toContain('1.1.0');
        expect(notice.message).toContain('1.0.0');
        expect(active(host.getState()).peers).toEqual([]);
    });
});

describe('describeRejection', () => {
    const local = buildCompatKey('2.0.0', { modules: 1 });

    it('names both versions when they differ', () => {
        expect(
            describeRejection(
                {
                    peerId: 'x',
                    reason: 'incompatible',
                    remoteCompat: buildCompatKey('1.9.0', {}),
                },
                local,
            ),
        ).toMatch(/1\.9\.0.*2\.0\.0/);
    });

    it('calls out a module difference on the same version', () => {
        expect(
            describeRejection(
                {
                    peerId: 'x',
                    reason: 'incompatible',
                    remoteCompat: buildCompatKey('2.0.0', { modules: 2 }),
                },
                local,
            ),
        ).toMatch(/different modules/);
    });

    it('ignores network noise', () => {
        expect(
            describeRejection({ peerId: 'x', reason: 'timeout' }, local),
        ).toBeNull();
        expect(
            describeRejection({ peerId: 'x', reason: 'malformed' }, local),
        ).toBeNull();
    });
});

describe('compat keys', () => {
    it('differ when the schemas differ and keep the version readable', () => {
        const a = buildCompatKey('0.1.0+build.5', [{ name: 'osc' }]);
        const b = buildCompatKey('0.1.0+build.5', [{ name: 'osc2' }]);
        expect(a).not.toBe(b);
        expect(compatVersion(a)).toBe('0.1.0+build.5');
    });
});
