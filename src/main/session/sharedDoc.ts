import * as Y from 'yjs';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as syncProtocol from 'y-protocols/sync';
import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import { Channel, type ChannelId } from './frames';
import type { PeerMesh } from './peerMesh';

/** Transaction origin of updates the renderer sent. */
export const RENDERER_ORIGIN = 'renderer';

export interface RendererSink {
    docUpdate: (update: Uint8Array) => void;
    awarenessUpdate: (update: Uint8Array) => void;
}

/**
 * The session's Yjs document and presence, kept in sync with every directly
 * connected peer and with the renderer's replica. Updates a peer sends are
 * relayed to the other peers, so peers that cannot reach each other still
 * converge.
 *
 * Presence states belong to the renderers that set them (each renderer has
 * its own Yjs client id). This process only relays them, keeping a copy of
 * every state so a newly connected peer or a reloaded renderer gets the full
 * picture, and dropping the states a peer relayed when that peer leaves.
 */
export class SharedDoc {
    readonly doc = new Y.Doc();
    readonly awareness: awarenessProtocol.Awareness;
    private readonly mesh: PeerMesh;
    private sink: RendererSink | null = null;
    /** Client ids whose presence arrived over each peer connection. */
    private readonly clientsByPeer = new Map<string, Set<number>>();
    /** Client ids the renderer has announced. */
    private readonly rendererClients = new Set<number>();
    private readonly cleanups: Array<() => void> = [];

    constructor(mesh: PeerMesh) {
        this.mesh = mesh;
        this.awareness = new awarenessProtocol.Awareness(this.doc);
        // This process has no cursor of its own.
        this.awareness.setLocalState(null);

        const onDocUpdate = (update: Uint8Array, origin: unknown) => {
            const message = encodeSync((encoder) =>
                syncProtocol.writeUpdate(encoder, update),
            );
            for (const peer of this.mesh.peers()) {
                if (peer.id !== origin) {
                    this.mesh.send(peer.id, Channel.Doc, message);
                }
            }
            if (origin !== RENDERER_ORIGIN) {
                this.sink?.docUpdate(update);
            }
        };
        this.doc.on('update', onDocUpdate);
        this.cleanups.push(() => this.doc.off('update', onDocUpdate));

        // Relay only states that changed here: an update already seen
        // carries a stale clock and changes nothing, which ends relay loops.
        const onAwarenessUpdate = (
            change: { added: number[]; updated: number[]; removed: number[] },
            origin: unknown,
        ) => {
            const clients = [...change.added, ...change.updated, ...change.removed];
            if (clients.length === 0) {
                return;
            }
            const update = awarenessProtocol.encodeAwarenessUpdate(
                this.awareness,
                clients,
            );
            if (origin !== RENDERER_ORIGIN) {
                this.sink?.awarenessUpdate(update);
            }
            // Each process times out silent states on its own, so a timeout
            // is not news to the other peers.
            if (origin === 'timeout') {
                return;
            }
            for (const peer of this.mesh.peers()) {
                if (peer.id !== origin) {
                    this.mesh.send(peer.id, Channel.Awareness, update);
                }
            }
        };
        this.awareness.on('update', onAwarenessUpdate);
        this.cleanups.push(() =>
            this.awareness.off('update', onAwarenessUpdate),
        );

        const onPeerOpen = (peer: { id: string }) => this.greet(peer.id);
        const onPeerClose = (peerId: string) => this.dropPeer(peerId);
        const onData = (peerId: string, channel: ChannelId, payload: Buffer) => {
            if (channel === Channel.Doc) {
                this.handleSync(peerId, payload);
            } else if (channel === Channel.Awareness) {
                this.handleAwareness(peerId, payload);
            }
        };
        mesh.on('peer-open', onPeerOpen);
        mesh.on('peer-close', onPeerClose);
        mesh.on('data', onData);
        this.cleanups.push(() => {
            mesh.off('peer-open', onPeerOpen);
            mesh.off('peer-close', onPeerClose);
            mesh.off('data', onData);
        });
        for (const peer of mesh.peers()) {
            this.greet(peer.id);
        }
    }

