import * as crypto from 'node:crypto';
import * as vscode from 'vscode';
import {
  NoActivePlayerError,
  PlayerDependencyMissingError,
  UnsupportedPlayerCommandError,
  type MediaPlayerService,
  type PlayerState,
} from '../player/PlayerTypes';
import {
  affectsBrowserMusicConfiguration,
  getBrowserMusicConfiguration,
} from '../util/config';
import type { Logger } from '../util/logger';

type WebviewCommand =
  | 'playPause'
  | 'previous'
  | 'next'
  | 'refresh'
  | 'seekRelative'
  | 'seekTo'
  | 'setVolume'
  | 'toggleMute'
  | 'toggleShuffle'
  | 'cycleRepeat';

interface WebviewMessage {
  readonly command?: unknown;
  readonly value?: unknown;
}

export class MusicSidebarProvider
  implements vscode.WebviewViewProvider, vscode.Disposable
{
  public static readonly viewType = 'browserMusicSidebar.view';

  private view: vscode.WebviewView | undefined;
  private refreshTimer: NodeJS.Timeout | undefined;
  private refreshInProgress: Promise<void> | undefined;
  private lastTrackKey: string | undefined;
  private readonly disposables: vscode.Disposable[] = [];

  public constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly playerService: MediaPlayerService,
    private readonly logger: Logger,
  ) {
    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (affectsBrowserMusicConfiguration(event)) {
          this.restartRefreshTimer();
          void this.refresh();
        }
      }),
    );
  }

  public resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')],
    };
    webviewView.webview.html = this.getHtml(webviewView.webview);

    this.disposables.push(
      webviewView.webview.onDidReceiveMessage((message: WebviewMessage) => {
        void this.handleMessage(message);
      }),
      webviewView.onDidChangeVisibility(() => {
        if (webviewView.visible) {
          this.restartRefreshTimer();
          void this.refresh();
        } else {
          this.stopRefreshTimer();
        }
      }),
      webviewView.onDidDispose(() => {
        this.view = undefined;
        this.stopRefreshTimer();
      }),
    );

    this.restartRefreshTimer();
    void this.refresh();
  }

  public async refresh(): Promise<void> {
    if (this.refreshInProgress !== undefined) {
      return this.refreshInProgress;
    }

    this.refreshInProgress = this.performRefresh();
    try {
      await this.refreshInProgress;
    } finally {
      this.refreshInProgress = undefined;
    }
  }

  public async playPause(): Promise<void> {
    await this.runPlayerAction(() => this.playerService.playPause());
  }

  public async previous(): Promise<void> {
    await this.runPlayerAction(() => this.playerService.previous());
  }

  public async next(): Promise<void> {
    await this.runPlayerAction(() => this.playerService.next());
  }

  public dispose(): void {
    this.stopRefreshTimer();
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
  }

  private async performRefresh(): Promise<void> {
    const state = await this.playerService.getState();
    if (this.view !== undefined) {
      await this.view.webview.postMessage({ type: 'state', state });
    }
    this.maybeNotifyTrackChange(state);
  }

  private async handleMessage(message: WebviewMessage): Promise<void> {
    if (typeof message.command !== 'string') {
      return;
    }

    const command = message.command as WebviewCommand;
    switch (command) {
      case 'playPause':
        await this.playPause();
        break;
      case 'previous':
        await this.previous();
        break;
      case 'next':
        await this.next();
        break;
      case 'refresh':
        await this.refresh();
        break;
      case 'seekRelative':
        await this.runNumericAction(message.value, (value) =>
          this.playerService.seekRelative(value),
        );
        break;
      case 'seekTo':
        await this.runNumericAction(message.value, (value) =>
          this.playerService.seekTo(value),
        );
        break;
      case 'setVolume':
        await this.runNumericAction(message.value, (value) =>
          this.playerService.setVolume(value),
        );
        break;
      case 'toggleMute':
        await this.runPlayerAction(() => this.playerService.toggleMute());
        break;
      case 'toggleShuffle':
        await this.runPlayerAction(() => this.playerService.toggleShuffle());
        break;
      case 'cycleRepeat':
        await this.runPlayerAction(() => this.playerService.cycleRepeat());
        break;
      default:
        this.logger.info('Ignored an unknown webview command');
    }
  }

  private async runNumericAction(
    rawValue: unknown,
    action: (value: number) => Promise<void>,
  ): Promise<void> {
    if (typeof rawValue !== 'number' || !Number.isFinite(rawValue)) {
      this.logger.info('Ignored an invalid numeric webview message');
      return;
    }
    await this.runPlayerAction(() => action(rawValue));
  }

  private async runPlayerAction(action: () => Promise<void>): Promise<void> {
    try {
      await action();
      await this.refresh();
    } catch (error: unknown) {
      this.logger.error('Player command failed', error);
      if (error instanceof PlayerDependencyMissingError) {
        void vscode.window.showErrorMessage(error.message);
      } else if (error instanceof NoActivePlayerError) {
        void vscode.window.showInformationMessage(error.message);
      } else if (error instanceof UnsupportedPlayerCommandError) {
        void vscode.window.showInformationMessage(error.message);
      } else {
        void vscode.window.showWarningMessage(
          'The selected media player did not accept that command.',
        );
      }
      await this.refresh();
    }
  }

  private maybeNotifyTrackChange(state: PlayerState): void {
    if (!state.active) {
      this.lastTrackKey = undefined;
      return;
    }

    const trackKey = `${state.playerName}\u001f${state.title}\u001f${state.artist}`;
    if (
      this.lastTrackKey !== undefined &&
      this.lastTrackKey !== trackKey &&
      getBrowserMusicConfiguration().showTrackNotifications
    ) {
      void vscode.window.showInformationMessage(
        `Now playing: ${state.title} — ${state.artist}`,
      );
    }
    this.lastTrackKey = trackKey;
  }

  private restartRefreshTimer(): void {
    this.stopRefreshTimer();
    if (this.view?.visible !== true) {
      return;
    }

    const { refreshInterval } = getBrowserMusicConfiguration();
    this.refreshTimer = setInterval(() => {
      void this.refresh();
    }, refreshInterval);
  }

  private stopRefreshTimer(): void {
    if (this.refreshTimer !== undefined) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = undefined;
    }
  }

  private getHtml(webview: vscode.Webview): string {
    const nonce = crypto.randomBytes(18).toString('base64');
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'media', 'main.js'),
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'media', 'main.css'),
    );

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} https: http: data:; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
  <link rel="stylesheet" href="${styleUri.toString()}">
  <title>Browser Music Sidebar</title>
