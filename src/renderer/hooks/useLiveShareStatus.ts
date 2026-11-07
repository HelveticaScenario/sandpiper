import { useEffect, useState } from 'react';
import electronAPI from '../electronAPI';
import type { LiveShareStatus } from '../../shared/liveShare';

/** The live share session's current state, kept up to date. */
export function useLiveShareStatus(): LiveShareStatus {
    const [status, setStatus] = useState<LiveShareStatus>({ role: 'idle' });
    useEffect(() => {
        let current = true;
        const off = electronAPI.liveShare.onStatus(setStatus);
        void electronAPI.liveShare.getStatus().then((s) => {
            if (current) {
                setStatus(s);
            }
        });
        return () => {
            current = false;
            off();
        };
    }, []);
    return status;
}
