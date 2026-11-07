/**
 * Length-prefixed frames over a byte stream: a 4-byte big-endian length,
 * then that many bytes.
 */

/** Largest frame either side accepts; a longer length closes the stream. */
export const MAX_FRAME_BYTES = 64 * 1024 * 1024;

export function encodeFrame(payload: Buffer): Buffer {
    const header = Buffer.allocUnsafe(4);
    header.writeUInt32BE(payload.length, 0);
    return Buffer.concat([header, payload]);
}

/**
 * Reassembles frames from arbitrarily split chunks. `push` returns the frames
 * completed by a chunk, or throws on a frame longer than `MAX_FRAME_BYTES`.
 */
export class FrameReader {
    private pending: Buffer[] = [];
    private pendingBytes = 0;

    push(chunk: Buffer): Buffer[] {
        this.pending.push(chunk);
        this.pendingBytes += chunk.length;
        const frames: Buffer[] = [];
        while (this.pendingBytes >= 4) {
            const head = this.peek(4);
            const length = head.readUInt32BE(0);
            if (length > MAX_FRAME_BYTES) {
                throw new Error(`Frame of ${length} bytes exceeds the limit`);
            }
            if (this.pendingBytes < 4 + length) {
                break;
            }
            const all = Buffer.concat(this.pending, this.pendingBytes);
            frames.push(all.subarray(4, 4 + length));
            const rest = all.subarray(4 + length);
            this.pending = rest.length > 0 ? [rest] : [];
            this.pendingBytes = rest.length;
        }
        return frames;
    }

    private peek(bytes: number): Buffer {
        if (this.pending[0].length >= bytes) {
            return this.pending[0];
        }
        const joined = Buffer.concat(this.pending, this.pendingBytes);
        this.pending = [joined];
        return joined;
    }
}
