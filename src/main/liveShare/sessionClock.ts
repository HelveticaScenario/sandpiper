/**
 * Shared bar numbers over Ableton Link.
 *
 * Link keeps every peer's phase within a bar aligned, but each peer's Link
 * timeline counts bars from its own origin. The host numbers the session's
 * bars from its own Link timeline and broadcasts its position; a guest's bar
 * offset is the whole number of bars between that position and its own. The
 * fractional part of the difference is the phase disagreement, which is
 * near zero once Link has aligned the two peers (network delay adds a few
 * milliseconds, a tiny fraction of a bar).
 */

/** Largest phase disagreement, in bars, at which a guest counts as in sync. */
export const SYNC_TOLERANCE_BARS = 0.1;

/** Agreeing heartbeats a guest needs before it counts as in sync. */
const SYNC_CONFIRMATIONS = 3;

/** The host's bar offset when it opens a session: its current bar is bar 0. */
export function hostBarOffset(linkBars: number): number {
    return -Math.floor(linkBars);
}

/**
 * The whole-bar offset from `localLinkBars` to the host's session position,
 * and the remaining phase disagreement in bars, in [-0.5, 0.5).
 */
export function guestBarOffset(
    hostSessionBars: number,
    localLinkBars: number,
): { offset: number; residual: number } {
    const difference = hostSessionBars - localLinkBars;
    const offset = Math.round(difference);
    return { offset, residual: difference - offset };
}

/**
 * A guest's view of the session clock, fed one host heartbeat at a time.
 * The offset is adopted only after several heartbeats agree on it with a
 * small residual, so a guest whose Link has not yet found the host (phases
 * unaligned) never plays on a misnumbered bar.
 */
export class GuestClock {
    private candidate: number | null = null;
    private confirmations = 0;
    private misses = 0;
    private adopted: number | null = null;

    /** The adopted offset, or null while not in sync. */
    get offset(): number | null {
        return this.adopted;
    }

    get synced(): boolean {
        return this.adopted !== null;
    }

    /**
     * Feed one heartbeat. Returns true when the adopted offset, or whether
     * there is one, changed.
     */
    heartbeat(
        hostSessionBars: number,
        localLinkBars: number,
        linkPeers: number,
    ): boolean {
        const { offset, residual } = guestBarOffset(
            hostSessionBars,
            localLinkBars,
        );
        const agrees =
            linkPeers > 0 && Math.abs(residual) <= SYNC_TOLERANCE_BARS;
        if (!agrees) {
            this.candidate = null;
            this.confirmations = 0;
            // One late heartbeat does not unsync; several in a row do.
            this.misses++;
            return this.misses >= SYNC_CONFIRMATIONS ? this.adopt(null) : false;
        }
        this.misses = 0;
        if (offset === this.candidate) {
            this.confirmations++;
        } else {
            this.candidate = offset;
            this.confirmations = 1;
        }
        if (this.confirmations >= SYNC_CONFIRMATIONS) {
            return this.adopt(offset);
        }
        // A changed offset is not adopted until confirmed; the old one stands.
        return false;
    }

    reset(): void {
        this.candidate = null;
        this.confirmations = 0;
        this.misses = 0;
        this.adopted = null;
    }

    private adopt(offset: number | null): boolean {
        if (offset === this.adopted) {
            return false;
        }
        this.adopted = offset;
        return true;
    }
}

/** A Link position this far from where the tempo says it should be is a jump. */
const JUMP_TOLERANCE_BARS = 0.25;

/**
 * The host's bar offset. Session bar 0 is the host's Link bar when the
 * session opened. Link can re-map this peer's timeline (when it joins another
 * Link session, say); the offset then moves so session bars keep counting on
 * from where they were.
 */
export class HostClock {
    private _offset: number;
    private last: { bars: number; at: number };

    constructor(linkBars: number, nowMs: number) {
        this._offset = hostBarOffset(linkBars);
        this.last = { at: nowMs, bars: linkBars };
    }

    get offset(): number {
        return this._offset;
    }

    /** Feed the latest Link reading. Returns true when the offset moved. */
    sample(linkBars: number, bpm: number, nowMs: number): boolean {
        const expected =
            this.last.bars + ((nowMs - this.last.at) / 1000) * (bpm / 240);
        this.last = { at: nowMs, bars: linkBars };
        if (Math.abs(linkBars - expected) <= JUMP_TOLERANCE_BARS) {
            return false;
        }
        const offset = Math.round(expected + this._offset - linkBars);
        const moved = offset !== this._offset;
        this._offset = offset;
        return moved;
    }
}
