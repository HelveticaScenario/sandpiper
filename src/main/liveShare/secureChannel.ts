/**
 * An authenticated, encrypted message channel over a TCP socket.
 *
 * Both sides know the session's pairing code. The handshake proves that
 * without sending it: the host sends a nonce, the guest replies with its own
 * nonce and an HMAC keyed by scrypt(code, both nonces), and the host checks
 * it. Every later frame is AES-256-GCM under keys derived from the same
 * secret, one per direction, with a counter nonce, so a peer without the code
 * can neither read nor forge messages and a replayed or reordered frame fails
 * to decrypt.
 *
 * Messages are JSON values. The handshake frames are plain JSON.
 */
import {
    createCipheriv,
    createDecipheriv,
    createHmac,
    randomBytes,
    scrypt,
    timingSafeEqual,
} from 'crypto';
import type { Socket } from 'net';
import { encodeFrame, FrameReader } from './framing';
import { normalizePairingCode } from './pairingCode';

export const PROTOCOL_VERSION = 1;

const NONCE_BYTES = 16;
const HANDSHAKE_TIMEOUT_MS = 10_000;

/** A bidirectional channel of JSON messages. */
export interface MessageChannel<In, Out> {
    send(message: Out): void;
    onMessage(listener: (message: In) => void): void;
    onClose(listener: (reason: string) => void): void;
    close(reason?: string): void;
}

interface ChallengeFrame {
    t: 'challenge';
    v: number;
    hostNonce: string;
    hostName: string;
}

interface HelloFrame {
    t: 'hello';
    v: number;
    clientNonce: string;
    name: string;
    mac: string;
}

interface RejectFrame {
    t: 'reject';
    reason: string;
}

/** What the guest said about itself in the handshake. */
export interface GuestIntroduction {
    name: string;
}

function deriveSecret(
    code: string,
    hostNonce: Buffer,
    clientNonce: Buffer,
): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        scrypt(
            normalizePairingCode(code),
            Buffer.concat([
                Buffer.from('shoreline-live-share'),
                hostNonce,
                clientNonce,
            ]),
            32,
            { N: 1 << 15, maxmem: 64 * 1024 * 1024 },
            (err, key) => (err ? reject(err) : resolve(key)),
        );
    });
}

function subkey(secret: Buffer, label: string): Buffer {
    return createHmac('sha256', secret).update(label).digest();
}

/**
 * Encrypted framing over an authenticated socket. `sendLabel` and
 * `receiveLabel` pick the per-direction keys.
 */
class EncryptedChannel<In, Out> implements MessageChannel<In, Out> {
    private sendCounter = 0n;
    private receiveCounter = 0n;
    private readonly sendKey: Buffer;
    private readonly receiveKey: Buffer;
    private readonly messageListeners: ((message: In) => void)[] = [];
    /** Messages that arrived before anyone listened, delivered to the first listener. */
    private unheard: In[] = [];
    private readonly closeListeners: ((reason: string) => void)[] = [];
    private closed = false;

    constructor(
        private readonly socket: Socket,
        secret: Buffer,
        sendLabel: string,
        receiveLabel: string,
        reader: FrameReader,
        leftover: Buffer[],
    ) {
        this.sendKey = subkey(secret, sendLabel);
        this.receiveKey = subkey(secret, receiveLabel);
        socket.on('data', (chunk: Buffer) => this.receive(reader, chunk));
        socket.on('close', () => this.finish('Connection closed'));
        socket.on('error', (err) => this.finish(err.message));
        for (const frame of leftover) {
            this.deliver(frame);
        }
    }

    send(message: Out): void {
        if (this.closed) {
            return;
        }
        const iv = Buffer.alloc(12);
        iv.writeBigUInt64BE(this.sendCounter++, 4);
        const cipher = createCipheriv('aes-256-gcm', this.sendKey, iv);
        const body = Buffer.concat([
            cipher.update(JSON.stringify(message), 'utf8'),
            cipher.final(),
        ]);
        this.socket.write(
            encodeFrame(Buffer.concat([body, cipher.getAuthTag()])),
        );
    }

    onMessage(listener: (message: In) => void): void {
        this.messageListeners.push(listener);
        const unheard = this.unheard;
        this.unheard = [];
        for (const message of unheard) {
            listener(message);
        }
    }

    onClose(listener: (reason: string) => void): void {
        this.closeListeners.push(listener);
    }

    close(reason = 'Closed'): void {
        this.socket.end();
        this.finish(reason);
    }

