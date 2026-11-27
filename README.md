# Kladovka 🦝

**Native-feeling file manager for macOS, built with Tauri 2 + React.**
Fast, small (≈4.5 MB app), no Finder quirks, no terminal.

## Why

Finder gets in the way: no progress percentages for multi-file copies, no disk
panel, no cancel in the middle of an operation, no real keyboard workflow.
Kladovka does exactly that — and nothing it doesn't need.

## Screenshots

**Dark:**

![Kladovka dark theme](docs/screenshots/dark.png)

**Light (follows the system, overridable in Settings):**

![Kladovka light theme](docs/screenshots/light.png)

## Features

- **Disk sidebar** — all volumes (incl. external drives in `/Volumes`) with usage bars, free/total via `statvfs`
- **Clean listings** — macOS `._*` metadata companions, `System Volume Information`, `$RECYCLE.BIN`, `desktop.ini` and `Thumbs.db` are hidden (toggle *show hidden* to see them)
- **Real progress** — byte-level progress events for copy/move with a **Cancel** button per operation
- **Batch operations** — copy / move / rename / delete any selection in one action
- **Safe delete** — everything goes to the **macOS Trash** (recoverable), hard delete is an explicit choice
- **Create files** — txt, md, json, csv, py, rs, sh, html + **valid empty .docx / .xlsx** (real Office skeletons, not zero-byte files)
- **Search** — recursive name search with depth/count limits, non-blocking
- **Navigation** — breadcrumb path bar, back/forward history, symlink resolution
- **Sortable columns** — click Name / Size / Modified to sort, click again to reverse (folders always first, natural order: `file2` before `file10`)
- **Keyboard-first** — `↑↓` navigate, `Enter` open, `⌘C/⌘X/⌘V` clipboard, `F2` rename, `A` select all, `⌫` back
- **Context menu** — right-click for open / rename / copy / move / trash
- **Drag & drop** — drop files from Finder into Kladovka to copy them in
- **Light & dark theme** — follows the system, with a manual override in Settings
- **i18n** — Russian / English with auto-detection (⚙ in the toolbar)

## Tech

| Layer | Choice |
|---|---|
| Shell | Tauri 2 (Rust) |
| UI | React 19 + TypeScript + Vite |
| FS ops | `spawn_blocking` + progress events — UI never freezes on big copies |
| State | atomic swaps, no UI-blocking locks |
| Trash | native, via Finder (`osascript`) |

Rust commands: `list_dir`, `copy_paths`, `move_paths`, `trash_paths`,
`delete_paths`, `rename_path`, `create_dir`, `create_file`, `search_tree`,
`disk_info`, `cancel_op`, `open_path`, `reveal_path`.

## Install

Grab the latest **DMG** from [Releases](https://github.com/alexorlovss47-jpg/kladovka/releases/latest),
open it and drag Kladovka into Applications.

Requires macOS 10.13+ on Apple Silicon (arm64).

> The build is ad-hoc signed, not notarized by Apple. On first launch macOS will
> block it — right-click the app → **Open** → **Open**, or run
> `xattr -dr com.apple.quarantine /Applications/Kladovka.app`.

## Build from source

Requirements: macOS, [Rust](https://rustup.rs), [pnpm](https://pnpm.io).

```bash
pnpm install
pnpm tauri build        # → src-tauri/target/release/bundle/dmg/
```

To release a new version:

```bash
# 1. bump "version" in package.json, src-tauri/Cargo.toml, src-tauri/tauri.conf.json
# 2. commit and push
git tag v0.1.2 && git push origin v0.1.2
```

Pushing a `v*` tag triggers [`.github/workflows/release.yml`](.github/workflows/release.yml),
which builds on an Apple Silicon runner, re-signs the bundle and publishes the DMG
to GitHub Releases. It can also be run manually from the Actions tab.

For development:

```bash
pnpm tauri dev
```

## Project layout

```
src/            React UI (App.tsx, i18n.ts, App.css)
src-tauri/src/  Rust core (lib.rs — all FS commands)
```

## License

MIT — see [LICENSE](LICENSE).
