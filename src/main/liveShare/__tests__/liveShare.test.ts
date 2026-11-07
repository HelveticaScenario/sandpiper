import { createServer, connect, type AddressInfo, type Socket } from 'net';
import { afterEach, describe, expect, it } from 'vitest';
import { encodeFrame, FrameReader } from '../framing';
import { generatePairingCode, normalizePairingCode } from '../pairingCode';
import { acceptGuest, joinHost, type MessageChannel } from '../secureChannel';
import { HostSession } from '../hostSession';
import { GuestSession } from '../guestSession';
import { waitFor } from './waitFor';

describe('framing', () => {
    it('reassembles frames split and joined arbitrarily', () => {
        const frames = ['a', 'bb', '', 'cccc'].map((s) =>
            encodeFrame(Buffer.from(s)),
        );
        const stream = Buffer.concat(frames);
        const reader = new FrameReader();
        const out: string[] = [];
        for (let i = 0; i < stream.length; i += 3) {
            for (const f of reader.push(stream.subarray(i, i + 3))) {
                out.push(f.toString());
            }
        }
        expect(out).toEqual(['a', 'bb', '', 'cccc']);
    });

    it('rejects an oversized length', () => {
        const header = Buffer.alloc(4);
        header.writeUInt32BE(0xffffffff, 0);
        expect(() => new FrameReader().push(header)).toThrow();
    });
});

describe('pairing codes', () => {
    it('read the same however they are typed', () => {
        const code = generatePairingCode();
        expect(code).toMatch(/^[0-9A-Z]{4}-[0-9A-Z]{4}$/);
        expect(normalizePairingCode(code.toLowerCase().replace('-', ' '))).toBe(
            normalizePairingCode(code),
        );
        expect(normalizePairingCode('ol1i-0000')).toBe('01110000');
    });
});

/** A connected socket pair on localhost. */
async function socketPair(): Promise<[Socket, Socket, () => void]> {
    const server = createServer();
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const accepted = new Promise<Socket>((r) => server.once('connection', r));
    const client = connect((server.address() as AddressInfo).port, '127.0.0.1');
    const hostSide = await accepted;
    return [hostSide, client, () => server.close()];
}

describe('secure channel', () => {
    const cleanups: (() => void)[] = [];
    afterEach(() => cleanups.splice(0).forEach((c) => c()));

    it('carries messages both ways once the codes match', async () => {
        const [hostSide, guestSide, close] = await socketPair();
        cleanups.push(
            close,
            () => hostSide.destroy(),
            () => guestSide.destroy(),
        );
        const host = acceptGuest<{ n: number }, { n: number }>(
            hostSide,
            'ABCD-EFGH',
            'Host',
        );
        const guest = joinHost<{ n: number }, { n: number }>(
            guestSide,
            'abcd efgh',
            'Guest',
        );
        const { channel: hostChannel, guest: intro } = await host;
        expect(intro.name).toBe('Guest');
        // The guest's join completes on the host's first message.
        hostChannel.send({ n: 1 });
        const { channel: guestChannel, hostName } = await guest;
        expect(hostName).toBe('Host');
        const atGuest: number[] = [];
        const atHost: number[] = [];
        guestChannel.onMessage((m) => atGuest.push(m.n));
        hostChannel.onMessage((m) => atHost.push(m.n));
        hostChannel.send({ n: 2 });
        guestChannel.send({ n: 3 });
        await waitFor(() => atGuest.length === 2 && atHost.length === 1);
        expect(atGuest).toEqual([1, 2]);
        expect(atHost).toEqual([3]);
    });

    it('turns away a wrong code', async () => {
        const [hostSide, guestSide, close] = await socketPair();
        cleanups.push(
            close,
            () => hostSide.destroy(),
            () => guestSide.destroy(),
        );
        const host = acceptGuest(hostSide, 'ABCD-EFGH', 'Host');
        const guest = joinHost(guestSide, 'ABCD-EFGX', 'Guest');
        await expect(host).rejects.toThrow('Wrong pairing code');
        await expect(guest).rejects.toThrow('Wrong pairing code');
    });

    it('closes on a tampered frame', async () => {
        const [hostSide, guestSide, close] = await socketPair();
        cleanups.push(
            close,
            () => hostSide.destroy(),
            () => guestSide.destroy(),
        );
        const host = acceptGuest<unknown, unknown>(hostSide, 'CODE-CODE', 'H');
        const guest = joinHost<unknown, unknown>(guestSide, 'CODE-CODE', 'G');
        const { channel: hostChannel } = await host;
        hostChannel.send({ hello: true });
        const { channel: guestChannel } = await guest;
        const closed = new Promise<string>((r) => hostChannel.onClose(r));
        // A frame of junk where an encrypted message belongs.
        guestSide.write(encodeFrame(Buffer.alloc(40, 7)));
        await expect(closed).resolves.toBeTruthy();
        guestChannel.close();
    });
});

describe('host and guest sessions', () => {
    const closers: (() => void)[] = [];
    afterEach(() => closers.splice(0).forEach((c) => c()));

    async function join(host: HostSession, name: string, events = {}) {
        const guest = await GuestSession.join(
            {
                address: '127.0.0.1',
                pairingCode: host.pairingCode,
                port: host.port,
            },
            name,
            { closed() {}, statusChanged() {}, ...events },
        );
        closers.push(() => guest.leave());
        return guest;
    }

    it('lists everyone who joins and leaves', async () => {
        const host = await HostSession.open('Host', { peersChanged() {} });
        closers.push(() => host.close());
        const first = await join(host, 'Guest 0');
        const second = await join(host, 'Guest 1');
        await waitFor(() => first.peers.length === 3);
        expect(first.peers.map((p) => p.name)).toEqual([
            'Host',
            'Guest 0',
            'Guest 1',
        ]);
        expect(second.selfId).not.toBe(first.selfId);
        second.leave();
        await waitFor(() => host.peers().length === 2);
        await waitFor(() => first.peers.length === 2);
    });

    it('turns away a guest with the wrong code', async () => {
        const host = await HostSession.open('Host', { peersChanged() {} });
        closers.push(() => host.close());
        await expect(
            GuestSession.join(
                {
                    address: '127.0.0.1',
                    pairingCode: 'NOPE-NOPE',
                    port: host.port,
                },
                'Guest',
                { closed() {}, statusChanged() {} },
            ),
        ).rejects.toThrow('Wrong pairing code');
        expect(host.peers()).toHaveLength(1);
    });

    it('tells guests when the host ends the session', async () => {
        const host = await HostSession.open('Host', { peersChanged() {} });
        let ended = '';
        await join(host, 'Guest', {
            closed: (reason: string) => (ended = reason),
        });
        host.close();
        await waitFor(() => ended !== '');
    });
});
