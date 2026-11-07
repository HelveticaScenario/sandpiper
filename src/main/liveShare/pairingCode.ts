import { randomInt } from 'crypto';

/** Crockford base32: no I, L, O or U, so a code read aloud stays unambiguous. */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const CODE_LENGTH = 8;

/** A fresh pairing code, displayed as `XXXX-XXXX` (40 bits). */
export function generatePairingCode(): string {
    let code = '';
    for (let i = 0; i < CODE_LENGTH; i++) {
        code += ALPHABET[randomInt(ALPHABET.length)];
    }
    return `${code.slice(0, 4)}-${code.slice(4)}`;
}

/**
 * The canonical form both sides derive keys from: case, spaces and dashes
 * ignored, and the letters people confuse with digits read as those digits.
 */
export function normalizePairingCode(input: string): string {
    return input
        .toUpperCase()
        .replace(/[\s-]/g, '')
        .replace(/[IL]/g, '1')
        .replace(/O/g, '0');
}
