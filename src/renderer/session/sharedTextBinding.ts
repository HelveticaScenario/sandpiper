import * as Y from 'yjs';
import type * as monacoNs from 'monaco-editor';
import type { Awareness } from 'y-protocols/awareness';
import { applyTextDiff } from '../../shared/sessionWorkspace';

type Monaco = typeof monacoNs;
type Editor = monacoNs.editor.IStandaloneCodeEditor;
type Model = monacoNs.editor.ITextModel;

interface RelativeSelection {
    start: Y.RelativePosition;
    end: Y.RelativePosition;
    direction: monacoNs.SelectionDirection;
}

/** Remote cursors are drawn by class name; see `remoteCursorStyles`. */
export function remoteSelectionClass(clientId: number): string {
    return `yRemoteSelection yRemoteSelection-${clientId}`;
}

export function remoteHeadClass(clientId: number): string {
    return `yRemoteSelectionHead yRemoteSelectionHead-${clientId}`;
}

/**
 * Two-way binding between a Monaco model and a shared Y.Text, with remote
 * cursors drawn from awareness.
 *
 * Undo and redo act on this user's own edits only: remote edits are applied
 * outside Monaco's undo stack, so the model's undo/redo are routed to a
 * Y.UndoManager that tracks edits made through this binding.
 */
export class SharedTextBinding {
    readonly model: Model;
    readonly text: Y.Text;
    private readonly monaco: Monaco;
    private readonly doc: Y.Doc;
    private readonly awareness: Awareness;
    private editor: Editor | null = null;
    private readonly undoManager: Y.UndoManager;
    private applyingRemote = false;
    private applyingLocal = false;
    private savedSelection: RelativeSelection | null = null;
    private decorations: string[] = [];
    private readonly disposers: Array<() => void> = [];
    private editorDisposers: Array<() => void> = [];
    private readonly originalUndo: Model['undo'];
    private readonly originalRedo: Model['redo'];
    private destroyed = false;
    private readonly onRemoteText: (text: string) => void;

    /**
     * `onRemoteText` receives the full text whenever it changes other than by
     * typing in this model, including the initial load, so state that mirrors
     * the model (whether or not an editor shows it) stays current.
     */
    constructor(
        monaco: Monaco,
        text: Y.Text,
        model: Model,
        awareness: Awareness,
        onRemoteText: (text: string) => void,
    ) {
        this.onRemoteText = onRemoteText;
        this.monaco = monaco;
        this.text = text;
        this.model = model;
        this.doc = text.doc!;
        this.awareness = awareness;
        this.undoManager = new Y.UndoManager(text, {
            trackedOrigins: new Set([this]),
        });

        model.setEOL(monaco.editor.EndOfLineSequence.LF);
        const current = text.toJSON();
        if (model.getValue() !== current) {
            this.applyingRemote = true;
            try {
                model.setValue(current);
            } finally {
                this.applyingRemote = false;
            }
        }
        onRemoteText(current);

        const beforeTransaction = () => {
            if (this.applyingLocal) {
                return;
            }
            this.savedSelection = this.captureSelection();
        };
        this.doc.on('beforeAllTransactions', beforeTransaction);
        this.disposers.push(() => this.doc.off('beforeAllTransactions', beforeTransaction));

        const textObserver = (event: Y.YTextEvent) => {
            if (event.transaction.origin === this) {
                return;
            }
            this.applyRemote(event);
            this.onRemoteText(text.toJSON());
            this.renderCursors();
        };
        text.observe(textObserver);
        this.disposers.push(() => text.unobserve(textObserver));

        const contentListener = model.onDidChangeContent((event) => {
            if (this.applyingRemote) {
                return;
            }
            this.applyingLocal = true;
            try {
                this.doc.transact(() => {
                    // A whole-document replacement (formatting, a reload)
                    // becomes the smallest equivalent edit, so peers' cursors
                    // and concurrent edits outside the changed span survive.
                    const [only] = event.changes;
                    if (
                        event.changes.length === 1 &&
                        only.rangeOffset === 0 &&
                        only.rangeLength === text.length
                    ) {
                        applyTextDiff(text, model.getValue());
                        return;
                    }
                    [...event.changes]
                        .sort((a, b) => b.rangeOffset - a.rangeOffset)
                        .forEach((change) => {
                            if (change.rangeLength > 0) {
                                text.delete(change.rangeOffset, change.rangeLength);
                            }
                            if (change.text.length > 0) {
                                text.insert(change.rangeOffset, change.text);
                            }
                        });
                }, this);
            } finally {
                this.applyingLocal = false;
            }
        });
        this.disposers.push(() => contentListener.dispose());

        const disposeListener = model.onWillDispose(() => this.destroy());
        this.disposers.push(() => disposeListener.dispose());

        const awarenessListener = () => this.renderCursors();
        awareness.on('change', awarenessListener);
        this.disposers.push(() => awareness.off('change', awarenessListener));

        this.originalUndo = model.undo.bind(model);
        this.originalRedo = model.redo.bind(model);
        model.undo = () => {
            this.undoManager.undo();
        };
        model.redo = () => {
            this.undoManager.redo();
        };
        this.disposers.push(() => {
            model.undo = this.originalUndo;
            model.redo = this.originalRedo;
        });
    }

