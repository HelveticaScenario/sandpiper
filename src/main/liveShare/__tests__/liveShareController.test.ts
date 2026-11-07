import { afterEach, describe, expect, it, vi } from 'vitest';
import { LiveShareController } from '../liveShareController';
import { FakeEngine } from './fakeEngine';

vi.mock('../discovery', () => ({
    advertiseSession: () => () => {},
    browseSessions: () => () => {},
}));

const events = {
    ended() {},
    remotePatch() {},
    remoteStop() {},
    status() {},
};

describe('live share controller', () => {
    const controllers: LiveShareController[] = [];
    afterEach(() => controllers.splice(0).forEach((c) => c.leave()));

    function controller(engine: FakeEngine, name: string) {
        const c = new LiveShareController(engine, () => name, events);
        controllers.push(c);
        return c;
    }

    it('turns Link off on leaving when the session turned it on', async () => {
        const engine = new FakeEngine(Date.now(), 0);
        const host = controller(engine, 'Host');
        await host.hostSession();
        expect(engine.linkEnabled).toBe(true);
        host.leave();
        expect(engine.linkEnabled).toBe(false);
    });

    it('leaves Link on when it was on before the session', async () => {
        const engine = new FakeEngine(Date.now(), 0);
        engine.linkEnabled = true;
        const host = controller(engine, 'Host');
        await host.hostSession();
        host.leave();
        expect(engine.linkEnabled).toBe(true);
    });

    it("turns a guest's Link off when the host ends the session", async () => {
        const epoch = Date.now();
        const host = controller(new FakeEngine(epoch, 0), 'Host');
        const status = await host.hostSession();
        if (status.role !== 'host') throw new Error('not hosting');
        const guestEngine = new FakeEngine(epoch, 3);
        const guest = controller(guestEngine, 'Guest');
        await guest.joinSession({
            address: '127.0.0.1',
            pairingCode: status.pairingCode,
            port: status.port,
        });
        expect(guestEngine.linkEnabled).toBe(true);
        host.leave();
        await vi.waitFor(() => expect(guestEngine.linkEnabled).toBe(false));
    });

    it('turns Link back off when joining fails', async () => {
        const engine = new FakeEngine(Date.now(), 0);
        const guest = controller(engine, 'Guest');
        await expect(
            guest.joinSession({
                address: '127.0.0.1',
                pairingCode: 'X',
                port: 1,
            }),
        ).rejects.toThrow();
        expect(engine.linkEnabled).toBe(false);
    });
});
