import { useEffect, useRef, useState } from 'react';
import electronAPI from '../electronAPI';
import type {
    DiscoveredSession,
    LiveShareStatus,
} from '../../shared/liveShare';
import { useLiveShareStatus } from '../hooks/useLiveShareStatus';
import './LiveShareModal.css';

interface LiveShareModalProps {
    isOpen: boolean;
    onClose: () => void;
}

/** Hosting a live share session, or joining one on the local network. */
export function LiveShareModal({ isOpen, onClose }: LiveShareModalProps) {
    const panelRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (!isOpen) return;
        const rafId = requestAnimationFrame(() => panelRef.current?.focus());
        const onKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape') onClose();
        };
        window.addEventListener('keydown', onKeyDown);
        return () => {
            cancelAnimationFrame(rafId);
            window.removeEventListener('keydown', onKeyDown);
        };
    }, [isOpen, onClose]);

    if (!isOpen) return null;

    return (
        <div className="live-share-overlay" onClick={onClose}>
            <div
                className="live-share-modal"
                ref={panelRef}
                tabIndex={-1}
                onClick={(e) => e.stopPropagation()}
            >
                <div className="live-share-header">
                    <h2>Live Share</h2>
                    <button
                        className="live-share-close-btn"
                        onClick={onClose}
                        aria-label="Close"
                    >
                        ×
                    </button>
                </div>
                <LiveSharePanel />
            </div>
        </div>
    );
}

function LiveSharePanel() {
    const status = useLiveShareStatus();
    const [error, setError] = useState<string | null>(null);

    const attempt = (action: () => Promise<unknown>) => {
        setError(null);
        action().catch((err: unknown) =>
            setError(err instanceof Error ? err.message : String(err)),
        );
    };

    return (
        <div className="live-share-panel">
            {status.role === 'idle' && (
                <IdleView
                    onHost={() => attempt(() => electronAPI.liveShare.host())}
                    onJoin={(session, pairingCode) =>
                        attempt(() =>
                            electronAPI.liveShare.join({
                                address: session.address,
                                pairingCode,
                                port: session.port,
                            }),
                        )
                    }
                />
            )}
            {status.role === 'joining' && (
                <p className="live-share-note">Joining {status.hostName}…</p>
            )}
            {(status.role === 'host' || status.role === 'guest') && (
                <SessionView
                    status={status}
                    onLeave={() => attempt(() => electronAPI.liveShare.leave())}
                />
            )}
            {error && <p className="live-share-error">{error}</p>}
        </div>
    );
}

function IdleView({
    onHost,
    onJoin,
}: {
    onHost: () => void;
    onJoin: (session: DiscoveredSession, pairingCode: string) => void;
}) {
    const [sessions, setSessions] = useState<DiscoveredSession[]>([]);
    const [manual, setManual] = useState('');
    const [selected, setSelected] = useState<string | null>(null);
    const [code, setCode] = useState('');

    useEffect(() => {
        const off = electronAPI.liveShare.onDiscovered(setSessions);
        void electronAPI.liveShare.browse();
        return () => {
            off();
            void electronAPI.liveShare.stopBrowsing();
        };
    }, []);

    const target = (): DiscoveredSession | null => {
        const found = sessions.find((s) => s.id === selected);
        if (found) {
            return found;
        }
        const match = /^\s*([^\s:]+):(\d+)\s*$/.exec(manual);
        return match
            ? {
                  address: match[1],
                  hostName: match[1],
                  id: manual,
                  port: Number(match[2]),
              }
            : null;
    };
    const joinTarget = target();

    return (
        <>
            <section className="live-share-section">
                <h3>Host</h3>
                <p className="live-share-note">
                    Share this session with people on your network.
                </p>
                <button className="live-share-button" onClick={onHost}>
                    Start Session
                </button>
            </section>
            <section className="live-share-section">
                <h3>Join</h3>
                {sessions.length === 0 ? (
                    <p className="live-share-note">
                        Looking for sessions on your network…
                    </p>
                ) : (
                    <ul className="live-share-list">
                        {sessions.map((s) => (
                            <li key={s.id}>
                                <button
                                    className={`live-share-session ${selected === s.id ? 'selected' : ''}`}
                                    onClick={() => setSelected(s.id)}
                                >
                                    {s.hostName}
                                </button>
                            </li>
                        ))}
                    </ul>
                )}
                <input
                    className="live-share-input"
                    placeholder="or address:port"
                    value={manual}
                    onChange={(e) => {
                        setManual(e.target.value);
                        setSelected(null);
                    }}
                />
                <input
                    className="live-share-input"
                    placeholder="Pairing code"
                    value={code}
                    onChange={(e) => setCode(e.target.value)}
                />
                <button
                    className="live-share-button"
                    disabled={!joinTarget || code.trim() === ''}
                    onClick={() => joinTarget && onJoin(joinTarget, code)}
                >
                    Join
                </button>
            </section>
        </>
    );
}

function SessionView({
    status,
    onLeave,
}: {
    status: Extract<LiveShareStatus, { role: 'host' | 'guest' }>;
    onLeave: () => void;
}) {
    return (
        <>
            {status.role === 'host' ? (
                <section className="live-share-section">
                    <h3>Hosting</h3>
                    <p className="live-share-note">Pairing code</p>
                    <CopyText
                        className="live-share-code"
                        text={status.pairingCode}
                    />
                    <p className="live-share-note">Address</p>
                    {status.addresses.map((a) => (
                        <CopyText
                            key={a}
                            className="live-share-address"
                            text={`${a}:${status.port}`}
                        />
                    ))}
                </section>
            ) : (
                <section className="live-share-section">
                    <h3>Joined {status.hostName}</h3>
                    <p className="live-share-note">
                        {status.clockSynced
                            ? 'In time with the session'
                            : 'Syncing clock over Link…'}
                    </p>
                </section>
            )}
            <section className="live-share-section">
                <h3>People</h3>
                <ul className="live-share-list">
                    {status.peers.map((peer) => (
                        <li key={peer.id} className="live-share-peer">
                            <span
                                className="live-share-swatch"
                                style={{ background: peer.color }}
                            />
                            {peer.name}
                            {peer.id === status.selfId && ' (you)'}
                            {peer.isHost && ' · host'}
                        </li>
                    ))}
                </ul>
            </section>
            <button className="live-share-button" onClick={onLeave}>
                {status.role === 'host' ? 'End Session' : 'Leave Session'}
            </button>
        </>
    );
}

/** How long a copied value says so. */
const COPIED_MS = 1_200;

/** A value that copies itself to the clipboard when clicked. */
function CopyText({ text, className }: { text: string; className: string }) {
    const [copied, setCopied] = useState(false);

    useEffect(() => {
        if (!copied) return;
        const timer = setTimeout(() => setCopied(false), COPIED_MS);
        return () => clearTimeout(timer);
    }, [copied]);

    return (
        <button
            className={`live-share-copy ${className}${copied ? ' copied' : ''}`}
            title="Click to copy"
            onClick={() => {
                void electronAPI.clipboard
                    .writeText(text)
                    .then(() => setCopied(true));
            }}
        >
            <span className="live-share-copy-text">{text}</span>
            <span className="live-share-copy-hint">
                {copied ? 'Copied' : 'Copy'}
            </span>
        </button>
    );
}
