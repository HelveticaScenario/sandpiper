import { useEffect, useState } from 'react';
import type { SessionState } from '../../shared/session';
import electronAPI from '../electronAPI';

/** The live session's state, kept current from the main process. */
export function useSessionState(): SessionState {
    const [state, setState] = useState<SessionState>({ status: 'idle' });
    useEffect(() => {
        let pushed = false;
        const unsubscribe = electronAPI.session.onState((next) => {
            pushed = true;
            setState(next);
        });
        electronAPI.session
            .getState()
            .then((initial) => {
                // A push that arrived first is newer than this reply.
                if (!pushed) {
                    setState(initial);
                }
            })
            .catch(console.error);
        return unsubscribe;
    }, []);
    return state;
}

/** The message of an error thrown in a main-process IPC handler. */
export function ipcErrorMessage(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    return message.replace(/^Error invoking remote method '[^']*': (Error: )?/, '');
}
