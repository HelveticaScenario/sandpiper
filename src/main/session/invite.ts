import { createHash, createHmac, randomBytes, timingSafeEqual } from 'crypto';

/**
 * A session is identified by a 32-byte secret carried in the invite link.
 * Peers find each other on the DHT under a hash of the secret, which is
 * public, so every connection must also prove knowledge of the secret before
 * it is trusted: joining a session lets peers run code on each other's
 * machines.
 */

const SECRET_BYTES = 32;
const INVITE_PREFIX = 'shoreline://join/';
const TOPIC_CONTEXT = 'shoreline/session/topic/v1';
const AUTH_CONTEXT = 'shoreline/session/auth/v1';

export function createSessionSecret(): Buffer {
    return randomBytes(SECRET_BYTES);
}

export function formatInvite(secret: Uint8Array): string {
    return `${INVITE_PREFIX}${Buffer.from(secret).toString('base64url')}`;
}

/**
 * Parse an invite link, or the bare code after the prefix. Returns null for
 * anything that does not decode to a full secret. Surrounding whitespace and
 * a trailing slash are tolerated, since invites are pasted from chat.
 */
export function parseInvite(invite: string): Buffer | null {
    let code = invite.trim().replace(/\/+$/, '');
    if (code.startsWith(INVITE_PREFIX)) {
        code = code.slice(INVITE_PREFIX.length);
    }
    if (!/^[A-Za-z0-9_-]+$/.test(code)) {
        return null;
    }
    const secret = Buffer.from(code, 'base64url');
    if (secret.byteLength !== SECRET_BYTES) {
        return null;
    }
    // Reject non-canonical encodings so one secret has exactly one invite.
    if (secret.toString('base64url') !== code) {
        return null;
    }
    return secret;
}

/** The DHT topic peers announce and look up for a session. */
export function sessionTopic(secret: Uint8Array): Buffer {
    return createHash('sha256').update(TOPIC_CONTEXT).update(secret).digest();
}

/**
 * Proof that the sender of a connection knows the session secret, bound to
 * both ends' Noise public keys so it cannot be replayed on another connection.
 */
export function authProof(
    secret: Uint8Array,
    senderKey: Uint8Array,
    receiverKey: Uint8Array,
): Buffer {
    return createHmac('sha256', secret)
        .update(AUTH_CONTEXT)
        .update(senderKey)
        .update(receiverKey)
        .digest();
}

export function verifyAuthProof(
    secret: Uint8Array,
    senderKey: Uint8Array,
    receiverKey: Uint8Array,
    proof: Uint8Array,
): boolean {
    const expected = authProof(secret, senderKey, receiverKey);
    return (
        proof.byteLength === expected.byteLength &&
        timingSafeEqual(expected, proof)
    );
}
