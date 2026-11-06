import { describe, expect, it } from 'vitest';
import type { SessionNetwork } from '../../../shared/session';
import { connectionHint, natLabel } from '../connectionHint';

const base: SessionNetwork = {
    connecting: 0,
    found: 0,
    lastError: null,
    nat: 'consistent',
};

describe('connectionHint', () => {
    it('asks a lone host to share the invite and a lone guest to check the host', () => {
        expect(connectionHint('host', base)).toMatch(/Send them the invite/);
        expect(connectionHint('guest', base)).toMatch(/host still has it open/);
    });

    it('shows progress while connecting', () => {
        expect(
            connectionHint('guest', { ...base, connecting: 1, found: 2 }),
        ).toBe('Found 2 people, connecting…');
    });

    it('explains hole-punching failures in plain words', () => {
        expect(
            connectionHint('guest', {
                ...base,
                found: 1,
                lastError: 'HOLEPUNCH_DOUBLE_RANDOMIZED_NATS',
            }),
        ).toMatch(
            /1 person but could not connect: both of your networks are too strict/,
        );
        expect(
            connectionHint('guest', {
                ...base,
                found: 1,
                lastError: 'HOLEPUNCH_ABORTED',
            }),
        ).toMatch(/blocks direct connections/);
        expect(
            connectionHint('guest', {
                ...base,
                found: 1,
                lastError: 'PEER_CONNECTION_FAILED',
            }),
        ).toMatch(/PEER_CONNECTION_FAILED/);
    });

    it('labels every NAT kind', () => {
        expect(natLabel('randomized')).toMatch(/strict router/);
        expect(natLabel('checking')).toMatch(/checking/);
    });
});
