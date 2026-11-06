import { useCallback, useEffect, useRef, useState } from 'react';
import type * as monacoNs from 'monaco-editor';
import * as Y from 'yjs';
import type { SessionState } from '../../shared/session';
import {
    filesMap,
    listEntries,
    resolveEffectivePaths,
} from '../../shared/sessionWorkspace';
import { formatPath } from '../components/monaco/monacoHelpers';
import { SessionDocClient, remoteCursorStyles } from './sessionDocClient';
import { SharedTextBinding } from './sharedTextBinding';

type Monaco = typeof monacoNs;
type Editor = monacoNs.editor.IStandaloneCodeEditor;

interface UseSharedEditingParams {
    monaco: Monaco | null;
    editor: Editor | null;
    session: SessionState;
    workspaceRoot: string | null;
    /** Absolute paths of open file buffers. */
    openFilePaths: string[];
    /** A shared file open in a buffer was moved by a peer. */
    onSharedFileMoved: (oldPath: string, newPath: string) => void;
    /** A shared file open in a buffer was deleted by a peer. */
    onSharedFileRemoved: (path: string) => void;
    /** The text of a shared file open in a buffer changed other than by typing. */
    onSharedTextChanged: (path: string, text: string) => void;
}

interface Bound {
    binding: SharedTextBinding;
    entryId: string;
}

function separatorOf(root: string): string {
    return root.includes('\\') && !root.includes('/') ? '\\' : '/';
}

/** Workspace-relative, '/'-separated, NFC form of an absolute path. */
export function toSessionRelative(root: string, absolute: string): string | null {
    const sep = separatorOf(root);
    const prefix = root.endsWith(sep) ? root : root + sep;
    if (!absolute.startsWith(prefix)) {
        return null;
    }
    return absolute.slice(prefix.length).split(sep).join('/').normalize('NFC');
}

export function fromSessionRelative(root: string, relative: string): string {
    const sep = separatorOf(root);
    const prefix = root.endsWith(sep) ? root : root + sep;
    return prefix + relative.split('/').join(sep);
}

/**
 * While in a live session, binds every open buffer of a shared file to the
 * session document, so edits from everyone appear live, and reports peers'
 * renames and deletions of open files. Returns a predicate telling whether a
 * path is currently bound.
 */
