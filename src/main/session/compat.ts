import { createHash } from 'crypto';

/**
 * The key two peers must share to join the same session: the app version and
 * a digest of the module schemas. Every peer builds its own patch from the
 * shared source, so a difference in either could make the same code sound
 * different, or fail, on different machines. The version comes first so a
 * refusal can name it.
 */
export function buildCompatKey(appVersion: string, schemas: unknown): string {
    const digest = createHash('sha256')
        .update(JSON.stringify(schemas))
        .digest('hex')
        .slice(0, 16);
    return `${appVersion}+${digest}`;
}

/** The app version encoded in a compatibility key. */
export function compatVersion(compat: string): string {
    const plus = compat.lastIndexOf('+');
    return plus === -1 ? compat : compat.slice(0, plus);
}
