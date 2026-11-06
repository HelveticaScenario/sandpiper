import { EventEmitter } from 'events';
import type {
    SessionAssetProgress,
    SessionNotice,
    SessionPeer,
    SessionRole,
    SessionState,
} from '../../shared/session';
import { compatVersion } from './compat';
import {
    createSessionSecret,
    formatInvite,
    parseInvite,
    sessionTopic,
} from './invite';
import {
    type MeshRejection,
    PeerMesh,
    type PeerIdentity,
} from './peerMesh';

const MAX_NOTICES = 5;

export interface SessionManagerOptions {
    compat: string;
    /** DHT bootstrap nodes; the public network when omitted. */
    bootstrap?: Array<{ host: string; port: number }>;
}

/** What the layers built on a session (document sync, clock, assets) see. */
export interface ActiveSession {
    mesh: PeerMesh;
    role: SessionRole;
    self: SessionPeer;
}

export interface SessionManagerEvents {
    state: [state: SessionState];
    /** A session began; its mesh is about to announce itself. */
    started: [session: ActiveSession];
    /** The session ended; its mesh is stopped. */
    ended: [session: ActiveSession];
}

interface Active extends ActiveSession {
    invite: string;
    notices: SessionNotice[];
    assets: SessionAssetProgress;
}

const NO_ASSETS: SessionAssetProgress = {
    pending: 0,
    receivedBytes: 0,
    totalBytes: 0,
};

/** Starts, joins and leaves the one live session this app can be in. */
export class SessionManager extends EventEmitter<SessionManagerEvents> {
    private readonly options: SessionManagerOptions;
    private active: Active | null = null;
    /** Serialises start/join/leave so overlapping calls cannot interleave. */
    private transition: Promise<unknown> = Promise.resolve();
    private nextNoticeId = 1;

    constructor(options: SessionManagerOptions) {
        super();
        this.options = options;
    }

    getState(): SessionState {
        const active = this.active;
        if (!active) {
            return { status: 'idle' };
        }
        return {
            assets: active.assets,
            invite: active.invite,
            network: active.mesh.network(),
            notices: [...active.notices],
            peers: active.mesh.peers(),
            role: active.role,
            self: active.self,
            status: 'active',
        };
    }

    getActive(): ActiveSession | null {
        return this.active;
    }

    /** Start a new session and return its state, invite included. */
    start(identity: PeerIdentity): Promise<SessionState> {
        return this.serialise(() =>
            this.begin('host', createSessionSecret(), identity),
        );
    }

    /** Join the session an invite link names. */
    join(invite: string, identity: PeerIdentity): Promise<SessionState> {
        return this.serialise(() => {
            const secret = parseInvite(invite);
            if (!secret) {
                throw new Error('That invite link is not valid.');
            }
            return this.begin('guest', secret, identity);
        });
    }

    leave(): Promise<void> {
        return this.serialise(async () => {
            const active = this.active;
            if (!active) {
                return;
            }
            this.active = null;
            await active.mesh.stop();
            this.emit('ended', active);
            this.emitState();
        });
    }

    /** Report assets still arriving from peers. */
    setAssetProgress(progress: SessionAssetProgress): void {
        const active = this.active;
        if (!active) {
            return;
        }
        active.assets = { ...progress };
        this.emitState();
    }

    private serialise<T>(task: () => Promise<T>): Promise<T> {
        const run = this.transition.then(task, task);
        this.transition = run.catch(() => undefined);
        return run;
    }

    private async begin(
        role: SessionRole,
        secret: Buffer,
        identity: PeerIdentity,
    ): Promise<SessionState> {
        if (this.active) {
            throw new Error('Already in a session. Leave it first.');
        }
        const mesh = new PeerMesh({
            bootstrap: this.options.bootstrap,
            compat: this.options.compat,
            identity,
            secret,
            topic: sessionTopic(secret),
        });
        console.info(
            `[session] ${role === 'host' ? 'hosting' : 'joining'} as ${mesh.localId.slice(0, 8)} on build ${this.options.compat}`,
        );
        const active: Active = {
            assets: NO_ASSETS,
            invite: formatInvite(secret),
            mesh,
            notices: [],
            role,
            self: { color: identity.color, id: mesh.localId, name: identity.name },
        };
        mesh.on('peer-open', () => this.emitStateFor(active));
        mesh.on('peer-close', () => this.emitStateFor(active));
        mesh.on('rejected', (rejection) => this.noteRejection(active, rejection));
        mesh.on('network', () => this.emitStateFor(active));
        // Layers attach before the mesh announces itself, so nothing a peer
        // sends on connecting is missed.
        this.active = active;
        try {
            this.emit('started', active);
            await mesh.start();
        } catch (error) {
            this.active = null;
            await mesh.stop();
            this.emit('ended', active);
            throw error;
        }
        this.emitState();
        return this.getState();
    }

    private noteRejection(active: Active, rejection: MeshRejection): void {
        const message = describeRejection(rejection, this.options.compat);
        if (!message) {
            return;
        }
        active.notices.push({
            id: this.nextNoticeId++,
            kind: rejection.reason as SessionNotice['kind'],
            message,
        });
        if (active.notices.length > MAX_NOTICES) {
            active.notices.shift();
        }
        this.emitStateFor(active);
    }

    private emitStateFor(active: Active): void {
        if (this.active === active) {
            this.emitState();
        }
    }

    private emitState(): void {
        this.emit('state', this.getState());
    }
}

/**
 * A user-facing explanation of a refused connection, or null for refusals
 * that are network noise the user cannot act on.
 */
export function describeRejection(
    rejection: MeshRejection,
    localCompat: string,
): string | null {
    switch (rejection.reason) {
        case 'incompatible': {
            const theirs = rejection.remoteCompat
                ? compatVersion(rejection.remoteCompat)
                : 'unknown';
            const ours = compatVersion(localCompat);
            return theirs === ours
                ? `A peer on Shoreline ${theirs} with different modules could not join. Both of you need the same build.`
                : `A peer on Shoreline ${theirs} could not join this session on ${ours}. Both of you need the same version.`;
        }
        case 'protocol':
            return 'A peer on an incompatible version of Shoreline could not join. Both of you need the same version.';
        case 'auth':
            return 'A connection without this session’s invite was refused.';
        default:
            return null;
    }
}
