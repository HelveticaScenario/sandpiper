/** A participant in a live session, as shown in the UI. */
export interface SessionPeer {
    /** Hex of the peer's Noise public key; unique per running session. */
    id: string;
    name: string;
    color: string;
}

export type SessionNoticeKind = 'incompatible' | 'protocol' | 'auth';

/** A connection attempt the session refused, kept so the UI can explain it. */
export interface SessionNotice {
    id: number;
    kind: SessionNoticeKind;
    message: string;
}

export type SessionRole = 'host' | 'guest';

export type SessionState =
    | { status: 'idle' }
    | {
          status: 'active';
          role: SessionRole;
          invite: string;
          self: SessionPeer;
          /** Peers with an open, authenticated connection to this one. */
          peers: SessionPeer[];
          notices: SessionNotice[];
      };

/** Cursor and avatar colors handed out to peers; all readable on dark themes. */
export const SESSION_PEER_COLORS = [
    '#f97316',
    '#22c55e',
    '#3b82f6',
    '#eab308',
    '#ec4899',
    '#14b8a6',
    '#a855f7',
    '#ef4444',
] as const;
