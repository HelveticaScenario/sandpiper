/** Cursor colors for session peers, distinct on dark and light themes. */
const PEER_COLORS = [
    '#4f9dff',
    '#ff7a59',
    '#3fcf8e',
    '#d77dff',
    '#ffc23d',
    '#2fd0d8',
    '#ff5c9a',
    '#a3d94c',
];

export function peerColor(index: number): string {
    return PEER_COLORS[index % PEER_COLORS.length];
}