</head>
<body>
  <main class="player" aria-live="polite">
    <div class="artwork-frame">
      <img id="artwork" class="artwork hidden" alt="Album artwork">
      <div id="artwork-placeholder" class="artwork-placeholder" aria-hidden="true">♪</div>
    </div>

    <section class="metadata">
      <h1 id="title">No active media</h1>
      <p id="artist"></p>
      <p id="album" class="secondary"></p>
      <p id="status" class="status">Waiting for a media player</p>
      <p id="player-name" class="player-name"></p>
    </section>

    <section class="progress-section" aria-label="Track progress">
      <input id="progress" type="range" min="0" max="0" value="0" step="1" aria-label="Seek">
      <div class="time-row">
        <span id="position">0:00</span>
        <span id="duration">0:00</span>
      </div>
    </section>

    <section class="transport" aria-label="Playback controls">
      <button id="previous" type="button" title="Previous" aria-label="Previous track">⏮</button>
      <button id="seek-back" type="button" title="Back 10 seconds" aria-label="Seek backward 10 seconds">−10</button>
      <button id="play-pause" class="primary" type="button" title="Play" aria-label="Play or pause">▶</button>
      <button id="seek-forward" type="button" title="Forward 10 seconds" aria-label="Seek forward 10 seconds">+10</button>
      <button id="next" type="button" title="Next" aria-label="Next track">⏭</button>
    </section>

    <section class="options" aria-label="Playback options">
      <button id="shuffle" type="button" title="Toggle shuffle" aria-label="Toggle shuffle">Shuffle</button>
      <button id="repeat" type="button" title="Change repeat mode" aria-label="Change repeat mode">Repeat</button>
      <button id="refresh" type="button" title="Refresh" aria-label="Refresh media information">Refresh</button>
    </section>

    <section class="volume-section" aria-label="Volume">
      <button id="mute" type="button" title="Mute" aria-label="Mute or unmute">🔊</button>
      <input id="volume" type="range" min="0" max="1" value="0" step="0.01" aria-label="Volume">
      <span id="volume-value">0%</span>
    </section>

    <p id="message" class="message"></p>
  </main>
  <script nonce="${nonce}" src="${scriptUri.toString()}"></script>
</body>
</html>`;
  }
}
