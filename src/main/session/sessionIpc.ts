import { randomInt } from 'crypto';
import * as os from 'os';
import { SESSION_PEER_COLORS, type SessionState } from '../../shared/session';
import type { PeerIdentity } from './peerMesh';
import { SessionManager } from './sessionManager';

const MAX_NAME_LENGTH = 40;

export interface SessionHost {
    compat: string;
    /** DHT bootstrap nodes; the public network when omitted. */
    bootstrap?: Array<{ host: string; port: number }>;
    sendState: (state: SessionState) => void;
    readSavedName: () => string | undefined;
    saveName: (name: string) => void;
    writeClipboard: (text: string) => void;
}

/**
 * Parse `host:port,host:port` into DHT bootstrap nodes, or undefined for an
 * empty or malformed list.
 */
export function parseBootstrap(
    value: string | undefined,
): Array<{ host: string; port: number }> | undefined {
    if (!value) {
        return undefined;
    }
    const nodes = value.split(',').map((item) => {
        const colon = item.lastIndexOf(':');
        const port = Number(item.slice(colon + 1));
        return { host: item.slice(0, colon).trim(), port };
    });
    return nodes.every((n) => n.host && Number.isInteger(n.port) && n.port > 0)
        ? nodes
        : undefined;
}

/** The display name a session starts with: the saved one, else the OS user. */
export function defaultSessionName(saved: string | undefined): string {
    const trimmed = saved?.trim();
    if (trimmed) {
        return trimmed.slice(0, MAX_NAME_LENGTH);
    }
    try {
        return os.userInfo().username.slice(0, MAX_NAME_LENGTH) || 'Guest';
    } catch {
        return 'Guest';
    }
}

/** Main-process glue between the session manager and the renderer. */
export class SessionController {
    readonly manager: SessionManager;
    private readonly host: SessionHost;

    constructor(host: SessionHost) {
        this.host = host;
        this.manager = new SessionManager({
            bootstrap: host.bootstrap,
            compat: host.compat,
        });
        this.manager.on('state', (state) => host.sendState(state));
    }

    getState(): SessionState {
        return this.manager.getState();
    }

    getName(): string {
        return defaultSessionName(this.host.readSavedName());
    }

    start(name: string): Promise<SessionState> {
        return this.manager.start(this.identity(name));
    }

    join(invite: string, name: string): Promise<SessionState> {
        return this.manager.join(invite, this.identity(name));
    }

    leave(): Promise<void> {
        return this.manager.leave();
    }

    copyInvite(): boolean {
        const state = this.manager.getState();
        if (state.status !== 'active') {
            return false;
        }
        this.host.writeClipboard(state.invite);
        return true;
    }

    private identity(name: string): PeerIdentity {
        const chosen = defaultSessionName(name);
        if (chosen !== this.host.readSavedName()) {
            this.host.saveName(chosen);
        }
        return {
            color: SESSION_PEER_COLORS[randomInt(SESSION_PEER_COLORS.length)],
            name: chosen,
        };
    }
}