    /** Draw cursors in, and publish the selection of, `editor` while it shows this model. */
    attachEditor(editor: Editor | null): void {
        if (editor === this.editor) {
            return;
        }
        this.detachEditor();
        this.editor = editor;
        if (!editor) {
            return;
        }
        const publish = () => {
            if (editor.getModel() !== this.model) {
                return;
            }
            const selection = editor.getSelection();
            if (!selection) {
                return;
            }
            let anchor = this.model.getOffsetAt(selection.getStartPosition());
            let head = this.model.getOffsetAt(selection.getEndPosition());
            if (selection.getDirection() === this.monaco.SelectionDirection.RTL) {
                [anchor, head] = [head, anchor];
            }
            this.awareness.setLocalStateField('selection', {
                anchor: Y.createRelativePositionFromTypeIndex(this.text, anchor),
                head: Y.createRelativePositionFromTypeIndex(this.text, head),
            });
        };
        const selectionListener = editor.onDidChangeCursorSelection(publish);
        const modelListener = editor.onDidChangeModel(() => {
            if (editor.getModel() === this.model) {
                publish();
            } else {
                this.clearPublishedSelection();
            }
            this.renderCursors();
        });
        this.editorDisposers.push(
            () => selectionListener.dispose(),
            () => modelListener.dispose(),
        );
        publish();
        this.renderCursors();
    }

    destroy(): void {
        if (this.destroyed) {
            return;
        }
        this.destroyed = true;
        this.clearPublishedSelection();
        this.detachEditor();
        for (const dispose of this.disposers.splice(0)) {
            dispose();
        }
        this.undoManager.destroy();
    }

    /**
     * Withdraw the selection this user publishes if it points into this
     * text, so peers stop drawing a cursor where this user no longer is.
     */
    private clearPublishedSelection(): void {
        const selection = this.awareness.getLocalState()?.selection as
            | { anchor?: Y.RelativePosition }
            | null
            | undefined;
        if (!selection?.anchor) {
            return;
        }
        const anchor = Y.createAbsolutePositionFromRelativePosition(
            selection.anchor,
            this.doc,
        );
        if (anchor?.type === this.text) {
            this.awareness.setLocalStateField('selection', null);
        }
    }

    private detachEditor(): void {
        if (this.editor && !this.model.isDisposed()) {
            this.decorations = this.model.deltaDecorations(this.decorations, []);
        }
        for (const dispose of this.editorDisposers.splice(0)) {
            dispose();
        }
        this.editor = null;
    }

