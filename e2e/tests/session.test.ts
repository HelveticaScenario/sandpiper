/**
 * Live session end-to-end: two app instances share a workspace over a local
 * Hyperswarm DHT (MODULAR_SESSION_BOOTSTRAP), so the test never touches the
 * public network.
 */

import { test, expect, type Page } from '@playwright/test';
import { _electron as electron, type ElectronApplication } from 'playwright';
import createTestnet from 'hyperdht/testnet';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const projectRoot = path.resolve(__dirname, '..', '..');
const electronBin = require('electron') as unknown as string;
const mainEntry = path.join(projectRoot, '.vite', 'build', 'main.js');

interface Peer {
    app: ElectronApplication;
    page: Page;
    workspace: string;
    userData: string;
}

type Testnet = Awaited<ReturnType<typeof createTestnet>>;

let testnet: Testnet;
const peers: Peer[] = [];

test.beforeAll(async () => {
    testnet = await createTestnet(3);
});

test.afterAll(async () => {
    await testnet.destroy();
});

test.afterEach(async () => {
    for (const peer of peers.splice(0)) {
        await peer.app.close().catch(() => {});
        fs.rmSync(peer.workspace, { force: true, recursive: true });
        fs.rmSync(peer.userData, { force: true, recursive: true });
    }
});

async function launch(files: Record<string, string>): Promise<Peer> {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-session-ws-'));
    for (const [rel, content] of Object.entries(files)) {
        fs.mkdirSync(path.dirname(path.join(workspace, rel)), { recursive: true });
        fs.writeFileSync(path.join(workspace, rel), content);
    }
    const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-session-data-'));
    const app = await electron.launch({
        args: [mainEntry, `--user-data-dir=${userData}`],
        executablePath: electronBin,
        env: {
            ...process.env,
            E2E_TEST: '1',
            E2E_WORKSPACE: workspace,
            ELECTRON_DISABLE_GPU: '1',
            MODULAR_AUDIO_INPUT_DEVICE:
                process.env.MODULAR_AUDIO_INPUT_DEVICE ??
                'coreaudio:BlackHole64ch_UID',
            MODULAR_AUDIO_OUTPUT_DEVICE:
                process.env.MODULAR_AUDIO_OUTPUT_DEVICE ??
                'coreaudio:BlackHole64ch_UID',
            MODULAR_BACKGROUND_LAUNCH: process.env.MODULAR_BACKGROUND_LAUNCH ?? '1',
            MODULAR_SESSION_BOOTSTRAP: testnet.bootstrap
                .map((node) => `${node.host}:${node.port}`)
                .join(','),
            NODE_ENV: 'test',
        },
    });
    const page = await app.firstWindow();
    await page.waitForLoadState('domcontentloaded');
    const peer = { app, page, userData, workspace };
    peers.push(peer);
    return peer;
}

async function startSession(peer: Page, name: string): Promise<string> {
    await peer.getByRole('button', { name: 'Session' }).click();
    await peer.locator('.session-field input').first().fill(name);
    await peer.getByText('Start a session').click();
    const invite = peer.locator('.session-invite input');
    await invite.waitFor();
    const value = await invite.inputValue();
    await peer.keyboard.press('Escape');
    return value;
}

async function joinSession(peer: Page, invite: string, name: string): Promise<void> {
    await peer.getByRole('button', { name: 'Session' }).click();
    await peer.locator('.session-field input').first().fill(name);
    await peer.locator('.session-join input').fill(invite);
    await peer.getByRole('button', { name: 'Join' }).click();
    await peer.locator('.session-invite input').waitFor();
    await peer.keyboard.press('Escape');
}

function treeFile(peer: Page, name: string) {
    return peer.locator('.tree-file .file-name').getByText(name, { exact: true });
}

async function openFile(peer: Page, name: string): Promise<void> {
    await treeFile(peer, name).dblclick();
    await peer.waitForSelector('.monaco-editor');
}

/** The text of the visible editor's model. */
function editorText(peer: Page): Promise<string> {
    return peer.evaluate(() => {
        const editor = (window as any).monaco.editor
            .getEditors()
            .find((e: any) => e.getModel()?.getLanguageId() === 'javascript');
        return editor?.getModel()?.getValue() ?? '';
    });
}

/** Type at a model offset the way a keystroke would. */
function typeAt(peer: Page, offset: number, text: string): Promise<void> {
    return peer.evaluate(
        ({ offset, text }) => {
            const editor = (window as any).monaco.editor
                .getEditors()
                .find((e: any) => e.getModel()?.getLanguageId() === 'javascript');
            const model = editor.getModel();
            const pos = model.getPositionAt(offset < 0 ? model.getValueLength() : offset);
            editor.setPosition(pos);
            editor.focus();
            editor.trigger('keyboard', 'type', { text });
        },
        { offset, text },
    );
}

function undo(peer: Page): Promise<void> {
    return peer.evaluate(() => {
        const editor = (window as any).monaco.editor
            .getEditors()
            .find((e: any) => e.getModel()?.getLanguageId() === 'javascript');
        editor.focus();
        editor.trigger('keyboard', 'undo', null);
    });
}

function workspaceOf(peer: Page): Promise<string> {
    return peer.evaluate(async () => {
        const ws = await (window as any).electronAPI.filesystem.getWorkspace();
        return ws.path as string;
    });
}

async function eventually(check: () => boolean | Promise<boolean>, timeout = 20_000) {
    await expect.poll(check, { timeout }).toBe(true);
}

