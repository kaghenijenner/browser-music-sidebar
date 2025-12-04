# Music & YouTube Sidebar

Control music from the Visual Studio Code Activity Bar on Linux,
Windows, and macOS. Music & YouTube Sidebar uses each operating system's media
session interface and does not use a remote backend, browser credentials, or
Electron APIs.

## Features

- Album artwork, title, artist, album, playback status, and active player
- Muted YouTube video in the artwork panel when a video ID is available
- Dedicated YouTube view with text search, URL lookup, result thumbnails, and
  independent audio/video playback
- Previous, play/pause, next, and manual refresh controls
- Track progress, absolute seeking, and 10-second seek buttons
- Volume, mute, shuffle, and repeat when supported by the platform/player
- Automatic metadata refresh (1.5 seconds by default)
- Configurable browser/player selection and automatic active-player selection
- Optional track-change notifications
- Command Palette commands and keyboard shortcuts
- Theme-aware UI built with VS Code color variables
- Strict webview Content Security Policy and validated `postMessage` commands

The extension supports Apple Music, Spotify, YouTube Music,
SoundCloud, and other sites that publish media-session information through the
browser.

The dedicated YouTube view does not require an active browser media session.
It uses the locally installed `yt-dlp` command to search public YouTube content
and resolve a playable stream.

## Platform support

| Platform | Media interface | Extra requirement |
| --- | --- | --- |
| Linux | MPRIS through `playerctl` | `playerctl` |
| Windows 10 1809+ / Windows 11 | Global System Media Transport Controls through Windows PowerShell | None |
| macOS 13+ | System Now Playing through `nowplaying-cli` | `nowplaying-cli` |

Feature availability ultimately depends on what the browser and website expose.
Unsupported controls are disabled automatically.

The separate YouTube search and player requires a current version of `yt-dlp`
and `ffmpeg` on `PATH` on every platform.

## Installation

Open the **Extensions** view in VS Code, search for **Music & YouTube Sidebar**,
and select **Install**. VS Code automatically installs the package for your
operating system.

To use the independent YouTube view, install `yt-dlp` and `ffmpeg`.
Use the `yt-dlp` instructions
for your operating system in the
[yt-dlp installation guide](https://github.com/yt-dlp/yt-dlp/wiki/Installation).
The normal browser media controls work without it.

## Linux setup

Install `playerctl` with the distribution package manager:

```bash
# Debian / Ubuntu
sudo apt update
sudo apt install playerctl

# Fedora
sudo dnf install playerctl

# Arch Linux
sudo pacman -S playerctl
```

Start browser playback and confirm that the player is visible:

```bash
playerctl --list-all
playerctl --player=chromium metadata
```

Common player names include `chromium`, `google-chrome`, and `firefox`.

## Windows setup

Windows needs no additional media-control package. The extension invokes the
built-in Windows PowerShell host and uses
`Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager`.

Start playback in the browser before opening the sidebar. If a specific player
is configured, the extension matches that value against the media session's
application ID. Common values include:

- `chrome`
- `msedge`
- `firefox`

The default `chromium` value also matches Chrome-compatible application IDs.
Leave the setting empty to use Windows' current media session automatically.

## macOS setup

Install the current Homebrew `nowplaying-cli` formula:

```bash
brew install nowplaying-cli
```

Confirm that macOS is publishing the browser session:

```bash
nowplaying-cli get --json title artist album
```

The macOS adapter follows the system's current Now Playing session, so the
player setting is ignored. `nowplaying-cli` currently uses Apple's private
MediaRemote interface; macOS updates can temporarily affect compatibility.

## Configuration

Open **Settings** and search for `Music & YouTube Sidebar`.

| Setting | Type | Default | Description |
| --- | --- | --- | --- |
| `browserMusicSidebar.player` | string | empty | Linux: playerctl player name. Windows: media-session application-ID substring. Leave empty for automatic selection. Ignored on macOS. |
| `browserMusicSidebar.refreshInterval` | number | `1500` | Refresh interval in milliseconds; minimum 500. |
| `browserMusicSidebar.showTrackNotifications` | boolean | `false` | Show a notification when the track changes. |
| `browserMusicSidebar.showYouTubeVideo` | boolean | `true` | Replace artwork with a muted, synchronized YouTube video when the media session exposes a YouTube video ID and `yt-dlp` is installed. |

Example:

```json
{
  "browserMusicSidebar.player": "",
  "browserMusicSidebar.refreshInterval": 1500,
  "browserMusicSidebar.showTrackNotifications": true,
  "browserMusicSidebar.showYouTubeVideo": true
}
```

## Commands and keyboard shortcuts

| Command | Linux / Windows | macOS |
| --- | --- | --- |
| Browser Music: Play/Pause | `Ctrl+Alt+Space` | `Cmd+Alt+Space` |
| Browser Music: Next | `Ctrl+Alt+Right` | `Cmd+Alt+Right` |
| Browser Music: Previous | `Ctrl+Alt+Left` | `Cmd+Alt+Left` |
| Browser Music: Refresh | Command Palette | Command Palette |

Keybindings can be changed with **Preferences: Open Keyboard Shortcuts**.

## Known limitations

- Browser media-session support and metadata quality are controlled by the
  browser and website.
- Linux browser profiles can create player names with instance suffixes. Use
  `playerctl --list-all` or leave the player setting empty.
- Windows media sessions do not expose per-session volume through the API used
  by this extension, so volume and mute are disabled on Windows.
- The macOS system interface used by `nowplaying-cli` supports transport and
  seeking, but not volume, shuffle, or repeat changes through its CLI.
- `nowplaying-cli` uses a private Apple framework and may need updates after a
  major macOS release.
- HTTP artwork can be blocked by browser or network policy even though the
  webview permits HTTP, HTTPS, and image data URLs.
- YouTube video artwork requires a video ID in the media URL or thumbnail and
  `yt-dlp` on `PATH`. Linux browsers commonly expose an ID; Windows media
  sessions generally do not.
- YouTube search and playback require network access and a recent `yt-dlp`.
  Search availability can change when YouTube changes its public site.
- Some videos do not expose a compatible direct stream. Static artwork is kept
  when stream resolution or native playback fails.
- VS Code blocks unmuted autoplay until the native player receives a user
  gesture. Audio is enabled by default; use **Play** once to start the first
  independent YouTube video with sound.
- The extension runs in the local UI extension host. Install it locally when
  using Remote SSH, Dev Containers, or WSL.

## Security and privacy

The extension executes fixed local media-control programs through Node's
`execFile`, without a shell. Linux invokes `playerctl`, macOS invokes
`nowplaying-cli`, and Windows invokes the packaged PowerShell script with
separate validated arguments. No metadata is interpolated into executable code.

The main webview receives serializable playback state and sends an allow-listed
set of commands through `postMessage`. It has no Node.js access, uses no `eval`,
and enforces a nonce-based Content Security Policy. YouTube video artwork uses
a token-protected loopback page containing a native muted video element.

No listening history or browser credentials are transmitted by the extension.
When YouTube video artwork is enabled and a video ID is available, the sidebar
uses the locally installed `yt-dlp` command to resolve a temporary direct video
stream URL. The native player requests that stream from YouTube. Disable
`browserMusicSidebar.showYouTubeVideo` to retain static artwork and prevent
those additional requests.

Queries entered in the dedicated YouTube view are passed to `yt-dlp`, which
requests public search results from YouTube. Selecting a result resolves a
temporary stream URL and plays it in a token-protected local player. The
extension does not send searches to its own service or store a remote search
history.

## License

MIT License. See the included `LICENSE` file.
