import { randomInt } from 'crypto';
import * as os from 'os';
import { SESSION_PEER_COLORS, type SessionState } from '../../shared/session';
import type { PeerIdentity } from './peerMesh';
import { SessionManager } from './sessionManager';

const MAX_NAME_LENGTH = 40;

export interface SessionHost {
    compat: string;
    sendState: (state: SessionState) => void;
    readSavedName: () => string | undefined;
    saveName: (name: string) => void;
    writeClipboard: (text: string) => void;
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
        this.manager = new SessionManager({ compat: host.compat });
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
