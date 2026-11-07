/**
 * The host side of a live share session: a TCP server guests join with the
 * pairing code, the session clock heartbeat, and the playback authority.
 */
import { createServer, type AddressInfo, type Server, type Socket } from 'net';
import { networkInterfaces } from 'os';
import { randomUUID } from 'crypto';
import type { QueuedTrigger } from '@modular/core';
import type { DSLExecuteResult } from '../../shared/ipcTypes';
import type { SessionPeer } from '../../shared/liveShare';
import { generatePairingCode } from './pairingCode';
import type { GuestMessage, HostMessage } from './protocol';
import { acceptGuest, type MessageChannel } from './secureChannel';
import { HostClock } from './sessionClock';
import {
    startLink,
    type SessionEngine,
    type SharedPatch,
} from './sessionEngine';
import { applySharedPatch, HostPlayback } from './sessionPlayback';
import { peerColor } from './peerColors';

/** How often the host broadcasts its session position. */
export const CLOCK_HEARTBEAT_MS = 250;

/** Failed pairing attempts one address may make per window. */
const MAX_FAILED_ATTEMPTS = 5;
const FAILED_ATTEMPT_WINDOW_MS = 60_000;

type GuestChannel = MessageChannel<GuestMessage, HostMessage>;

interface Guest {
    peer: SessionPeer;
    channel: GuestChannel;
}

export interface HostSessionEvents {
    /** The peer list changed. */
    peersChanged(): void;
    /** A patch authored by another peer applied on this engine. */
    remotePatch(patch: SharedPatch, result: DSLExecuteResult): void;
    /** Another peer stopped playback. */
    remoteStop(by: SessionPeer): void;
}

export class HostSession {
    readonly selfId = 'host';
    /** Identifies this session in discovery. */
    readonly sessionId = randomUUID();
    readonly pairingCode = generatePairingCode();
    private readonly server: Server;
    private readonly guests = new Map<string, Guest>();
    private readonly failedAttempts = new Map<string, number[]>();
    private readonly playback: HostPlayback;
    private readonly clock: HostClock;
    private heartbeat: NodeJS.Timeout | null = null;
    private nextColor = 1;

    private constructor(
        private readonly engine: SessionEngine,
        private readonly hostName: string,
        private readonly events: HostSessionEvents,
    ) {
        this.clock = new HostClock(engine.transport().linkBars, Date.now());
        engine.setSessionTimeline(this.clock.offset);
        this.playback = new HostPlayback(engine, () => this.sessionBars());
        this.server = createServer((socket) => void this.admit(socket));
    }

    /** Open a session on an OS-chosen port, on every interface. */
    static async open(
        engine: SessionEngine,
        hostName: string,
        events: HostSessionEvents,
    ): Promise<HostSession> {
        await startLink(engine);
        const session = new HostSession(engine, hostName, events);
        await new Promise<void>((resolve, reject) => {
            session.server.once('error', reject);
            session.server.listen(0, () => resolve());
        });
        session.heartbeat = setInterval(
            () => session.tick(),
            CLOCK_HEARTBEAT_MS,
        );
        return session;
    }

    get port(): number {
        return (this.server.address() as AddressInfo).port;
    }

    /** This machine's IPv4 addresses on the local network. */
    get addresses(): string[] {
        return Object.values(networkInterfaces())
            .flat()
            .filter(
                (iface) =>
                    iface !== undefined &&
                    iface.family === 'IPv4' &&
                    !iface.internal,
            )
            .map((iface) => iface!.address);
    }

    peers(): SessionPeer[] {
        return [
            {
                color: peerColor(0),
                id: this.selfId,
                isHost: true,
                name: this.hostName,
            },
            ...[...this.guests.values()].map((g) => g.peer),
        ];
    }

