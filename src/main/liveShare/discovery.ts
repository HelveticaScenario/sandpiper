/**
 * Finding live share sessions on the local network over mDNS (Bonjour).
 * A host advertises `_shoreline-share._tcp` with its session id in the TXT
 * record; guests browse for it.
 */
import { Bonjour, type Browser, type Service } from 'bonjour-service';
import { isIPv4 } from 'net';
import type { DiscoveredSession } from '../../shared/liveShare';
import { PROTOCOL_VERSION } from './secureChannel';

/** Declared in NSBonjourServices (forge.config.ts) for macOS. */
const SERVICE_TYPE = 'shoreline-share';

/**
 * How often a browser asks again. Multicast over Wi-Fi drops packets, and a
 * lost query or announcement otherwise hides a session until the next one.
 */
const REQUERY_MS = 3_000;

let bonjour: Bonjour | null = null;

function shared(): Bonjour {
    bonjour ??= new Bonjour();
    return bonjour;
}

/** Advertise a hosted session until the returned function is called. */
export function advertiseSession(
    sessionId: string,
    hostName: string,
    port: number,
): () => void {
    const service = shared().publish({
        // mDNS names must be unique on the network; the id keeps two hosts
        // with one display name apart.
        name: `${hostName} (${sessionId.slice(0, 6)})`,
        port,
        txt: { host: hostName, id: sessionId, v: String(PROTOCOL_VERSION) },
        type: SERVICE_TYPE,
    });
    return () => service.stop?.();
}

function toDiscovered(service: Service): DiscoveredSession | null {
    const txt = (service.txt ?? {}) as Record<string, unknown>;
    if (txt.v !== String(PROTOCOL_VERSION) || typeof txt.id !== 'string') {
        return null;
    }
    const address =
        service.addresses?.find((a) => isIPv4(a)) ?? service.referer?.address;
    if (!address) {
        return null;
    }
    return {
        address,
        hostName: typeof txt.host === 'string' ? txt.host : service.name,
        id: txt.id,
        port: service.port,
    };
}

/**
 * Browse for sessions. `onChange` receives the full list each time it
 * changes; the returned function stops browsing.
 */
export function browseSessions(
    onChange: (sessions: DiscoveredSession[]) => void,
): () => void {
    const browser: Browser = shared().find({ type: SERVICE_TYPE });
    const report = (): void => {
        const byId = new Map<string, DiscoveredSession>();
        for (const service of browser.services) {
            const found = toDiscovered(service);
            if (found) {
                byId.set(found.id, found);
            }
        }
        onChange([...byId.values()]);
    };
    browser.on('up', report);
    browser.on('down', report);
    browser.on('txt-update', report);
    browser.on('srv-update', report);
    const requery = setInterval(() => {
        browser.expire();
        browser.update();
    }, REQUERY_MS);
    return () => {
        clearInterval(requery);
        browser.stop();
    };
}
