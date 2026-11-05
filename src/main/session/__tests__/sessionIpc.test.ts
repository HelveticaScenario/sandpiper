import { describe, expect, it } from 'vitest';
import { defaultSessionName, parseBootstrap } from '../sessionIpc';

describe('parseBootstrap', () => {
    it('parses host:port lists', () => {
        expect(parseBootstrap('127.0.0.1:49737,localhost:1')).toEqual([
            { host: '127.0.0.1', port: 49737 },
            { host: 'localhost', port: 1 },
        ]);
    });

    it.each([undefined, '', 'nohost', ':80', 'host:', 'host:abc', 'a:1,b'])(
        'treats %j as the public network',
        (value) => {
            expect(parseBootstrap(value)).toBeUndefined();
        },
    );
});

describe('defaultSessionName', () => {
    it('prefers the saved name, trimmed and capped', () => {
        expect(defaultSessionName('  Ada  ')).toBe('Ada');
        expect(defaultSessionName('x'.repeat(60))).toHaveLength(40);
    });

    it('falls back to a non-empty name', () => {
        expect(defaultSessionName(undefined).length).toBeGreaterThan(0);
        expect(defaultSessionName('   ').length).toBeGreaterThan(0);
    });
});
