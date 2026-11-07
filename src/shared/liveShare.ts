/**
 * Live share session state as the renderer sees it.
 *
 * One peer hosts: its workspace and its files are the session's. Guests on
 * the local network join with the host's pairing code. Every peer runs its
 * own audio engine; the host decides what plays and on which shared bar.
 */

export interface SessionPeer {
    id: string;
    name: string;
    /** CSS color for this peer's cursor and name tag. */
    color: string;
    isHost: boolean;
}

/** A host advertising a session on the local network. */
export interface DiscoveredSession {
    /** Stable for as long as the host keeps the session open. */
    id: string;
    hostName: string;
    address: string;
    port: number;
}

export type LiveShareStatus =
    | { role: 'idle' }
    | { role: 'joining'; hostName: string }
    | {
          role: 'host';
          selfId: string;
          pairingCode: string;
          port: number;
          addresses: string[];
          peers: SessionPeer[];
      }
    | {
          role: 'guest';
          selfId: string;
          hostName: string;
          peers: SessionPeer[];
          /** Whether this peer's bar numbers agree with the host's yet. */
          clockSynced: boolean;
      };

export interface JoinSessionRequest {
    address: string;
    port: number;
    pairingCode: string;
}
