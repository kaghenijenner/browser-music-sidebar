import { execFile } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import type * as vscode from 'vscode';
import type { Logger } from '../util/logger';

const LOOPBACK_HOST = '127.0.0.1';
const VIDEO_ID_PATTERN = /^[a-zA-Z0-9_-]{11}$/u;
const VIDEO_FORMAT = [
  'bestvideo[vcodec^=avc1][height<=480][ext=mp4]',
  'bestvideo[vcodec^=avc1][height<=480]',
  'bestvideo[height<=480][ext=mp4]',
  'bestvideo[height<=480]',
].join('/');
const FALLBACK_CACHE_LIFETIME_MS = 15 * 60 * 1000;
const EXPIRY_MARGIN_MS = 5 * 60 * 1000;

interface CachedStream {
  readonly url: string;
  readonly expiresAt: number;
}

export class YouTubePlayerServer implements vscode.Disposable {
  private readonly token = crypto.randomBytes(24).toString('base64url');
  private readonly streamCache = new Map<string, CachedStream>();
  private readonly pendingStreams = new Map<
    string,
    Promise<string | undefined>
  >();
  private server: http.Server | undefined;
  private playerUrl: string | undefined;
  private dependencyErrorLogged = false;

  public constructor(private readonly logger: Logger) {}

  public async start(): Promise<void> {
    if (this.server !== undefined) {
      return;
    }

    const server = http.createServer((request, response) => {
      this.handleRequest(request, response);
    });

    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, LOOPBACK_HOST, () => {
          server.off('error', reject);
          resolve();
        });
      });
      const address = server.address() as AddressInfo;
      server.on('error', (error) => {
        this.logger.error('YouTube video wrapper error', error);
      });
      this.server = server;
      this.playerUrl = `http://${LOOPBACK_HOST}:${address.port}/${this.token}`;
    } catch (error: unknown) {
      server.close();
      this.logger.error('Unable to start the YouTube video wrapper', error);
    }
  }

  public getUrl(): string | undefined {
    return this.playerUrl;
  }

  public async resolveVideoUrl(videoId: string): Promise<string | undefined> {
    if (!VIDEO_ID_PATTERN.test(videoId)) {
      return undefined;
    }

    const cached = this.streamCache.get(videoId);
    if (cached !== undefined && cached.expiresAt > Date.now()) {
      return cached.url;
    }

    const pending = this.pendingStreams.get(videoId);
    if (pending !== undefined) {
      return pending;
    }

    const resolution = this.resolveVideoUrlWithYtDlp(videoId).finally(() => {
      this.pendingStreams.delete(videoId);
    });
    this.pendingStreams.set(videoId, resolution);
    return resolution;
  }

  public dispose(): void {
    this.server?.close();
    this.server = undefined;
    this.playerUrl = undefined;
    this.streamCache.clear();
    this.pendingStreams.clear();
  }

  private async resolveVideoUrlWithYtDlp(
    videoId: string,
  ): Promise<string | undefined> {
    try {
      const stdout = await new Promise<string>((resolve, reject) => {
        execFile(
          'yt-dlp',
          [
            '--no-playlist',
            '--no-warnings',
            '--get-url',
            '-f',
            VIDEO_FORMAT,
            `https://www.youtube.com/watch?v=${videoId}`,
          ],
          {
            encoding: 'utf8',
            timeout: 30_000,
            maxBuffer: 1024 * 1024,
          },
          (error, output) => {
            if (error !== null) {
              reject(
                error instanceof Error
                  ? error
                  : new Error('yt-dlp failed to resolve the video stream'),
              );
            } else {
              resolve(output);
            }
          },
        );
      });
      const firstLine = stdout
        .split(/\r?\n/u)
        .map((line) => line.trim())
        .find((line) => line.length > 0);
      if (firstLine === undefined) {
        throw new Error('yt-dlp returned no video stream URL');
      }

      const streamUrl = new URL(firstLine);
      if (
        streamUrl.protocol !== 'https:' ||
        !(
          streamUrl.hostname === 'googlevideo.com' ||
          streamUrl.hostname.endsWith('.googlevideo.com')
        )
      ) {
        throw new Error('yt-dlp returned an unexpected video stream host');
      }

      const expirySeconds = Number(streamUrl.searchParams.get('expire'));
      const expiresAt = Number.isFinite(expirySeconds)
        ? Math.max(
            Date.now() + 60_000,
            expirySeconds * 1000 - EXPIRY_MARGIN_MS,
          )
        : Date.now() + FALLBACK_CACHE_LIFETIME_MS;
      this.streamCache.set(videoId, {
        url: streamUrl.toString(),
        expiresAt,
      });
      this.dependencyErrorLogged = false;
      this.logger.info(`Resolved direct YouTube video stream for ${videoId}`);
      return streamUrl.toString();
    } catch (error: unknown) {
      const missingDependency =
        error instanceof Error &&
        'code' in error &&
        (error as NodeJS.ErrnoException).code === 'ENOENT';
      if (!missingDependency || !this.dependencyErrorLogged) {
        this.logger.error(
          missingDependency
            ? 'Direct YouTube video requires yt-dlp'
            : `Unable to resolve direct YouTube video stream for ${videoId}`,
          error,
        );
      }
      this.dependencyErrorLogged ||= missingDependency;
      return undefined;
    }
  }

  private handleRequest(
    request: http.IncomingMessage,
    response: http.ServerResponse,
  ): void {
    const expectedPath = `/${this.token}`;
    if (request.method !== 'GET' || request.url?.split('?')[0] !== expectedPath) {
      response.writeHead(404, {
        'Cache-Control': 'no-store',
        'Content-Type': 'text/plain; charset=utf-8',
      });
      response.end('Not found');
      return;
    }

    const nonce = crypto.randomBytes(18).toString('base64');
    response.writeHead(200, {
      'Cache-Control': 'no-store',
      'Content-Security-Policy': [
        "default-src 'none'",
        `script-src 'nonce-${nonce}'`,
        'media-src https://*.googlevideo.com',
        `style-src 'nonce-${nonce}'`,
      ].join('; '),
      'Content-Type': 'text/html; charset=utf-8',
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
    });
    response.end(this.getPlayerHtml(nonce));
  }

  private getPlayerHtml(nonce: string): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style nonce="${nonce}">
    html, body, #youtube-player {
      width: 100%;
      height: 100%;
      margin: 0;
      overflow: hidden;
      background: #000;
    }
    #youtube-player {
      display: block;
      object-fit: contain;
    }
  </style>
