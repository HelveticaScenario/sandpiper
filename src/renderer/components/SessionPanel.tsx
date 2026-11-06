import React, { useEffect, useRef, useState } from 'react';
import type { SessionPeer, SessionState } from '../../shared/session';
import electronAPI from '../electronAPI';
import { connectionHint, natLabel } from '../session/connectionHint';
import { ipcErrorMessage } from '../hooks/useSessionState';
import './SessionPanel.css';

interface SessionPanelProps {
    isOpen: boolean;
    onClose: () => void;
    state: SessionState;
    /** Runs before starting a session, e.g. to save open files it will share. */
    onBeforeStart: () => Promise<void>;
}

function PeerRow({ peer, isSelf }: { peer: SessionPeer; isSelf: boolean }) {
    return (
        <li className="session-peer">
            <span
                className="session-peer-dot"
                style={{ background: peer.color }}
            />
            <span className="session-peer-name">{peer.name}</span>
            {isSelf && <span className="session-peer-you">you</span>}
        </li>
    );
}

export function SessionPanel({
    isOpen,
    onClose,
    state,
    onBeforeStart,
}: SessionPanelProps) {
    const panelRef = useRef<HTMLDivElement>(null);
    const [name, setName] = useState('');
    const [invite, setInvite] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [copied, setCopied] = useState(false);

    useEffect(() => {
        if (!isOpen) {
            return;
        }
        setError(null);
        setCopied(false);
        electronAPI.session.getName().then(setName).catch(console.error);
        const rafId = requestAnimationFrame(() => panelRef.current?.focus());
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                onClose();
            }
        };
        window.addEventListener('keydown', handleKeyDown);
        return () => {
            cancelAnimationFrame(rafId);
            window.removeEventListener('keydown', handleKeyDown);
        };
    }, [isOpen, onClose]);

    if (!isOpen) {
        return null;
    }

    const run = async (action: () => Promise<unknown>) => {
        setBusy(true);
        setError(null);
        try {
            await action();
        } catch (e) {
            setError(ipcErrorMessage(e));
        } finally {
            setBusy(false);
        }
    };

    const copyInvite = async () => {
        if (await electronAPI.session.copyInvite()) {
            setCopied(true);
        }
    };

    return (
        <div className="session-overlay" onClick={onClose}>
            <div
                className="session-panel"
                ref={panelRef}
                tabIndex={-1}
                onClick={(e) => e.stopPropagation()}
            >
                <div className="session-header">
                    <h2>Live Session</h2>
                    <button
                        className="session-close-btn"
                        onClick={onClose}
                        aria-label="Close"
                    >
                        ×
                    </button>
                </div>
                <div className="session-body">
                    {state.status === 'idle' ? (
                        <>
                            <p className="session-warning">
                                Everyone in a session can run code on everyone
                                else’s computer. Only start or join sessions
                                with people you trust.
                            </p>
                            <label className="session-field">
                                <span>Your name</span>
                                <input
                                    value={name}
                                    maxLength={40}
                                    onChange={(e) => setName(e.target.value)}
                                    disabled={busy}
                                />
                            </label>
                            <button
                                className="session-primary"
                                disabled={busy}
                                onClick={() =>
                                    run(async () => {
                                        await onBeforeStart();
                                        await electronAPI.session.start(name);
                                    })
                                }
                            >
                                Start a session
                            </button>
                            <div className="session-divider">
                                or join one
                            </div>
                            <form
                                className="session-join"
                                onSubmit={(e) => {
                                    e.preventDefault();
                                    void run(() =>
                                        electronAPI.session.join(invite, name),
                                    );
                                }}
                            >
                                <input
                                    placeholder="shoreline://join/…"
                                    value={invite}
                                    onChange={(e) => setInvite(e.target.value)}
                                    disabled={busy}
                                    spellCheck={false}
                                />
                                <button
                                    type="submit"
                                    disabled={busy || invite.trim() === ''}
                                >
                                    Join
                                </button>
                            </form>
                        </>
                    ) : (
                        <>
                            <div className="session-field">
                                <span>Invite link</span>
                                <div className="session-invite">
                                    <input
                                        readOnly
                                        value={state.invite}
                                        onFocus={(e) => e.target.select()}
                                    />
                                    <button onClick={copyInvite}>
                                        {copied ? 'Copied' : 'Copy'}
                                    </button>
                                </div>
                            </div>
                            <div className="session-field">
                                <span>People</span>
                                <ul className="session-peers">
                                    <PeerRow peer={state.self} isSelf />
                                    {state.peers.map((peer) => (
                                        <PeerRow
                                            key={peer.id}
                                            peer={peer}
                                            isSelf={false}
                                        />
                                    ))}
                                </ul>
                                {state.peers.length === 0 && (
                                    <>
                                        <p className="session-hint">
                                            {connectionHint(
                                                state.role,
                                                state.network,
                                            )}
                                        </p>
                                        <p className="session-hint">
                                            {natLabel(state.network.nat)}
                                        </p>
                                    </>
                                )}
                            </div>
                            {state.notices.length > 0 && (
                                <ul className="session-notices">
                                    {state.notices.map((notice) => (
                                        <li key={notice.id}>{notice.message}</li>
                                    ))}
                                </ul>
                            )}
                            <button
                                className="session-leave"
                                disabled={busy}
                                onClick={() =>
                                    run(() => electronAPI.session.leave())
                                }
                            >
                                Leave session
                            </button>
                        </>
                    )}
                    {error && <p className="session-error">{error}</p>}
                </div>
            </div>
        </div>
    );
}

/** The latest patch change in a live session, for the header. */
export interface SessionActivity {
    author: SessionPeer;
    /** The song bar (counting from 1, as the transport shows it) the change plays on. */
    songBar: number;
    /** Distinguishes repeated changes by the same author on the same bar. */
    id: number;
}

/** How long a patch change stays announced in the header. */
const ACTIVITY_MS = 4000;

/**
 * Header button that opens the session panel, shows who is connected, and
 * briefly names whoever last changed the patch and the bar it plays on.
 */
export function SessionButton({
    state,
    onOpen,
    activity,
}: {
    state: SessionState;
    onOpen: () => void;
    activity: SessionActivity | null;
}) {
    const [expiredId, setExpiredId] = useState<number | null>(null);
    useEffect(() => {
        if (!activity) {
            return;
        }
        const timer = setTimeout(() => setExpiredId(activity.id), ACTIVITY_MS);
        return () => clearTimeout(timer);
    }, [activity]);
    const shown = activity && activity.id !== expiredId ? activity : null;

    if (state.status === 'idle') {
        return (
            <button
                className="session-button"
                onClick={onOpen}
                title="Start or join a live session"
            >
                Session
            </button>
        );
    }
    const people = [state.self, ...state.peers];
    return (
        <button
            className="session-button session-button-active"
            onClick={onOpen}
            title={people.map((p) => p.name).join(', ')}
        >
            {shown && (
                <span
                    className="session-activity"
                    style={{ color: shown.author.color }}
                >
                    {shown.author.id === state.self.id
                        ? 'You'
                        : shown.author.name}{' '}
                    → bar {shown.songBar}
                </span>
            )}
            {people.map((peer) => (
                <span
                    key={peer.id}
                    className="session-peer-dot"
                    style={{ background: peer.color }}
                />
            ))}
            <span>{people.length === 1 ? 'Waiting…' : `${people.length}`}</span>
        </button>
    );
}
