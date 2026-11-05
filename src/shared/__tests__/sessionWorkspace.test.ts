import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
    type FileEntry,
    applyTextDiff,
    createDirEntry,
    createTextEntry,
    filesMap,
    isAtOrUnder,
    isSharedTextPath,
    listEntries,
    normalizeSessionPath,
    resolveEffectivePaths,
} from '../sessionWorkspace';

describe('normalizeSessionPath', () => {
    it.each([
        ['patch.js', 'patch.js'],
        ['songs/intro.mjs', 'songs/intro.mjs'],
        ['caf\u0065\u0301.js', 'caf\u00e9.js'],
    ])('accepts %j', (input, expected) => {
        expect(normalizeSessionPath(input)).toBe(expected);
    });

    it.each([
        '',
        '/etc/passwd',
        '../evil.js',
        'a/../../evil.js',
        'a/./b.js',
        'a//b.js',
        'a\\b.js',
        'C:/x.js',
        'c:x.js',
        '.hidden.js',
        'dir/.git/config',
        'nul\0.js',
        'what?.js',
        'trailing.',
        'trailing ',
        'x'.repeat(600),
        'nul.js',
        'CON',
        'dir/com1.txt',
        'LPT9.mjs',
    ])('rejects %j', (input) => {
        expect(normalizeSessionPath(input)).toBeNull();
    });
});

describe('isSharedTextPath', () => {
    it('shares code and text, not audio or extensionless files', () => {
        expect(isSharedTextPath('a.js')).toBe(true);
        expect(isSharedTextPath('dir/b.MJS')).toBe(true);
        expect(isSharedTextPath('c.json')).toBe(true);
        expect(isSharedTextPath('wavs/kick.wav')).toBe(false);
        expect(isSharedTextPath('Makefile')).toBe(false);
        expect(isSharedTextPath('dir.js/file')).toBe(false);
    });
});

function entry(id: string, path: string, kind: FileEntry['kind'] = 'text'): FileEntry {
    return { id, kind, path };
}

describe('resolveEffectivePaths', () => {
    it('keeps unique paths', () => {
        const paths = resolveEffectivePaths([entry('a', 'x.js'), entry('b', 'y.js')]);
        expect([...paths]).toEqual([
            ['a', 'x.js'],
            ['b', 'y.js'],
        ]);
    });

    it('gives a contested path to the smallest id regardless of order', () => {
        const forward = resolveEffectivePaths([entry('b', 'x.js'), entry('a', 'x.js')]);
        const backward = resolveEffectivePaths([entry('a', 'x.js'), entry('b', 'x.js')]);
        expect(forward.get('a')).toBe('x.js');
        expect(forward.get('b')).toBe('x (2).js');
        expect(new Map(backward)).toEqual(new Map(forward));
    });

    it('treats paths differing only by case as the same', () => {
        const paths = resolveEffectivePaths([entry('a', 'Song.js'), entry('b', 'song.js')]);
        expect(paths.get('b')).toBe('song (2).js');
    });

    it('moves a file aside from a directory of the same name', () => {
        const paths = resolveEffectivePaths([
            entry('a', 'drums'),
            entry('b', 'drums/kick.js'),
        ]);
        expect(paths.get('a')).toBe('drums (2)');
        expect(paths.get('b')).toBe('drums/kick.js');
    });

    it('skips numbers already taken', () => {
        const paths = resolveEffectivePaths([
            entry('a', 'x.js'),
            entry('b', 'x (2).js'),
            entry('c', 'x.js'),
        ]);
        expect(paths.get('c')).toBe('x (3).js');
    });

    it('lets an empty directory entry claim its name', () => {
        const paths = resolveEffectivePaths([entry('a', 'loops', 'dir'), entry('b', 'loops')]);
        expect(paths.get('a')).toBe('loops');
        expect(paths.get('b')).toBe('loops (2)');
    });
});

describe('applyTextDiff', () => {
    const cases: Array<[string, string]> = [
        ['', 'hello'],
        ['hello', ''],
        ['hello world', 'hello brave world'],
        ['abcdef', 'abXYef'],
        ['aaaa', 'aa'],
        ['same', 'same'],
        ['emoji 😀 here', 'emoji 😃 here'],
        ['😀', '😀😀'],
    ];
    it.each(cases)('turns %j into %j', (from, to) => {
        const doc = new Y.Doc();
        const text = doc.getText('t');
        text.insert(0, from);
        applyTextDiff(text, to);
        expect(text.toJSON()).toBe(to);
    });

    it('preserves a concurrent edit outside the replaced range', () => {
        const a = new Y.Doc();
        const b = new Y.Doc();
        a.getText('t').insert(0, 'one two three');
        Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
        applyTextDiff(a.getText('t'), 'one 2 three');
        b.getText('t').insert(13, '!');
        Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
        Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
        expect(a.getText('t').toJSON()).toBe('one 2 three!');
        expect(b.getText('t').toJSON()).toBe('one 2 three!');
    });
});

describe('entries', () => {
    it('lists created entries and hides invalid remote paths', () => {
        const doc = new Y.Doc();
        createTextEntry(doc, 'a.js', 'x');
        createDirEntry(doc, 'loops');
        const evil = new Y.Map<unknown>();
        evil.set('path', '../evil.js');
        evil.set('kind', 'text');
        evil.set('text', new Y.Text('pwned'));
        filesMap(doc).set('evil', evil);
        const junk = new Y.Map<unknown>();
        junk.set('path', 42);
        filesMap(doc).set('junk', junk);
        expect(
            listEntries(doc)
                .map((e) => `${e.kind}:${e.path}`)
                .sort(),
        ).toEqual(['dir:loops', 'text:a.js']);
        expect(listEntries(doc).find((e) => e.path === 'a.js')?.text?.toJSON()).toBe(
            'x',
        );
    });

    it('matches paths at or under a prefix, case-insensitively', () => {
        expect(isAtOrUnder('a/b.js', 'a')).toBe(true);
        expect(isAtOrUnder('A/b.js', 'a')).toBe(true);
        expect(isAtOrUnder('a', 'a')).toBe(true);
        expect(isAtOrUnder('ab/c.js', 'a')).toBe(false);
    });
});