export function useSharedEditing({
    monaco,
    editor,
    session,
    workspaceRoot,
    openFilePaths,
    onSharedFileMoved,
    onSharedFileRemoved,
    onSharedTextChanged,
}: UseSharedEditingParams): (path: string) => boolean {
    const sharedPathsRef = useRef(new Set<string>());
    const [client, setClient] = useState<SessionDocClient | null>(null);
    const boundRef = useRef(new Map<string, Bound>());
    const [structureVersion, setStructureVersion] = useState(0);
    const [modelVersion, setModelVersion] = useState(0);

    const sessionKey =
        session.status === 'active' ? session.self.id : null;
    const self = session.status === 'active' ? session.self : null;

    // One replica per session.
    useEffect(() => {
        if (!sessionKey || !self) {
            return;
        }
        let cancelled = false;
        let connected: SessionDocClient | null = null;
        void SessionDocClient.connect(self).then((c) => {
            if (cancelled) {
                c?.destroy();
                return;
            }
            connected = c;
            setClient(c);
        });
        return () => {
            cancelled = true;
            connected?.destroy();
            setClient(null);
        };
        // `self` is fixed for the session's lifetime.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [sessionKey]);

    // Re-run binding on file creation, deletion and moves, but not on every
    // keystroke inside a file.
    useEffect(() => {
        if (!client) {
            return;
        }
        const files = filesMap(client.doc);
        const observer = (events: Array<Y.YEvent<Y.AbstractType<unknown>>>) => {
            if (events.some((event) => !(event.target instanceof Y.Text))) {
                setStructureVersion((v) => v + 1);
            }
        };
        files.observeDeep(observer);
        return () => files.unobserveDeep(observer);
    }, [client]);

    useEffect(() => {
        if (!monaco) {
            return;
        }
        const created = monaco.editor.onDidCreateModel(() =>
            setModelVersion((v) => v + 1),
        );
        return () => created.dispose();
    }, [monaco]);

    // Remote cursor colours and name labels.
    useEffect(() => {
        if (!client) {
            return;
        }
        const style = document.createElement('style');
        style.dataset.sessionCursors = '';
        document.head.appendChild(style);
        const update = () => {
            style.textContent = remoteCursorStyles(
                client.awareness.getStates() as Map<number, Record<string, unknown>>,
                client.doc.clientID,
            );
        };
        update();
        client.awareness.on('change', update);
        return () => {
            client.awareness.off('change', update);
            style.remove();
        };
    }, [client]);

    const movedRef = useRef(onSharedFileMoved);
    const removedRef = useRef(onSharedFileRemoved);
    const textRef = useRef(onSharedTextChanged);
    useEffect(() => {
        movedRef.current = onSharedFileMoved;
        removedRef.current = onSharedFileRemoved;
        textRef.current = onSharedTextChanged;
    });

    const openKey = openFilePaths.join('\n');
    useEffect(() => {
        const bound = boundRef.current;
        if (!client || !monaco || !workspaceRoot) {
            for (const { binding } of bound.values()) {
                binding.destroy();
            }
            bound.clear();
            sharedPathsRef.current = new Set();
            return;
        }
        const entries = listEntries(client.doc);
        const effective = resolveEffectivePaths(entries);
        const textById = new Map(entries.map((e) => [e.id, e.text]));
        const idByPath = new Map<string, string>();
        const sharedPaths = new Set<string>();
        effective.forEach((rel, id) => {
            if (textById.get(id)) {
                idByPath.set(rel, id);
                sharedPaths.add(
                    fromSessionRelative(workspaceRoot, rel).normalize('NFC'),
                );
            }
        });
        sharedPathsRef.current = sharedPaths;

        // Peers' moves and deletions of files that are bound here.
        for (const [path, { entryId, binding }] of [...bound]) {
            const now = effective.get(entryId);
            if (now === undefined) {
                binding.destroy();
                bound.delete(path);
                removedRef.current(path);
            } else if (now !== toSessionRelative(workspaceRoot, path)) {
                binding.destroy();
                bound.delete(path);
                movedRef.current(path, fromSessionRelative(workspaceRoot, now));
            }
        }

        const wanted = new Set<string>();
        for (const path of openFilePaths) {
            const rel = toSessionRelative(workspaceRoot, path);
            const id = rel === null ? undefined : idByPath.get(rel);
            const text = id ? textById.get(id) : undefined;
            const model = monaco.editor.getModel(monaco.Uri.parse(formatPath(path)));
            if (!id || !text || !model || model.isDisposed()) {
                continue;
            }
            wanted.add(path);
            const existing = bound.get(path);
            if (
                existing &&
                existing.binding.model === model &&
                existing.binding.text === text
            ) {
                existing.binding.attachEditor(editor);
                continue;
            }
            existing?.binding.destroy();
            const binding = new SharedTextBinding(
                monaco,
                text,
                model,
                client.awareness,
                (current) => textRef.current(path, current),
            );
            binding.attachEditor(editor);
            bound.set(path, { binding, entryId: id });
        }
        for (const [path, { binding }] of [...bound]) {
            if (!wanted.has(path)) {
                binding.destroy();
                bound.delete(path);
            }
        }
        // openKey stands in for openFilePaths.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [client, monaco, editor, workspaceRoot, openKey, structureVersion, modelVersion]);

    useEffect(
        () => () => {
            for (const { binding } of boundRef.current.values()) {
                binding.destroy();
            }
            boundRef.current.clear();
        },
        [],
    );

    return useCallback(
        (path: string) =>
            boundRef.current.has(path) ||
            sharedPathsRef.current.has(path.normalize('NFC')),
        [],
    );
}