    /** Attach the renderer; returns the full document state to seed it. */
    connectRenderer(sink: RendererSink): {
        doc: Uint8Array;
        awareness: Uint8Array;
    } {
        this.sink = sink;
        return {
            awareness: this.encodeAllAwareness(),
            doc: Y.encodeStateAsUpdate(this.doc),
        };
    }

    disconnectRenderer(): void {
        this.sink = null;
        this.removeClients(this.rendererClients, RENDERER_ORIGIN);
    }

    applyRendererUpdate(update: Uint8Array): void {
        Y.applyUpdate(this.doc, update, RENDERER_ORIGIN);
    }

    applyRendererAwareness(update: Uint8Array): void {
        try {
            trackClients(update, this.rendererClients);
            awarenessProtocol.applyAwarenessUpdate(
                this.awareness,
                update,
                RENDERER_ORIGIN,
            );
        } catch (error) {
            console.warn('[session] dropped a malformed presence update', error);
        }
    }

    destroy(): void {
        for (const cleanup of this.cleanups.splice(0)) {
            cleanup();
        }
        this.sink = null;
        this.awareness.destroy();
        this.doc.destroy();
    }

    private greet(peerId: string): void {
        this.mesh.send(
            peerId,
            Channel.Doc,
            encodeSync((encoder) => syncProtocol.writeSyncStep1(encoder, this.doc)),
        );
        if (this.awareness.getStates().size > 0) {
            this.mesh.send(peerId, Channel.Awareness, this.encodeAllAwareness());
        }
    }

    private handleSync(peerId: string, payload: Buffer): void {
        try {
            const decoder = decoding.createDecoder(payload);
            const reply = encoding.createEncoder();
            syncProtocol.readSyncMessage(decoder, reply, this.doc, peerId);
            if (encoding.length(reply) > 0) {
                this.mesh.send(peerId, Channel.Doc, encoding.toUint8Array(reply));
            }
        } catch (error) {
            console.warn('[session] dropped a malformed sync message', error);
        }
    }

    private handleAwareness(peerId: string, payload: Buffer): void {
        try {
            let clients = this.clientsByPeer.get(peerId);
            if (!clients) {
                clients = new Set();
                this.clientsByPeer.set(peerId, clients);
            }
            trackClients(payload, clients);
            awarenessProtocol.applyAwarenessUpdate(this.awareness, payload, peerId);
        } catch (error) {
            console.warn('[session] dropped a malformed presence message', error);
        }
    }

    private dropPeer(peerId: string): void {
        const clients = this.clientsByPeer.get(peerId);
        this.clientsByPeer.delete(peerId);
        if (clients) {
            this.removeClients(clients, peerId);
        }
    }

    /**
     * Remove presence states; the awareness update handler tells the
     * renderer and the other peers.
     */
    private removeClients(clients: Set<number>, origin: string): void {
        const present = [...clients].filter((id) =>
            this.awareness.getStates().has(id),
        );
        clients.clear();
        if (present.length > 0) {
            awarenessProtocol.removeAwarenessStates(this.awareness, present, origin);
        }
    }

    private encodeAllAwareness(): Uint8Array {
        return awarenessProtocol.encodeAwarenessUpdate(this.awareness, [
            ...this.awareness.getStates().keys(),
        ]);
    }
}

function encodeSync(write: (encoder: encoding.Encoder) => void): Uint8Array {
    const encoder = encoding.createEncoder();
    write(encoder);
    return encoding.toUint8Array(encoder);
}

/** Record every client id an awareness update carries. */
function trackClients(update: Uint8Array, into: Set<number>): void {
    const decoder = decoding.createDecoder(update);
    const count = decoding.readVarUint(decoder);
    for (let i = 0; i < count; i++) {
        into.add(decoding.readVarUint(decoder));
        decoding.readVarUint(decoder);
        decoding.readVarString(decoder);
    }
}
