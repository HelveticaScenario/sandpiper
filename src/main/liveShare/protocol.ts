/**
 * Messages between a live share host and its guests, sent over a
 * `MessageChannel` after the pairing handshake.
 */
import type { QueuedTrigger } from '@modular/core';
import type { SessionPeer } from '../../shared/liveShare';
import type { PatchFailure, SharedPatch } from './sessionEngine';

/** What a joining guest needs to play along with a session in progress. */
export interface PlaybackState {
    playing: boolean;
    /** Session bar the playing song's bar 0 began on. */
    songOrigin: number;
    /** The patch playing (or about to), if any. */
    patch: SharedPatch | null;
}

export type HostMessage =
    | {
          t: 'welcome';
          selfId: string;
          peers: SessionPeer[];
          playback: PlaybackState;
      }
    | { t: 'peers'; peers: SessionPeer[] }
    /** The host's session position in bars, sent several times a second. */
    | { t: 'clock'; sessionBars: number }
    /** Every peer applies this patch, on its bar. */
    | { t: 'patch'; patch: SharedPatch }
    /** Every peer stops. */
    | { t: 'stop'; by: string }
    /** A guest's run request failed to build; sent to that guest only. */
    | { t: 'runFailed'; requestId: string; failure: PatchFailure };

export type GuestMessage =
    | {
          t: 'run';
          requestId: string;
          source: string;
          sourceId: string | null;
          trigger: QueuedTrigger | null;
      }
    | { t: 'stop' };
