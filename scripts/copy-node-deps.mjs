// Copies runtime npm packages the Vite main bundle leaves external (native
// addons that load prebuilt binaries from their own package directory) into a
// packaged app, with their full production dependency closure. Each package
// lands at the same path relative to node_modules that it has in the repo, so
// nested versions resolve exactly as they do in development.

import * as fs from 'fs';
import * as path from 'path';

function resolvePackageDir(name, fromDir, repoRoot) {
    let dir = fromDir;
    for (;;) {
        const candidate = path.join(dir, 'node_modules', name);
        if (fs.existsSync(path.join(candidate, 'package.json'))) {
            return candidate;
        }
        if (dir === repoRoot) {
            return null;
        }
        const parent = path.dirname(dir);
        if (parent === dir) {
            return null;
        }
        dir = parent;
    }
}

/** Every package directory `roots` need at runtime, keyed by absolute path. */
export function collectDependencyClosure(roots, repoRoot) {
    const found = new Set();
    const queue = roots.map((name) => ({ from: repoRoot, name, optional: false }));
    while (queue.length > 0) {
        const { name, from, optional } = queue.shift();
        const dir = resolvePackageDir(name, from, repoRoot);
        if (!dir) {
            if (optional) {
                continue;
            }
            throw new Error(`[copy-node-deps] cannot resolve ${name} from ${from}`);
        }
        if (found.has(dir)) {
            continue;
        }
        found.add(dir);
        const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
        for (const dep of Object.keys(pkg.dependencies ?? {})) {
            queue.push({ from: dir, name: dep, optional: false });
        }
        for (const dep of Object.keys(pkg.optionalDependencies ?? {})) {
            queue.push({ from: dir, name: dep, optional: true });
        }
    }
    return [...found];
}

/** Prebuild directory names an app for `platform`/`arch` loads. */
function keptPrebuilds(platform, arch) {
    if (platform === 'darwin' && arch === 'universal') {
        return new Set(['darwin-arm64', 'darwin-x64']);
    }
    return new Set([`${platform}-${arch}`]);
}

/**
 * Drop prebuilt binaries for other platforms and the Bare-runtime builds,
 * which Electron never loads.
 */
function prunePrebuilds(packageDir, platform, arch) {
    const prebuilds = path.join(packageDir, 'prebuilds');
    if (!fs.existsSync(prebuilds)) {
        return;
    }
    const kept = keptPrebuilds(platform, arch);
    for (const entry of fs.readdirSync(prebuilds)) {
        const entryPath = path.join(prebuilds, entry);
        if (!kept.has(entry)) {
            fs.rmSync(entryPath, { force: true, recursive: true });
            continue;
        }
        for (const file of fs.readdirSync(entryPath)) {
            if (file.endsWith('.bare')) {
                fs.rmSync(path.join(entryPath, file), { force: true });
            }
        }
    }
}

export function copyNodeDeps({ roots, repoRoot, buildPath, platform, arch }) {
    const repoModules = path.join(repoRoot, 'node_modules');
    const dirs = collectDependencyClosure(roots, repoRoot);
    for (const dir of dirs) {
        const relative = path.relative(repoModules, dir);
        if (relative.startsWith('..')) {
            throw new Error(`[copy-node-deps] ${dir} is outside ${repoModules}`);
        }
        const target = path.join(buildPath, 'node_modules', relative);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        // Nested node_modules are copied as their own closure entries, so a
        // package is copied without its nested dependencies here.
        fs.cpSync(dir, target, {
            dereference: true,
            filter: (src) => {
                const rel = path.relative(dir, src);
                return rel.split(path.sep)[0] !== 'node_modules';
            },
            recursive: true,
        });
        prunePrebuilds(target, platform, arch);
    }
    return dirs.length;
}