</head>
<body>
  <video
    id="youtube-player"
    controls
    muted
    playsinline
    preload="metadata"
    aria-label="Muted YouTube video"
  ></video>
  <script nonce="${nonce}">
    (() => {
      'use strict';

      const token = '${this.token}';
      const videoIdPattern = /^[a-zA-Z0-9_-]{11}$/;
      const player = document.getElementById('youtube-player');
      let latestState;
      let currentVideoId;
      let currentVideoUrl;
      let initialPositionApplied = false;
      let initialPlaybackCorrected = false;
      let autoplayBlocked = false;
      let playPending = false;
      let lastSeekAt = 0;

      const report = (type, videoId, detail) => {
        window.parent.postMessage({ type, token, videoId, detail }, '*');
      };

      const isSafeVideoUrl = (rawUrl) => {
        try {
          const url = new URL(rawUrl);
          return (
            url.protocol === 'https:' &&
            (url.hostname === 'googlevideo.com' ||
              url.hostname.endsWith('.googlevideo.com'))
          );
        } catch {
          return false;
        }
      };

      const getExpectedPosition = () => {
        if (!latestState) {
          return 0;
        }
        const position = Number(latestState.positionSeconds) || 0;
        const sampledAt = Number(latestState.sampledAt);
        const elapsed =
          latestState.status === 'Playing' && Number.isFinite(sampledAt)
            ? Math.max(0, Date.now() - sampledAt) / 1000
            : 0;
        return Math.max(0, position + elapsed);
      };

      const applyPositionOnce = () => {
        if (
          initialPositionApplied ||
          !latestState ||
          player.readyState < HTMLMediaElement.HAVE_METADATA
        ) {
          return;
        }
        const position = getExpectedPosition();
        if (position > 0) {
          player.currentTime = position;
        }
        initialPositionApplied = true;
      };

      const attemptPlayback = () => {
        if (
          !latestState ||
          latestState.status !== 'Playing' ||
          autoplayBlocked ||
          playPending ||
          !player.paused
        ) {
          return;
        }
        playPending = true;
        const result = player.play();
        if (result !== undefined) {
          result.then(
            () => {
              playPending = false;
            },
            () => {
              playPending = false;
              autoplayBlocked = true;
              report('youtube-autoplay-blocked', currentVideoId);
            }
          );
        } else {
          playPending = false;
        }
      };

      const applyState = () => {
        if (!latestState) {
          return;
        }

        const { videoId, videoUrl, status } = latestState;
        if (currentVideoId !== videoId || currentVideoUrl !== videoUrl) {
          currentVideoId = videoId;
          currentVideoUrl = videoUrl;
          initialPositionApplied = false;
          initialPlaybackCorrected = false;
          autoplayBlocked = false;
          playPending = false;
          lastSeekAt = 0;
          player.src = videoUrl;
          player.load();
          return;
        }

        applyPositionOnce();
        const position = getExpectedPosition();
        const now = Date.now();
        if (
          !player.paused &&
          !player.seeking &&
          player.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA &&
          position > 1 &&
          Math.abs(player.currentTime - position) > 2.5 &&
          now - lastSeekAt > 10000
        ) {
          lastSeekAt = now;
          player.currentTime = Math.max(0, position);
        }
        player.muted = true;
        if (status === 'Playing') {
          attemptPlayback();
        } else if (!player.paused) {
          player.pause();
        }
      };

      player.addEventListener('loadedmetadata', () => {
        applyPositionOnce();
        report('youtube-ready', currentVideoId);
        attemptPlayback();
      });
      player.addEventListener('canplay', attemptPlayback);
      player.addEventListener('seeked', attemptPlayback);
      player.addEventListener('playing', () => {
        autoplayBlocked = false;
        playPending = false;
        if (!initialPlaybackCorrected) {
          initialPlaybackCorrected = true;
          const expectedPosition = getExpectedPosition();
          if (Math.abs(player.currentTime - expectedPosition) > 0.75) {
            player.currentTime = expectedPosition;
          }
        }
        report('youtube-playing', currentVideoId, Number(player.currentTime));
      });
      player.addEventListener('error', () => {
        report(
          'youtube-error',
          currentVideoId,
          Number(player.error?.code) || undefined
        );
      });
      player.addEventListener('volumechange', () => {
        if (!player.muted) {
          player.muted = true;
        }
      });

      window.addEventListener('message', (event) => {
        const message = event.data;
        if (
          !message ||
          message.type !== 'youtube-state' ||
          message.token !== token ||
          !videoIdPattern.test(message.videoId) ||
          !isSafeVideoUrl(message.videoUrl)
        ) {
          return;
        }

        latestState = {
          videoId: message.videoId,
          videoUrl: message.videoUrl,
          status: message.status,
          positionSeconds: Number(message.positionSeconds),
          sampledAt: Number(message.sampledAt)
        };
        applyState();
      });

      report('youtube-wrapper-ready');
    })();
  </script>
</body>
</html>`;
  }
}
