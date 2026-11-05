import { describe, expect, it } from 'vitest';
import { Channel, FrameDecoder, MAX_FRAME_BYTES, encodeFrame } from '../frames';

describe('session frames', () => {
    it('round-trips a frame', () => {
        const decoder = new FrameDecoder();
        const frames = decoder.push(
            encodeFrame(Channel.Doc, Buffer.from([1, 2, 3])),
        );
        expect(frames).toHaveLength(1);
        expect(frames[0].channel).toBe(Channel.Doc);
        expect([...frames[0].payload]).toEqual([1, 2, 3]);
    });

    it('reassembles frames split at every byte', () => {
        const joined = Buffer.concat([
            encodeFrame(Channel.Control, Buffer.from('{"t":"x"}')),
            encodeFrame(Channel.Blob, Buffer.alloc(300, 9)),
            encodeFrame(Channel.Awareness, Buffer.alloc(0)),
        ]);
        const decoder = new FrameDecoder();
        const frames = [];
        for (const byte of joined) {
            frames.push(...decoder.push(Buffer.from([byte])));
        }
        expect(frames.map((f) => f.channel)).toEqual([
            Channel.Control,
            Channel.Blob,
            Channel.Awareness,
        ]);
        expect(frames[0].payload.toString()).toBe('{"t":"x"}');
        expect(frames[1].payload.equals(Buffer.alloc(300, 9))).toBe(true);
        expect(frames[2].payload.byteLength).toBe(0);
    });

    it('decodes several frames delivered in one chunk', () => {
        const decoder = new FrameDecoder();
        const chunk = Buffer.concat(
            Array.from({ length: 5 }, (_, i) =>
                encodeFrame(Channel.Doc, Buffer.from([i])),
            ),
        );
        expect(decoder.push(chunk).map((f) => f.payload[0])).toEqual([
            0, 1, 2, 3, 4,
        ]);
    });

    it('keeps a partial trailing frame for the next chunk', () => {
        const decoder = new FrameDecoder();
        const frame = encodeFrame(Channel.Doc, Buffer.from('hello'));
        const chunk = Buffer.concat([frame, frame.subarray(0, 6)]);
        expect(decoder.push(chunk)).toHaveLength(1);
        const rest = decoder.push(frame.subarray(6));
        expect(rest).toHaveLength(1);
        expect(rest[0].payload.toString()).toBe('hello');
    });

    it('rejects a length prefix over the limit', () => {
        const decoder = new FrameDecoder();
        const header = Buffer.alloc(5);
        header.writeUInt32BE(MAX_FRAME_BYTES + 1, 0);
        expect(() => decoder.push(header)).toThrow(/Invalid session frame/);
    });

    it('rejects a zero length prefix', () => {
        const decoder = new FrameDecoder();
        expect(() => decoder.push(Buffer.alloc(4))).toThrow(
            /Invalid session frame/,
        );
    });

    it('rejects an unknown channel', () => {
        const decoder = new FrameDecoder();
        const frame = encodeFrame(Channel.Doc, Buffer.from([1]));
        frame.writeUInt8(77, 4);
        expect(() => decoder.push(frame)).toThrow(/Unknown session channel/);
    });

    it('refuses to encode a payload over the limit', () => {
        expect(() =>
            encodeFrame(Channel.Blob, Buffer.alloc(MAX_FRAME_BYTES)),
        ).toThrow(/exceeds/);
    });
});
