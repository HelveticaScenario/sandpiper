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

/** Asset files still arriving from peers. */
export interface SessionAssetProgress {
    pending: number;
    receivedBytes: number;
    totalBytes: number;
}

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
          network: SessionNetwork;
          assets: SessionAssetProgress;
      };

/**
 * How this peer's network looks to the DHT. A randomized NAT changes its
 * public port per destination, so it can connect only to peers whose
 * networks are easier to reach.
 */
export type SessionNat = 'checking' | 'open' | 'consistent' | 'randomized';

/** Progress of finding and reaching the other peers in a session. */
export interface SessionNetwork {
    nat: SessionNat;
    /** Other peers the DHT has returned for this session. */
    found: number;
    /** Connection attempts in progress. */
    connecting: number;
    /** HyperDHT error code of the latest failed connection attempt. */
    lastError: string | null;
}

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
