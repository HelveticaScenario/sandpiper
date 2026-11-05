import { describe, expect, it } from 'vitest';
import {
    authProof,
    createSessionSecret,
    formatInvite,
    parseInvite,
    sessionTopic,
    verifyAuthProof,
} from '../invite';

describe('session invites', () => {
    it('round-trips a secret through an invite link', () => {
        const secret = createSessionSecret();
        const invite = formatInvite(secret);
        expect(invite.startsWith('shoreline://join/')).toBe(true);
        expect(parseInvite(invite)?.equals(secret)).toBe(true);
    });

    it('accepts the bare code and pasted whitespace or trailing slash', () => {
        const secret = createSessionSecret();
        const code = formatInvite(secret).slice('shoreline://join/'.length);
        expect(parseInvite(code)?.equals(secret)).toBe(true);
        expect(parseInvite(`  ${formatInvite(secret)}/ \n`)?.equals(secret)).toBe(
            true,
        );
    });

    it.each([
        '',
        'shoreline://join/',
        'shoreline://join/abc',
        'https://example.com/join/x',
        'not base64 !!',
        // 33 bytes
        `shoreline://join/${Buffer.alloc(33).toString('base64url')}`,
        // padded base64 is not the canonical encoding
        `shoreline://join/${Buffer.alloc(32).toString('base64')}`,
    ])('rejects %j', (invite) => {
        expect(parseInvite(invite)).toBeNull();
    });

    it('derives a topic that differs from the secret and is stable', () => {
        const secret = createSessionSecret();
        const topic = sessionTopic(secret);
        expect(topic.byteLength).toBe(32);
        expect(topic.equals(secret)).toBe(false);
        expect(sessionTopic(secret).equals(topic)).toBe(true);
        expect(sessionTopic(createSessionSecret()).equals(topic)).toBe(false);
    });

    it('verifies a proof only for the same secret and key order', () => {
        const secret = createSessionSecret();
        const a = Buffer.alloc(32, 1);
        const b = Buffer.alloc(32, 2);
        const proof = authProof(secret, a, b);
        expect(verifyAuthProof(secret, a, b, proof)).toBe(true);
        expect(verifyAuthProof(secret, b, a, proof)).toBe(false);
        expect(verifyAuthProof(createSessionSecret(), a, b, proof)).toBe(false);
        expect(verifyAuthProof(secret, a, b, proof.subarray(1))).toBe(false);
        expect(verifyAuthProof(secret, a, b, Buffer.alloc(0))).toBe(false);
    });
});
