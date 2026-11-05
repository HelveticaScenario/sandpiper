import { defineConfig } from 'vite';

// https://vitejs.dev/config
export default defineConfig({
    build: {
        sourcemap: true,
        rollupOptions: {
            // Native addons load prebuilt binaries relative to their own
            // package directory, so they stay out of the bundle; packaging
            // copies them in (see `copyNodeDeps` in forge.config.ts).
            external: ['@modular/core', 'hyperswarm'],
        },
    },
});