    private captureSelection(): RelativeSelection | null {
        const editor = this.editor;
        if (!editor || editor.getModel() !== this.model) {
            return null;
        }
        const selection = editor.getSelection();
        if (!selection) {
            return null;
        }
        return {
            direction: selection.getDirection(),
            end: Y.createRelativePositionFromTypeIndex(
                this.text,
                this.model.getOffsetAt(selection.getEndPosition()),
            ),
            start: Y.createRelativePositionFromTypeIndex(
                this.text,
                this.model.getOffsetAt(selection.getStartPosition()),
            ),
        };
    }

    private applyRemote(event: Y.YTextEvent): void {
        const { monaco, model } = this;
        this.applyingRemote = true;
        try {
            let index = 0;
            for (const op of event.delta) {
                if (op.retain !== undefined) {
                    index += op.retain;
                } else if (typeof op.insert === 'string') {
                    const pos = model.getPositionAt(index);
                    model.applyEdits([
                        {
                            range: new monaco.Range(
                                pos.lineNumber,
                                pos.column,
                                pos.lineNumber,
                                pos.column,
                            ),
                            text: op.insert,
                        },
                    ]);
                    index += op.insert.length;
                } else if (op.delete !== undefined) {
                    const start = model.getPositionAt(index);
                    const end = model.getPositionAt(index + op.delete);
                    model.applyEdits([
                        {
                            range: new monaco.Range(
                                start.lineNumber,
                                start.column,
                                end.lineNumber,
                                end.column,
                            ),
                            text: '',
                        },
                    ]);
                }
            }
        } finally {
            this.applyingRemote = false;
        }
        const saved = this.savedSelection;
        const editor = this.editor;
        if (saved && editor && editor.getModel() === model) {
            const start = Y.createAbsolutePositionFromRelativePosition(saved.start, this.doc);
            const end = Y.createAbsolutePositionFromRelativePosition(saved.end, this.doc);
            if (start && end && start.type === this.text && end.type === this.text) {
                const a = model.getPositionAt(start.index);
                const b = model.getPositionAt(end.index);
                editor.setSelection(
                    monaco.Selection.createWithDirection(
                        a.lineNumber,
                        a.column,
                        b.lineNumber,
                        b.column,
                        saved.direction,
                    ),
                );
            }
        }
    }

    private renderCursors(): void {
        const { monaco, model } = this;
        if (this.destroyed || model.isDisposed()) {
            return;
        }
        const decorations: monacoNs.editor.IModelDeltaDecoration[] = [];
        if (this.editor && this.editor.getModel() === model) {
            this.awareness.getStates().forEach((state, clientId) => {
                const selection = state.selection as
                    | { anchor?: unknown; head?: unknown }
                    | undefined;
                if (clientId === this.doc.clientID || !selection?.anchor || !selection.head) {
                    return;
                }
                const anchor = Y.createAbsolutePositionFromRelativePosition(
                    selection.anchor as Y.RelativePosition,
                    this.doc,
                );
                const head = Y.createAbsolutePositionFromRelativePosition(
                    selection.head as Y.RelativePosition,
                    this.doc,
                );
                if (!anchor || !head || anchor.type !== this.text || head.type !== this.text) {
                    return;
                }
                const forward = anchor.index <= head.index;
                const start = model.getPositionAt(forward ? anchor.index : head.index);
                const end = model.getPositionAt(forward ? head.index : anchor.index);
                decorations.push({
                    options: {
                        afterContentClassName: forward ? remoteHeadClass(clientId) : null,
                        beforeContentClassName: forward ? null : remoteHeadClass(clientId),
                        className: remoteSelectionClass(clientId),
                        stickiness:
                            monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
                    },
                    range: new monaco.Range(
                        start.lineNumber,
                        start.column,
                        end.lineNumber,
                        end.column,
                    ),
                });
            });
        }
        this.decorations = model.deltaDecorations(this.decorations, decorations);
    }
}
