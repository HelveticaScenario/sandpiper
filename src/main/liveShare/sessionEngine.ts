/**
 * The audio engine as a live share session drives it. The app implements
 * this over the native synthesizer and the DSL executor; tests implement it
 * with fakes.
 */
import type { PatchGraph, TransportSnapshot } from '@modular/core';
import type { DSLExecuteResult } from '../../shared/ipcTypes';
import type { CompiledVideoShader } from '../../shared/video/videoGraph';

/**
 * Everything a patch build reports about the source besides the graph:
 * what the editor needs to draw scopes, controls and highlights.
 */
export type PatchMeta = Pick<
    DSLExecuteResult,
    | 'sourceLocationMap'
    | 'interpolationResolutions'
    | 'sliders'
    | 'buttons'
    | 'callSiteSpans'
    | 'eqPanels'
    | 'videoPreviews'
>;

/** A patch built from source, before any engine applies it. */
export interface BuiltPatch {
    patch: PatchGraph;
    video: CompiledVideoShader | null;
    meta: PatchMeta;
}

/** A build that failed, in the shape the editor reports errors from. */
export type PatchFailure = Pick<
    DSLExecuteResult,
    'errorMessage' | 'errors' | 'sourceLocationMap' | 'interpolationResolutions'
>;

/** A patch every peer applies, on the bar the host chose. */
export interface SharedPatch extends BuiltPatch {
    /** Increases with each patch the host sends. */
    seq: number;
    /** Peer whose run produced this patch. */
    authorId: string;
    /** The author's request, so it can match the patch to its run. */
    requestId: string | null;
    /** Session-wide identity of the source the patch was built from. */
    sourceId: string | null;
    /** Session bar the patch applies on; null applies at once. */
    atBar: number | null;
    /** Whether the song restarts from bar 0 when the patch applies. */
    resetClock: boolean;
    /** Set when the patch starts playback: the session bar it starts on. */
    startBar: number | null;
}

export interface SessionEngine {
    transport(): TransportSnapshot;
    setLinkEnabled(enabled: boolean): void;
    setSessionTimeline(barOffset: number | null): void;
    startAtBar(bar: number): void;
    stop(): void;
    /** Build a patch from DSL source against this peer's workspace. */
    build(source: string): BuiltPatch | PatchFailure;
    /** Apply a shared patch to this peer's engine. */
    apply(patch: SharedPatch): DSLExecuteResult;
}

export function isBuiltPatch(
    built: BuiltPatch | PatchFailure,
): built is BuiltPatch {
    return 'patch' in built;
}

/** How long to wait for the audio thread's first Link reading. */
const LINK_START_TIMEOUT_MS = 2_000;

/**
 * Enable Link and wait until the audio thread reports a Link position, so
 * the session's bar numbers start from a real reading.
 */
export async function startLink(engine: SessionEngine): Promise<void> {
    engine.setLinkEnabled(true);
    const before = engine.transport().linkBars;
    const deadline = Date.now() + LINK_START_TIMEOUT_MS;
    while (engine.transport().linkBars === before && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
}