    /** A run on the host itself. */
    run(
        source: string,
        sourceId: string | null,
        trigger: QueuedTrigger | null,
    ): DSLExecuteResult {
        const shared = this.playback.run({
            authorId: this.selfId,
            requestId: null,
            source,
            sourceId,
            trigger,
        });
        if (!('patch' in shared)) {
            return { ...shared, success: false };
        }
        this.broadcast({ patch: shared, t: 'patch' });
        return applySharedPatch(this.engine, shared);
    }

    /** A stop on the host itself. */
    stop(): void {
        this.stopEveryone(this.selfId);
    }

    close(): void {
        if (this.heartbeat) {
            clearInterval(this.heartbeat);
        }
        for (const guest of this.guests.values()) {
            guest.channel.close('The host ended the session');
        }
        this.guests.clear();
        this.server.close();
        this.engine.setSessionTimeline(null);
    }

    private sessionBars(): number {
        return this.engine.transport().linkBars + this.clock.offset;
    }

    private tick(): void {
        const { linkBars, bpm } = this.engine.transport();
        if (this.clock.sample(linkBars, bpm, Date.now())) {
            this.engine.setSessionTimeline(this.clock.offset);
        }
        this.broadcast({ sessionBars: this.sessionBars(), t: 'clock' });
    }

    private async admit(socket: Socket): Promise<void> {
        const address = socket.remoteAddress ?? 'unknown';
        if (this.recentFailures(address) >= MAX_FAILED_ATTEMPTS) {
            socket.destroy();
            return;
        }
        let accepted;
        try {
            accepted = await acceptGuest<GuestMessage, HostMessage>(
                socket,
                this.pairingCode,
                this.hostName,
            );
        } catch {
            this.failedAttempts.set(address, [
                ...(this.failedAttempts.get(address) ?? []),
                Date.now(),
            ]);
            return;
        }
        const id = randomUUID();
        const guest: Guest = {
            channel: accepted.channel,
            peer: {
                color: peerColor(this.nextColor++),
                id,
                isHost: false,
                name: accepted.guest.name,
            },
        };
        this.guests.set(id, guest);
        guest.channel.onMessage((message) => this.receive(guest, message));
        guest.channel.onClose(() => {
            if (this.guests.delete(id)) {
                this.announcePeers();
            }
        });
        guest.channel.send({
            peers: this.peers(),
            playback: this.playback.state(),
            selfId: id,
            t: 'welcome',
        });
        this.announcePeers();
    }

    private recentFailures(address: string): number {
        const since = Date.now() - FAILED_ATTEMPT_WINDOW_MS;
        const recent = (this.failedAttempts.get(address) ?? []).filter(
            (at) => at > since,
        );
        this.failedAttempts.set(address, recent);
        return recent.length;
    }

    private receive(guest: Guest, message: GuestMessage): void {
        switch (message.t) {
            case 'run': {
                const shared = this.playback.run({
                    authorId: guest.peer.id,
                    requestId: message.requestId,
                    source: message.source,
                    sourceId: message.sourceId,
                    trigger: message.trigger,
                });
                if (!('patch' in shared)) {
                    guest.channel.send({
                        failure: shared,
                        requestId: message.requestId,
                        t: 'runFailed',
                    });
                    return;
                }
                this.broadcast({ patch: shared, t: 'patch' });
                const result = applySharedPatch(this.engine, shared);
                this.events.remotePatch(shared, result);
                return;
            }
            case 'stop':
                this.stopEveryone(guest.peer.id);
                return;
        }
    }

    private stopEveryone(by: string): void {
        this.playback.stop();
        this.broadcast({ by, t: 'stop' });
        this.engine.stop();
        const peer = this.peers().find((p) => p.id === by);
        if (by !== this.selfId && peer) {
            this.events.remoteStop(peer);
        }
    }

    private announcePeers(): void {
        this.broadcast({ peers: this.peers(), t: 'peers' });
        this.events.peersChanged();
    }

    private broadcast(message: HostMessage): void {
        for (const guest of this.guests.values()) {
            guest.channel.send(message);
        }
    }
}
