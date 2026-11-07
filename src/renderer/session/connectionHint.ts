import type {
    SessionNat,
    SessionNetwork,
    SessionRole,
} from '../../shared/session';

/** Hole-punching failures: the peer was found but the networks between could not be crossed. */
const BLOCKED_CODES = new Set([
    'CANNOT_HOLEPUNCH',
    'HOLEPUNCH_ABORTED',
    'HOLEPUNCH_PROBE_TIMEOUT',
    'REMOTE_NOT_HOLEPUNCHABLE',
    'REMOTE_NOT_HOLEPUNCHING',
]);

function people(count: number): string {
    return count === 1 ? '1 person' : `${count} people`;
}

function failureReason(code: string): string {
    if (code === 'HOLEPUNCH_DOUBLE_RANDOMIZED_NATS') {
        return 'both of your networks are too strict for a direct connection';
    }
    if (BLOCKED_CODES.has(code)) {
        return 'a network between you blocks direct connections';
    }
    if (code === 'PEER_NOT_FOUND') {
        return 'they could no longer be found';
    }
    return code;
}

/** What a peer with nobody connected yet should know about finding the others. */
export function connectionHint(
    role: SessionRole,
    network: SessionNetwork,
): string {
    if (network.found === 0) {
        return role === 'host'
            ? 'Waiting for others to join. Send them the invite link.'
            : 'Looking for the people in this session. Check that the host still has it open.';
    }
    if (network.connecting > 0) {
        return `Found ${people(network.found)}, connecting…`;
    }
    if (network.lastError) {
        return `Found ${people(network.found)} but could not connect: ${failureReason(network.lastError)}. Retrying.`;
    }
    return `Found ${people(network.found)}, waiting for them to connect…`;
}

const NAT_LABELS: Record<SessionNat, string> = {
    checking: 'checking…',
    consistent: 'behind a standard router',
    open: 'reachable directly',
    randomized:
        'behind a strict router; can connect only to people on easier networks',
};

export function natLabel(nat: SessionNat): string {
    return `Your network: ${NAT_LABELS[nat]}`;
}
