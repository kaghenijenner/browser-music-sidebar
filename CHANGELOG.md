# Changelog

## Unreleased

- Added a dedicated YouTube sidebar view that works without an active browser
  media session.
- Added YouTube text search, direct URL lookup, result thumbnails, and
  independent audio/video playback through a locally installed `yt-dlp`.

## 1.1.4

- Added optional muted YouTube video playback in the artwork panel, synchronized
  with the active browser media session through a native video element and a
  locally installed `yt-dlp`.
- Added a click-to-start fallback and player diagnostics for VS Code environments
  that block muted autoplay.
- Fixed automatic Linux player selection to prefer an actively playing session
  when multiple MPRIS players are available.

## 1.1.3

- Fixed Linux browser sessions being shown as inactive when an active player
  does not support optional MPRIS commands such as shuffle or repeat.

## 1.1.2

- Simplified the Marketplace description for end users.
- Removed internal development, packaging, publishing, and screenshot
  placeholder content from the public listing.

## 1.1.1

- Added the extension icon shown on the Visual Studio Marketplace.

## 1.1.0

- Added native Windows browser media discovery and control through Global System
  Media Transport Controls.
- Added macOS Now Playing metadata and playback control through
  `nowplaying-cli`.
- Added per-player capability detection so unsupported controls are disabled.
- Added Linux, Windows x64/ARM64, and macOS Intel/Apple Silicon packages.

## 1.0.0

- Initial release.
- Added MPRIS browser playback controls, metadata, artwork, progress, seeking,
  volume, mute, shuffle, repeat, commands, keybindings, and notifications.
