import * as Y from 'yjs';
import * as awarenessProtocol from 'y-protocols/awareness';
import type { SessionPeer } from '../../shared/session';
import electronAPI from '../electronAPI';

/** Transaction origin of updates that came from the main process. */
const MAIN_ORIGIN = 'main';

/**
 * The renderer's replica of the session document and presence, kept in step
 * with the main process over IPC. Editors bind to its texts.
 */
export class SessionDocClient {
    readonly doc = new Y.Doc();
    readonly awareness = new awarenessProtocol.Awareness(this.doc);
    private readonly disposers: Array<() => void> = [];
    private destroyed = false;

    /** Connect to the live session; null outside one. */
    static async connect(self: SessionPeer): Promise<SessionDocClient | null> {
        const client = new SessionDocClient();
        // Subscribe before seeding so nothing sent in between is lost; Yjs
        // applies updates in any order.
        client.listen();
        const seed = await electronAPI.session.docConnect();
        if (!seed || client.destroyed) {
            client.destroy();
            return null;
        }
        Y.applyUpdate(client.doc, seed.doc, MAIN_ORIGIN);
        awarenessProtocol.applyAwarenessUpdate(
            client.awareness,
            seed.awareness,
            MAIN_ORIGIN,
        );
        client.awareness.setLocalStateField('user', {
            color: self.color,
            name: self.name,
            peerId: self.id,
        });
        return client;
    }

    private listen(): void {
        this.disposers.push(
            electronAPI.session.onDocUpdate((update) =>
                Y.applyUpdate(this.doc, update, MAIN_ORIGIN),
            ),
            electronAPI.session.onAwarenessUpdate((update) =>
                awarenessProtocol.applyAwarenessUpdate(
                    this.awareness,
                    update,
                    MAIN_ORIGIN,
                ),
            ),
        );
        const onDocUpdate = (update: Uint8Array, origin: unknown) => {
            if (origin !== MAIN_ORIGIN) {
                void electronAPI.session.sendDocUpdate(update);
            }
        };
        this.doc.on('update', onDocUpdate);
        this.disposers.push(() => this.doc.off('update', onDocUpdate));
        const onAwarenessUpdate = (
            change: { added: number[]; updated: number[]; removed: number[] },
            origin: unknown,
        ) => {
            if (origin === MAIN_ORIGIN) {
                return;
            }
            const clients = [...change.added, ...change.updated, ...change.removed];
            void electronAPI.session.sendAwarenessUpdate(
                awarenessProtocol.encodeAwarenessUpdate(this.awareness, clients),
            );
        };
        this.awareness.on('update', onAwarenessUpdate);
        this.disposers.push(() => this.awareness.off('update', onAwarenessUpdate));
    }

    destroy(): void {
        if (this.destroyed) {
            return;
        }
        this.destroyed = true;
        for (const dispose of this.disposers.splice(0)) {
            dispose();
        }
        this.awareness.destroy();
        this.doc.destroy();
    }
}

interface RemoteUser {
    color: string;
    name: string;
}

function cssString(value: string): string {
    return `"${value.replace(/["\\\n\r]/g, (c) => `\\${c.charCodeAt(0).toString(16)} `)}"`;
}

function cssColor(value: string): string {
    return /^#[0-9a-fA-F]{3,8}$/.test(value) ? value : '#888888';
}

/** CSS that colours and labels each remote client's cursor and selection. */
export function remoteCursorStyles(
    states: Map<number, Record<string, unknown>>,
    localClientId: number,
): string {
    const rules: string[] = [];
    states.forEach((state, clientId) => {
        const user = state.user as RemoteUser | undefined;
        if (clientId === localClientId || !user || typeof user.name !== 'string') {
            return;
        }
        const color = cssColor(String(user.color));
        rules.push(
            `.yRemoteSelection-${clientId} { background-color: ${color}33; }`,
            `.yRemoteSelectionHead-${clientId} { border-color: ${color}; }`,
            `.yRemoteSelectionHead-${clientId}::after { content: ${cssString(user.name.slice(0, 40))}; background-color: ${color}; }`,
        );
    });
    return rules.join('\n');
}
