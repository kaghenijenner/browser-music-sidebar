import * as crypto from 'node:crypto';
import * as vscode from 'vscode';
import type { Logger } from '../util/logger';
import type {
  YouTubePlayerServer,
  YouTubeSearchResult,
} from './YouTubePlayerServer';

type YouTubeWebviewCommand = 'search' | 'play' | 'youtubeEvent';

interface YouTubeWebviewMessage {
  readonly command?: unknown;
  readonly value?: unknown;
}

interface YouTubePlayerEvent {
  readonly type?: unknown;
  readonly videoId?: unknown;
  readonly detail?: unknown;
}

const VIDEO_ID_PATTERN = /^[a-zA-Z0-9_-]{11}$/u;
const MAXIMUM_SEARCH_LENGTH = 200;

export class YouTubeSidebarProvider
  implements vscode.WebviewViewProvider, vscode.Disposable
{
  public static readonly viewType = 'browserMusicSidebar.youtubeView';

  private view: vscode.WebviewView | undefined;
  private searchGeneration = 0;
  private playbackGeneration = 0;
  private readonly disposables: vscode.Disposable[] = [];

  public constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly youtubePlayer: YouTubePlayerServer,
    private readonly logger: Logger,
  ) {}

  public resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')],
    };
    webviewView.webview.html = this.getHtml(webviewView.webview);

    this.disposables.push(
      webviewView.webview.onDidReceiveMessage(
        (message: YouTubeWebviewMessage) => {
          void this.handleMessage(message);
        },
      ),
      webviewView.onDidDispose(() => {
        if (this.view === webviewView) {
          this.view = undefined;
        }
      }),
    );
  }

  public dispose(): void {
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
  }

  private async handleMessage(message: YouTubeWebviewMessage): Promise<void> {
    if (typeof message.command !== 'string') {
      return;
    }

    const command = message.command as YouTubeWebviewCommand;
    switch (command) {
      case 'search':
        await this.search(message.value);
        break;
      case 'play':
        await this.play(message.value);
        break;
      case 'youtubeEvent':
        this.logPlayerEvent(message.value);
        break;
      default:
        this.logger.info('Ignored an unknown YouTube webview command');
    }
  }

  private async search(rawQuery: unknown): Promise<void> {
    if (typeof rawQuery !== 'string') {
      return;
    }
    const query = rawQuery.trim().slice(0, MAXIMUM_SEARCH_LENGTH);
    if (query.length === 0) {
      return;
    }

    const generation = ++this.searchGeneration;
    await this.postMessage({ type: 'youtube-search-started', query });
    try {
      const results = await this.youtubePlayer.searchVideos(query);
      if (generation !== this.searchGeneration) {
        return;
      }
      await this.postMessage({
        type: 'youtube-search-results',
        query,
        results,
      });
    } catch (error: unknown) {
      if (generation !== this.searchGeneration) {
        return;
      }
      const dependencyMissing =
        error instanceof Error &&
        'code' in error &&
        (error as NodeJS.ErrnoException).code === 'ENOENT';
      await this.postMessage({
        type: 'youtube-search-error',
        query,
        message: dependencyMissing
          ? 'Install yt-dlp to search and play YouTube.'
          : 'YouTube search failed. Try again in a moment.',
      });
    }
  }

  private async play(rawVideoId: unknown): Promise<void> {
    if (
      typeof rawVideoId !== 'string' ||
      !VIDEO_ID_PATTERN.test(rawVideoId)
    ) {
      return;
    }

    if (this.youtubePlayer.getUrl() === undefined) {
      await this.postMessage({
        type: 'youtube-playback-error',
        videoId: rawVideoId,
        message: 'The local YouTube player could not be started.',
      });
      return;
    }

    const generation = ++this.playbackGeneration;
    await this.postMessage({
      type: 'youtube-playback-started',
      videoId: rawVideoId,
    });
    const [videoUrl, resolvedAudioUrl] = await Promise.all([
      this.youtubePlayer.resolveVideoUrl(rawVideoId),
      this.youtubePlayer.resolveAudioUrl(rawVideoId),
    ]);
    const audioUrl =
      resolvedAudioUrl === undefined
        ? undefined
        : this.youtubePlayer.getAudioPlayerUrl(rawVideoId);
    if (generation !== this.playbackGeneration) {
      return;
    }
    await this.postMessage(
      videoUrl === undefined
        ? {
            type: 'youtube-playback-error',
            videoId: rawVideoId,
            message: 'This video could not be played.',
          }
        : {
            type: 'youtube-playback-ready',
            videoId: rawVideoId,
            videoUrl,
            audioUrl,
          },
    );
  }

  private logPlayerEvent(rawValue: unknown): void {
    if (typeof rawValue !== 'object' || rawValue === null) {
      return;
    }
    const event = rawValue as YouTubePlayerEvent;
    if (
      typeof event.type !== 'string' ||
      !/^(ready|playing|autoplay-blocked|error|audio-ready|audio-playing|audio-blocked|audio-error|playback-blocked)$/u.test(
        event.type,
      ) ||
      typeof event.videoId !== 'string' ||
      !VIDEO_ID_PATTERN.test(event.videoId)
    ) {
      return;
    }
    const detail =
      (typeof event.detail === 'number' && Number.isFinite(event.detail)) ||
      typeof event.detail === 'string'
        ? ` (${event.detail})`
        : '';
    this.logger.info(
      `YouTube player: ${event.type}${detail} for ${event.videoId}`,
    );
  }

  private async postMessage(message: {
    readonly type: string;
    readonly query?: string;
    readonly videoId?: string;
    readonly videoUrl?: string;
    readonly audioUrl?: string;
    readonly message?: string;
    readonly results?: readonly YouTubeSearchResult[];
  }): Promise<void> {
    await this.view?.webview.postMessage(message);
  }

  private getHtml(webview: vscode.Webview): string {
    const nonce = crypto.randomBytes(18).toString('base64');
    const cacheKey = encodeURIComponent(nonce);
    const scriptUri = webview
      .asWebviewUri(
        vscode.Uri.joinPath(this.extensionUri, 'media', 'youtube.js'),
      )
      .with({ query: `v=${cacheKey}` });
    const styleUri = webview
      .asWebviewUri(
        vscode.Uri.joinPath(this.extensionUri, 'media', 'youtube.css'),
      )
      .with({ query: `v=${cacheKey}` });
    const playerUrl = this.youtubePlayer.getUrl();
    const frameSource =
      playerUrl === undefined ? "'none'" : new URL(playerUrl).origin;

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; frame-src ${frameSource}; img-src https: data:; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
  <link rel="stylesheet" href="${styleUri.toString()}">
  <title>YouTube</title>
</head>
<body>
  <main class="youtube" data-player-url="${playerUrl ?? ''}">
    <form id="search-form" class="search" role="search">
      <input
        id="search-input"
        type="search"
        maxlength="${MAXIMUM_SEARCH_LENGTH}"
        placeholder="Search YouTube or paste a URL"
        aria-label="Search YouTube"
        autocomplete="off"
      >
      <button id="search-button" class="primary" type="submit">Search</button>
    </form>

    <section id="now-playing" class="now-playing hidden" aria-label="YouTube player">
      <div class="video-frame">
        <iframe
          id="youtube-player"
          class="player-frame"
          title="YouTube player"
          allow="autoplay; encrypted-media; picture-in-picture"
          referrerpolicy="strict-origin-when-cross-origin"
        ></iframe>
        <div id="player-placeholder" class="player-placeholder">Preparing video…</div>
      </div>
      <h2 id="playing-title"></h2>
      <p id="playing-channel" class="secondary"></p>
    </section>

    <p id="status" class="status" role="status">Search for a video to get started.</p>
    <section id="results" class="results" aria-label="YouTube search results"></section>
  </main>
  <script nonce="${nonce}" src="${scriptUri.toString()}"></script>
</body>
</html>`;
  }
}
