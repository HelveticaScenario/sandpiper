/**
 * Glide ramp shapes accepted by `pattern.glide(g, curve, mode)`. They mirror
 * the Rust `GlideCurve` / `GlideMode` enums, and each stays between the held
 * pitch and the target.
 */
export const GLIDE_CURVES = [
    'linear',
    'sine',
    'quad',
    'cubic',
    'quart',
    'quint',
    'expo',
    'circ',
    'bounce',
] as const;
export type GlideCurve = (typeof GLIDE_CURVES)[number];

/** Which end of a glide ramp its curve eases. `linear` ignores it. */
export const GLIDE_MODES = ['in', 'out', 'inOut'] as const;
export type GlideMode = (typeof GLIDE_MODES)[number];

/** A TypeScript union of string literals, e.g. `'in' | 'out'`. */
export function literalUnion(values: ReadonlyArray<string>): string {
    return values.map((v) => `'${v}'`).join(' | ');
}
