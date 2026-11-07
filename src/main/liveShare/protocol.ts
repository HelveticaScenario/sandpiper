/**
 * Messages between a live share host and its guests, sent over a
 * `MessageChannel` after the pairing handshake.
 */
import type { SessionPeer } from '../../shared/liveShare';

export type HostMessage =
    | { t: 'welcome'; selfId: string; peers: SessionPeer[] }
    | { t: 'peers'; peers: SessionPeer[] };

/** Guests have nothing to tell the host beyond joining and leaving. */
export type GuestMessage = never;
