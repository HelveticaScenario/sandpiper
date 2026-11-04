import { describe, expect, test } from 'vitest';

import {
    $p,
    MiniParseError,
    isBeatPattern,
    isFastPattern,
    isGlidePattern,
    isParsedPattern,
} from '../index';
import { replaceSignals } from '../../GraphBuilder';

describe('.glide builder', () => {
    test('$p(...).glide(g) builds a GlidePattern wrapping the inner pattern', () => {
        const r = $p('c4 e4 g4').glide(0.25);

        expect(isGlidePattern(r)).toBe(true);
        expect(r.__kind).toBe('GlidePattern');
        expect(r.pattern.__kind).toBe('ParsedPattern');
        // A numeric glide is a raw constant, not a parsed pattern.
        expect(r.length).toBe(0.25);
    });

    test('a string glide parses as a mini-notation number pattern', () => {
        const r = $p('c4 e4 g4').glide('0 0.1 0.5');
        if (typeof r.length === 'number') {
            throw new Error('expected a pattern glide, got a number');
        }
        expect(r.length.source).toBe('0 0.1 0.5');
        expect('Sequence' in r.length.ast).toBe(true);
    });

    test('only a string glide appends an argument span', () => {
        expect($p('c4 e4').glide(0.1).argument_spans).toHaveLength(1);
        expect($p('c4 e4').glide('0 0.1').argument_spans).toHaveLength(2);
        const chained = $p.s('0 2 4', 'c(maj)').add('0 5').glide('0.1');
        expect(chained.argument_spans).toHaveLength(3);
    });

    test('rejects non-finite number args', () => {
        expect(() => $p('c4').glide(NaN)).toThrow(MiniParseError);
        expect(() => $p('c4').glide(Infinity)).toThrow(MiniParseError);
    });

    test('methods are non-enumerable — only the wire shape serializes', () => {
        const r = $p('c4').glide('0 0.1');
        expect(Object.keys(r).sort()).toEqual([
            '__kind',
            'argument_spans',
            'length',
            'pattern',
        ]);
        const json: {
            __kind: unknown;
            length: Record<string, unknown>;
            pattern: Record<string, unknown>;
        } = JSON.parse(JSON.stringify(r));
        expect(json.__kind).toBe('GlidePattern');
        expect(json.length.source).toBe('0 0.1');
        expect('fast' in json).toBe(false);
        expect('glide' in json.pattern).toBe(false);
    });

    test('survives replaceSignals verbatim (no AST collapse)', () => {
        const out = replaceSignals($p('c4 e4').glide('0 0.25'));
        expect(isGlidePattern(out)).toBe(true);
        if (!isGlidePattern(out)) return;
        expect(isParsedPattern(out.pattern)).toBe(true);
        if (typeof out.length === 'number') {
            throw new Error('expected a pattern glide, got a number');
        }
        expect(out.length.source).toBe('0 0.25');
    });
});

describe('.glide composition', () => {
    test('chains with .fast/.beat in any order', () => {
        const r = $p('c4 e4').fast(2).glide(0.1).beat('0,2', 4);
        expect(isBeatPattern(r)).toBe(true);
        expect(isGlidePattern(r.pattern)).toBe(true);
        if (isGlidePattern(r.pattern)) {
            expect(isFastPattern(r.pattern.pattern)).toBe(true);
        }

        const r2 = $p('c4').glide('0 0.1').fast(2);
        expect(r2.__kind).toBe('FastPattern');
        expect(isGlidePattern(r2.pattern)).toBe(true);
        // Inner pattern span + glide span carry through the outer wrapper.
        expect(r2.argument_spans).toHaveLength(2);
    });

    test('works on $p.s and $p.arrange patterns, and as arrange sections', () => {
        expect($p.s('0 2 4', 'c(maj)').glide(0.1).pattern.__kind).toBe(
            'SpPattern',
        );
        expect(
            $p.arrange([2, $p('c4')], [2, $p('e4')]).glide(0.1).pattern.__kind,
        ).toBe('ArrangePattern');

        const r = $p.arrange(
            [2, $p('c4').glide('0.1')],
            [2, $p('e4').glide(0.2)],
        );
        expect(r.sections[0].pattern.__kind).toBe('GlidePattern');
        // (c4 + glide) + e4 = 3 flat spans.
        expect(r.argument_spans).toHaveLength(3);
    });
});