test.describe('live session', () => {
    test.setTimeout(180_000);

    test('two peers share files, edits, cursors and file operations', async () => {
        const host = await launch({
            'patch.js': '$sine("C4").out()\n',
            'songs/verse.js': '// verse\n',
            'wavs/kick.wav': 'RIFF',
        });
        const guest = await launch({ 'unrelated.js': 'guest only\n' });

        const invite = await startSession(host.page, 'Ada');
        await joinSession(guest.page, invite, 'Bo');

        // The guest moves into a session folder that fills with the host's
        // shareable files.
        const guestRoot = await workspaceOf(guest.page);
        expect(guestRoot).not.toBe(guest.workspace);
        await eventually(() => fs.existsSync(path.join(guestRoot, 'songs/verse.js')));
        expect(fs.readFileSync(path.join(guestRoot, 'patch.js'), 'utf8')).toContain(
            '$sine("C4").out()',
        );
        await expect(treeFile(guest.page, 'patch.js')).toBeVisible();

        // Both open the same file and edit it live.
        await openFile(host.page, 'patch.js');
        await openFile(guest.page, 'patch.js');
        await eventually(async () => (await editorText(guest.page)).startsWith('$sine'));
        // A double-click opens one buffer, not one per click.
        await expect(
            guest.page.locator('.file-list .file-name').getByText('patch.js', { exact: true }),
        ).toHaveCount(1);

        await typeAt(host.page, -1, '// from Ada\n');
        await eventually(async () => (await editorText(guest.page)).includes('// from Ada'));
        await typeAt(guest.page, 0, '// from Bo\n');
        await eventually(async () => (await editorText(host.page)).startsWith('// from Bo'));
        expect(await editorText(host.page)).toBe(await editorText(guest.page));

        // Edits reach the host's folder on disk.
        await eventually(() =>
            fs.readFileSync(path.join(host.workspace, 'patch.js'), 'utf8').includes('// from Bo'),
        );

        // Each sees the other's cursor, labelled with their name.
        await eventually(
            async () => (await guest.page.locator('.yRemoteSelectionHead').count()) > 0,
        );
        const label = await guest.page.evaluate(() => {
            const head = document.querySelector('.yRemoteSelectionHead');
            return head ? getComputedStyle(head, '::after').content : '';
        });
        expect(label).toContain('Ada');

        // Undo only takes back your own edit.
        await typeAt(guest.page, 0, 'X');
        await typeAt(host.page, -1, 'Y');
        await eventually(async () => (await editorText(guest.page)).endsWith('Y'));
        await undo(guest.page);
        await eventually(async () => !(await editorText(host.page)).startsWith('X'));
        expect(await editorText(host.page)).toMatch(/Y$/);
        expect(await editorText(guest.page)).toBe(await editorText(host.page));

        // Shared buffers never show as unsaved.
        await expect(host.page.locator('.dirty-dot')).toHaveCount(0);
        await expect(guest.page.locator('.dirty-dot')).toHaveCount(0);

        // A file another program creates on the host reaches the guest.
        fs.writeFileSync(path.join(host.workspace, 'chorus.js'), '// chorus\n');
        await eventually(() => fs.existsSync(path.join(guestRoot, 'chorus.js')));

        // The guest renames and deletes; the host's disk follows.
        await guest.page.evaluate(async (root) => {
            const fsApi = (window as any).electronAPI.filesystem;
            await fsApi.renameFile(`${root}/songs/verse.js`, `${root}/songs/bridge.js`);
            await fsApi.deleteFile(`${root}/chorus.js`);
        }, guestRoot);
        await eventually(() => fs.existsSync(path.join(host.workspace, 'songs/bridge.js')));
        expect(fs.existsSync(path.join(host.workspace, 'songs/verse.js'))).toBe(false);
        await eventually(() => !fs.existsSync(path.join(host.workspace, 'chorus.js')));

        // Audio stays local to the host until assets sync.
        expect(fs.existsSync(path.join(guestRoot, 'wavs/kick.wav'))).toBe(false);

        // The guest leaves: the host is alone again, and the guest keeps the
        // session folder.
        await guest.page.getByRole('button', { name: /2/ }).click();
        await guest.page.getByText('Leave session').click();
        await host.page.getByRole('button', { name: /Waiting/ }).waitFor();
        expect(fs.existsSync(path.join(guestRoot, 'patch.js'))).toBe(true);
    });

    test('a peer that joins late gets the current text and the open buffer follows a remote rename', async () => {
        const host = await launch({ 'live.js': 'start\n' });
        const invite = await startSession(host.page, 'Ada');
        await openFile(host.page, 'live.js');
        await typeAt(host.page, -1, 'edited before anyone joined\n');

        const guest = await launch({});
        await joinSession(guest.page, invite, 'Bo');
        const guestRoot = await workspaceOf(guest.page);
        await eventually(() => fs.existsSync(path.join(guestRoot, 'live.js')));
        await openFile(guest.page, 'live.js');
        await eventually(async () =>
            (await editorText(guest.page)).includes('edited before anyone joined'),
        );

        // The host renames the file the guest has open.
        await host.page.evaluate(async (root) => {
            await (window as any).electronAPI.filesystem.renameFile(
                `${root}/live.js`,
                `${root}/renamed.js`,
            );
        }, host.workspace);
        await expect(treeFile(guest.page, 'renamed.js')).toBeVisible({
            timeout: 20_000,
        });
        // The guest's buffer follows the file and keeps editing it live.
        await typeAt(guest.page, 0, '// still live\n');
        await eventually(() =>
            fs
                .readFileSync(path.join(host.workspace, 'renamed.js'), 'utf8')
                .includes('// still live'),
        );
    });
});
