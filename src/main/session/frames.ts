/**
 * Length-prefixed framing for session streams. Each frame is a 4-byte
 * big-endian length, then one channel byte, then the payload. Hyperswarm
 * streams are byte streams, so a frame may arrive split across chunks or
 * several frames may share one chunk.
 */

export const Channel = {
    /** JSON control messages: handshake, gossip, direct messages. */
    Control: 0,
    /** Yjs document sync (y-protocols sync messages). */
    Doc: 1,
    /** Yjs awareness updates (presence: cursors, names). */
    Awareness: 2,
    /** Content-addressed asset transfer. */
    Blob: 3,
} as const;

export type ChannelId = (typeof Channel)[keyof typeof Channel];

const KNOWN_CHANNELS = new Set<number>(Object.values(Channel));

/**
 * Largest accepted frame body. The biggest message is the whole shared
 * document sent to a joining peer, which the workspace caps well under this;
 * a larger length prefix means a corrupt or hostile stream.
 */
export const MAX_FRAME_BYTES = 64 * 1024 * 1024;

const HEADER_BYTES = 5;

export function encodeFrame(channel: ChannelId, payload: Uint8Array): Buffer {
    if (payload.byteLength + 1 > MAX_FRAME_BYTES) {
        throw new Error(
            `Session frame of ${payload.byteLength} bytes exceeds the ${MAX_FRAME_BYTES}-byte limit`,
        );
    }
    const frame = Buffer.allocUnsafe(HEADER_BYTES + payload.byteLength);
    frame.writeUInt32BE(payload.byteLength + 1, 0);
    frame.writeUInt8(channel, 4);
    frame.set(payload, HEADER_BYTES);
    return frame;
}

export interface Frame {
    channel: ChannelId;
    payload: Buffer;
}

/** Reassembles frames from arbitrary stream chunks. */
export class FrameDecoder {
    private pending: Buffer[] = [];
    private pendingBytes = 0;

    /**
     * Feed a chunk and return every frame it completes. Throws on a length
     * prefix over the limit or an unknown channel; the stream is unusable
     * after that and must be closed.
     */
    push(chunk: Buffer): Frame[] {
        this.pending.push(chunk);
        this.pendingBytes += chunk.byteLength;
        const frames: Frame[] = [];
        while (this.pendingBytes >= 4) {
            const head = this.peek(4);
            const length = head.readUInt32BE(0);
            if (length < 1 || length > MAX_FRAME_BYTES) {
                throw new Error(`Invalid session frame length ${length}`);
            }
            if (this.pendingBytes < 4 + length) {
                break;
            }
            const body = this.take(4 + length).subarray(4);
            const channel = body.readUInt8(0);
            if (!KNOWN_CHANNELS.has(channel)) {
                throw new Error(`Unknown session channel ${channel}`);
            }
            frames.push({
                channel: channel as ChannelId,
                payload: body.subarray(1),
            });
        }
        return frames;
    }

    private peek(bytes: number): Buffer {
        if (this.pending[0].byteLength >= bytes) {
            return this.pending[0];
        }
        this.pending = [Buffer.concat(this.pending)];
        return this.pending[0];
    }

    private take(bytes: number): Buffer {
        const joined =
            this.pending.length === 1
                ? this.pending[0]
                : Buffer.concat(this.pending);
        const taken = joined.subarray(0, bytes);
        const rest = joined.subarray(bytes);
        this.pending = rest.byteLength > 0 ? [rest] : [];
        this.pendingBytes = rest.byteLength;
        return taken;
    }
}
