import * as fs from 'fs';
import * as path from 'path';
import type { ActiveSession } from './sessionManager';
import { type RendererSink, SharedDoc } from './sharedDoc';
import { WorkspaceMirror, type WorkspaceMirrorOptions } from './workspaceMirror';

export interface SessionWorkspaceHost extends WorkspaceMirrorOptions {
    /** The open workspace folder, if any. */
    getWorkspaceRoot: () => string | null;
    /** Make `root` the open workspace. */
    switchWorkspace: (root: string) => void;
    /** Where new session folders are created. */
    sessionsDir: string;
    renderer: RendererSink;
}

/** A fresh, uniquely named folder for a session's files. */
export function createSessionFolder(sessionsDir: string, peerId: string): string {
    const stamp = new Date()
        .toISOString()
        .replace(/[:T]/g, '-')
        .replace(/\..*$/, '');
    let folder = path.join(sessionsDir, `Session ${stamp}`);
    if (fs.existsSync(folder)) {
        folder = `${folder} ${peerId.slice(0, 6)}`;
    }
    fs.mkdirSync(folder, { recursive: true });
    return folder;
}

/**
 * The shared workspace of one live session: the synced document, the folder
 * it is mirrored into, and the renderer's view of it. The host shares the
 * folder it has open; a guest gets a new folder that fills as the session
 * syncs, and keeps it after leaving.
 */
export class SessionWorkspace {
    readonly shared: SharedDoc;
    readonly mirror: WorkspaceMirror;
    private readonly host: SessionWorkspaceHost;
    private rendererConnected = false;

    constructor(session: ActiveSession, host: SessionWorkspaceHost) {
        this.host = host;
        this.shared = new SharedDoc(session.mesh);
        const open = host.getWorkspaceRoot();
        const seed = session.role === 'host' && open !== null;
        const root = seed ? open : createSessionFolder(host.sessionsDir, session.self.id);
        this.mirror = new WorkspaceMirror(this.shared.doc, root, host);
        this.mirror.start({ seed });
        if (root !== open) {
            host.switchWorkspace(root);
        }
    }

    connectRenderer(): { doc: Uint8Array; awareness: Uint8Array } {
        if (this.rendererConnected) {
            // A reloaded renderer: the old one's presence is stale.
            this.shared.disconnectRenderer();
        }
        this.rendererConnected = true;
        return this.shared.connectRenderer(this.host.renderer);
    }

    dispose(): void {
        this.mirror.dispose();
        this.shared.destroy();
    }
}