    private receive(reader: FrameReader, chunk: Buffer): void {
        let frames: Buffer[];
        try {
            frames = reader.push(chunk);
        } catch (err) {
            this.fail(err);
            return;
        }
        for (const frame of frames) {
            this.deliver(frame);
        }
    }

    private deliver(frame: Buffer): void {
        if (this.closed) {
            return;
        }
        let message: In;
        try {
            const iv = Buffer.alloc(12);
            iv.writeBigUInt64BE(this.receiveCounter++, 4);
            const decipher = createDecipheriv(
                'aes-256-gcm',
                this.receiveKey,
                iv,
            );
            decipher.setAuthTag(frame.subarray(frame.length - 16));
            const plain = Buffer.concat([
                decipher.update(frame.subarray(0, frame.length - 16)),
                decipher.final(),
            ]);
            message = JSON.parse(plain.toString('utf8')) as In;
        } catch (err) {
            this.fail(err);
            return;
        }
        if (this.messageListeners.length === 0) {
            this.unheard.push(message);
        }
        for (const listener of this.messageListeners) {
            listener(message);
        }
    }

    private fail(err: unknown): void {
        const reason = err instanceof Error ? err.message : String(err);
        this.socket.destroy();
        this.finish(reason);
    }

    private finish(reason: string): void {
        if (this.closed) {
            return;
        }
        this.closed = true;
        for (const listener of this.closeListeners) {
            listener(reason);
        }
    }
}

/**
 * Read plain JSON handshake frames from `socket` until `accept` returns a
 * value. Frames after the accepted one stay in the returned reader's
 * leftovers for the encrypted channel.
 */
function readHandshake<T>(
    socket: Socket,
    accept: (frame: unknown) => T | undefined,
): Promise<{ value: T; reader: FrameReader; leftover: Buffer[] }> {
    return new Promise((resolve, reject) => {
        const reader = new FrameReader();
        const timer = setTimeout(
            () => finish(new Error('Handshake timed out')),
            HANDSHAKE_TIMEOUT_MS,
        );
        const finish = (
            result: Error | { value: T; leftover: Buffer[] },
        ): void => {
            clearTimeout(timer);
            socket.off('data', onData);
            socket.off('close', onClose);
            socket.off('error', onError);
            if (result instanceof Error) {
                reject(result);
            } else {
                resolve({ ...result, reader });
            }
        };
        const onData = (chunk: Buffer): void => {
            let frames: Buffer[];
            try {
                frames = reader.push(chunk);
            } catch (err) {
                finish(err as Error);
                return;
            }
            for (let i = 0; i < frames.length; i++) {
                let parsed: unknown;
                try {
                    parsed = JSON.parse(frames[i].toString('utf8'));
                } catch {
                    finish(new Error('Malformed handshake'));
                    return;
                }
                const value = accept(parsed);
                if (value !== undefined) {
                    finish({ leftover: frames.slice(i + 1), value });
                    return;
                }
            }
        };
        const onClose = (): void =>
            finish(new Error('Connection closed during handshake'));
        const onError = (err: Error): void => finish(err);
        socket.on('data', onData);
        socket.on('close', onClose);
        socket.on('error', onError);
    });
}

function sendPlain(socket: Socket, frame: object): void {
    socket.write(encodeFrame(Buffer.from(JSON.stringify(frame), 'utf8')));
}

function isFrame<T extends { t: string }>(
    frame: unknown,
    t: T['t'],
): frame is T {
    return (
        typeof frame === 'object' &&
        frame !== null &&
        (frame as { t?: unknown }).t === t
    );
}

/**
 * Host side of the handshake on an accepted socket. Resolves with the
 * guest's introduction and the open channel, or rejects (closing the
 * socket) when the guest's proof does not match `code`.
 */
