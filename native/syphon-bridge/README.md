# shoreline-syphon

A headless macOS companion that captures the Shoreline window with
**ScreenCaptureKit** and republishes it as a **Syphon** source, so the live
patch view can be pulled into Resolume, VDMX, MadMapper, TouchDesigner, Isadora,
etc. Shoreline launches and stops it from the **View → Toggle Syphon Output**
menu item.

Requires **macOS 14+** (ScreenCaptureKit window capture + the helper's deployment
target); on older systems the menu item is hidden rather than crash-looping a
helper that can't launch.

## How it works

1. Shoreline's main process reads the window's `CGWindowID` from
   `BrowserWindow.getMediaSourceId()` and spawns this helper with
   `shoreline-syphon <cgWindowID> <serverName> <fps>`.
2. The helper finds that window via `SCShareableContent`, captures it with an
   `SCStream` (`SCContentFilter(desktopIndependentWindow:)`), and converts each
   IOSurface-backed frame to an `MTLTexture` zero-copy via `CVMetalTextureCache`.
3. It publishes the texture through `SyphonMetalServer` under the name
   `Shoreline`.

The helper is spawned as a plain child of Shoreline, so macOS attributes the
**Screen Recording** permission to the responsible process (Shoreline) — the user
grants "Shoreline" once. The helper exits with code 2 the first time if the grant
is missing (after triggering the prompt); Shoreline surfaces a dialog and the
user re-enables the menu item once granted.

It self-terminates if Shoreline dies (it polls `getppid()`), and Shoreline also
signals it on quit.

## Layout

```
Package.swift                      SwiftPM executable; links ScreenCaptureKit/Metal
                                   + vendored Syphon via -F/-framework + @rpath
Info.plist                         CFBundleIdentifier + LSUIElement (no Dock icon)
Sources/shoreline-syphon/
  main.swift                       arg parsing, permission flow, lifecycle, run loop
  WindowCapture.swift              ScreenCaptureKit -> zero-copy MTLTexture
  SyphonPublisher.swift            SyphonMetalServer wrapper
vendor/Syphon-Framework/           git submodule (built from source)
```

`Frameworks/`, `dist/`, and `.build/` are generated and git-ignored.

## Building

```bash
yarn build-syphon-bridge          # from the repo root
```

This builds Syphon.framework (cached per-arch after the first run), compiles the
helper, and stages `dist/MacOS/shoreline-syphon` + `dist/Frameworks/Syphon.framework`
mirroring the packaged bundle layout. It also runs automatically as part of
`yarn start` (soft, host-arch), `yarn package`, `yarn make`, and `yarn forge-publish`.

Flags:

- `--universal` (or `UNIVERSAL=1`) builds a universal (arm64 + x86_64) helper for
  distribution; the default is the host arch for fast dev iteration. `yarn make`
  and `yarn forge-publish` pass it automatically.
- `--require` turns a missing Metal Toolchain into a hard error instead of a soft
  skip (passed by `yarn package`/`make`/`forge-publish` so a release never
  silently ships without the helper).
- `SYPHON_SKIP=1` opts out of building/staging the helper entirely for a build.

### Metal Toolchain requirement

Building Syphon from source compiles a Metal shader. On **Xcode 26+** the Metal
compiler is a separately-installed component. If it's missing, install it once:

```bash
xcodebuild -downloadComponent MetalToolchain
```

`build-syphon-bridge` soft-skips (warns and continues) when the toolchain is
absent and no framework has been staged yet, so `yarn start` still works — the
Syphon menu item is simply unavailable until the helper is built. On the
packaging/release path (`--require`) that same case is a hard error instead, and
`forge.config.ts` likewise fails the build if the staged helper is missing (unless
`SYPHON_SKIP=1`), so a release never silently ships without it. The release
workflow installs the Metal Toolchain before building.

## Packaging & signing

`forge.config.ts`'s `packageAfterCopy` hook stages the helper into
`Contents/MacOS/shoreline-syphon` and Syphon.framework into `Contents/Frameworks/`,
then asserts via `lipo` that the helper covers every arch the app ships (so a
single-arch helper can't slip into a universal build). `@electron/osx-sign` then
signs both inside-out with the app's Developer ID under the hardened runtime
(re-signing Syphon with the same team so library validation passes), and the whole
bundle is notarized. The helper and framework are signed with a minimal
entitlements set (`syphon-entitlements.plist`) rather than the app's broad one,
since the helper needs no JIT/network/audio entitlements.