export async function acceptGuest<In, Out>(
    socket: Socket,
    code: string,
    hostName: string,
): Promise<{ guest: GuestIntroduction; channel: MessageChannel<In, Out> }> {
    const hostNonce = randomBytes(NONCE_BYTES);
    const handshake = readHandshake(socket, (frame) =>
        isFrame<HelloFrame>(frame, 'hello') ? frame : undefined,
    );
    const challenge: ChallengeFrame = {
        hostName,
        hostNonce: hostNonce.toString('base64'),
        t: 'challenge',
        v: PROTOCOL_VERSION,
    };
    sendPlain(socket, challenge);
    try {
        const { value: hello, reader, leftover } = await handshake;
        if (hello.v !== PROTOCOL_VERSION) {
            throw new Error(
                'This session runs a different version of Shoreline',
            );
        }
        const clientNonce = Buffer.from(hello.clientNonce, 'base64');
        const secret = await deriveSecret(code, hostNonce, clientNonce);
        const expected = subkey(secret, 'guest-proof');
        const mac = Buffer.from(hello.mac, 'base64');
        if (
            clientNonce.length !== NONCE_BYTES ||
            mac.length !== expected.length ||
            !timingSafeEqual(mac, expected)
        ) {
            throw new Error('Wrong pairing code');
        }
        const channel = new EncryptedChannel<In, Out>(
            socket,
            secret,
            'host-to-guest',
            'guest-to-host',
            reader,
            leftover,
        );
        return {
            channel,
            guest: { name: String(hello.name).slice(0, 64) },
        };
    } catch (err) {
        const reject: RejectFrame = {
            reason: (err as Error).message,
            t: 'reject',
        };
        if (!socket.destroyed) {
            sendPlain(socket, reject);
            socket.end();
        }
        throw err;
    }
}

/**
 * Guest side of the handshake on a connected socket. A wrong code shows up
 * as the host rejecting the guest, or as the first encrypted frame failing
 * to decrypt.
 */
export async function joinHost<In, Out>(
    socket: Socket,
    code: string,
    name: string,
): Promise<{ hostName: string; channel: MessageChannel<In, Out> }> {
    const { value: challenge } = await readHandshake(socket, (frame) => {
        if (isFrame<RejectFrame>(frame, 'reject')) {
            throw new Error(frame.reason);
        }
        return isFrame<ChallengeFrame>(frame, 'challenge') ? frame : undefined;
    });
    if (challenge.v !== PROTOCOL_VERSION) {
        socket.destroy();
        throw new Error('This session runs a different version of Shoreline');
    }
    const clientNonce = randomBytes(NONCE_BYTES);
    const secret = await deriveSecret(
        code,
        Buffer.from(challenge.hostNonce, 'base64'),
        clientNonce,
    );
    const answer = readHandshakeAfterHello(socket);
    const hello: HelloFrame = {
        clientNonce: clientNonce.toString('base64'),
        mac: subkey(secret, 'guest-proof').toString('base64'),
        name,
        t: 'hello',
        v: PROTOCOL_VERSION,
    };
    sendPlain(socket, hello);
    const { reader, leftover } = await answer;
    return {
        channel: new EncryptedChannel<In, Out>(
            socket,
            secret,
            'guest-to-host',
            'host-to-guest',
            reader,
            leftover,
        ),
        hostName: String(challenge.hostName).slice(0, 64),
    };
}

/**
 * After the hello, the host either rejects in plain JSON or starts the
 * encrypted channel. The first frame decides: a plain reject frame fails the
 * join, anything else is encrypted and goes to the channel.
 */
function readHandshakeAfterHello(
    socket: Socket,
): Promise<{ reader: FrameReader; leftover: Buffer[] }> {
    return new Promise((resolve, reject) => {
        const reader = new FrameReader();
        const timer = setTimeout(
            () => finish(new Error('Handshake timed out')),
            HANDSHAKE_TIMEOUT_MS,
        );
        const finish = (result: Error | Buffer[]): void => {
            clearTimeout(timer);
            socket.off('data', onData);
            socket.off('close', onClose);
            socket.off('error', onError);
            if (result instanceof Error) {
                socket.destroy();
                reject(result);
            } else {
                resolve({ leftover: result, reader });
            }
        };
        const onData = (chunk: Buffer): void => {
            let frames: Buffer[];
            try {
                frames = reader.push(chunk);
            } catch (err) {
                finish(err as Error);
                return;
            }
            if (frames.length === 0) {
                return;
            }
            const rejectFrame = parseReject(frames[0]);
            if (rejectFrame) {
                finish(new Error(rejectFrame.reason));
            } else {
                finish(frames);
            }
        };
        const onClose = (): void =>
            finish(new Error('The host closed the connection'));
        const onError = (err: Error): void => finish(err);
        socket.on('data', onData);
        socket.on('close', onClose);
        socket.on('error', onError);
    });
}

function parseReject(frame: Buffer): RejectFrame | null {
    try {
        const parsed: unknown = JSON.parse(frame.toString('utf8'));
        return isFrame<RejectFrame>(parsed, 'reject') ? parsed : null;
    } catch {
        return null;
    }
}
