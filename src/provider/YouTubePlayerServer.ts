import {
  execFile,
  spawn,
  type ChildProcessWithoutNullStreams,
} from 'node:child_process';
import * as crypto from 'node:crypto';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import type * as vscode from 'vscode';
import type { Logger } from '../util/logger';
import { getYouTubeVideoId } from '../util/youtube';

const LOOPBACK_HOST = '127.0.0.1';
const VIDEO_ID_PATTERN = /^[a-zA-Z0-9_-]{11}$/u;
const VIDEO_FORMAT = [
  'best[height<=720][ext=mp4][vcodec!=none][acodec!=none]',
  'best[height<=720][vcodec!=none][acodec!=none]',
  'best[ext=mp4][vcodec!=none][acodec!=none]',
  'best[vcodec!=none][acodec!=none]',
].join('/');
const AUDIO_FORMAT = [
  'bestaudio[acodec^=opus]',
  'bestaudio[ext=webm]',
  'bestaudio[ext=m4a]',
  'bestaudio',
].join('/');
const SEARCH_RESULT_LIMIT = 12;
const MAXIMUM_SEARCH_LENGTH = 200;
const FALLBACK_CACHE_LIFETIME_MS = 15 * 60 * 1000;
const EXPIRY_MARGIN_MS = 5 * 60 * 1000;

interface CachedStream {
  readonly url: string;
  readonly expiresAt: number;
}

export interface YouTubeSearchResult {
  readonly videoId: string;
  readonly title: string;
  readonly channel: string;
  readonly durationSeconds: number;
  readonly thumbnailUrl: string;
}

interface YtDlpSearchPayload {
  readonly entries?: unknown;
  readonly id?: unknown;
  readonly title?: unknown;
  readonly channel?: unknown;
  readonly uploader?: unknown;
  readonly duration?: unknown;
}

export class YouTubePlayerServer implements vscode.Disposable {
  private readonly token = crypto.randomBytes(24).toString('base64url');
  private readonly streamCache = new Map<string, CachedStream>();
  private readonly pendingStreams = new Map<
    string,
    Promise<string | undefined>
  >();
  private readonly transcodingProcesses =
    new Set<ChildProcessWithoutNullStreams>();
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

  public async searchVideos(query: string): Promise<YouTubeSearchResult[]> {
    const normalizedQuery = query.trim().slice(0, MAXIMUM_SEARCH_LENGTH);
    if (normalizedQuery.length === 0) {
      return [];
    }

    const directVideoId =
      getYouTubeVideoId(normalizedQuery) ??
      (VIDEO_ID_PATTERN.test(normalizedQuery) ? normalizedQuery : undefined);
    const target =
      directVideoId === undefined
        ? `ytsearch${SEARCH_RESULT_LIMIT}:${normalizedQuery}`
        : `https://www.youtube.com/watch?v=${directVideoId}`;

    try {
      const stdout = await this.runYtDlp(
        [
          '--no-warnings',
          '--skip-download',
          '--flat-playlist',
          '--dump-single-json',
          target,
        ],
        30_000,
        4 * 1024 * 1024,
      );
      const payload = JSON.parse(stdout) as unknown;
      const candidates = this.getSearchCandidates(payload);
      const results = candidates
        .map((candidate) => this.toSearchResult(candidate))
        .filter((result): result is YouTubeSearchResult => result !== undefined)
        .slice(0, SEARCH_RESULT_LIMIT);
      this.dependencyErrorLogged = false;
      this.logger.info(
        `YouTube search returned ${results.length} result(s)`,
      );
      return results;
    } catch (error: unknown) {
      this.logYtDlpError('Unable to search YouTube', error);
      throw error;
    }
  }

  public async resolveVideoUrl(videoId: string): Promise<string | undefined> {
    return this.resolveStreamUrl(videoId, 'video', VIDEO_FORMAT);
  }

  public async resolveAudioUrl(videoId: string): Promise<string | undefined> {
    return this.resolveStreamUrl(videoId, 'audio', AUDIO_FORMAT);
  }

  public getAudioPlayerUrl(videoId: string): string | undefined {
    if (
      this.playerUrl === undefined ||
      !VIDEO_ID_PATTERN.test(videoId)
    ) {
      return undefined;
    }
    return `${this.playerUrl}/audio/${videoId}`;
  }

  private async resolveStreamUrl(
    videoId: string,
    streamType: 'audio' | 'video',
    format: string,
  ): Promise<string | undefined> {
    if (!VIDEO_ID_PATTERN.test(videoId)) {
      return undefined;
    }

    const cacheKey = `${streamType}:${videoId}`;
    const cached = this.streamCache.get(cacheKey);
    if (cached !== undefined && cached.expiresAt > Date.now()) {
      return cached.url;
    }

    const pending = this.pendingStreams.get(cacheKey);
    if (pending !== undefined) {
      return pending;
    }

    const resolution = this.resolveStreamUrlWithYtDlp(
      videoId,
      streamType,
      format,
      cacheKey,
    ).finally(() => {
      this.pendingStreams.delete(cacheKey);
    });
    this.pendingStreams.set(cacheKey, resolution);
    return resolution;
  }

  public dispose(): void {
    this.server?.close();
    this.server = undefined;
    this.playerUrl = undefined;
    this.streamCache.clear();
    this.pendingStreams.clear();
    for (const process of this.transcodingProcesses) {
      process.kill();
    }
    this.transcodingProcesses.clear();
  }

  private async resolveStreamUrlWithYtDlp(
    videoId: string,
    streamType: 'audio' | 'video',
    format: string,
    cacheKey: string,
  ): Promise<string | undefined> {
    try {
      const stdout = await this.runYtDlp([
        '--no-playlist',
        '--no-warnings',
        '--get-url',
        '-f',
        format,
        `https://www.youtube.com/watch?v=${videoId}`,
      ]);
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
      this.streamCache.set(cacheKey, {
        url: streamUrl.toString(),
        expiresAt,
      });
      this.dependencyErrorLogged = false;
      this.logger.info(
        `Resolved direct YouTube ${streamType} stream for ${videoId}`,
      );
      return streamUrl.toString();
    } catch (error: unknown) {
      this.logYtDlpError(
        `Unable to resolve a YouTube ${streamType} stream for ${videoId}`,
        error,
      );
      return undefined;
    }
  }

  private runYtDlp(
    arguments_: readonly string[],
    timeout = 30_000,
    maxBuffer = 1024 * 1024,
  ): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      execFile(
        'yt-dlp',
        [...arguments_],
        { encoding: 'utf8', timeout, maxBuffer },
        (error, output) => {
          if (error !== null) {
            reject(
              error instanceof Error
                ? error
                : new Error('yt-dlp did not complete successfully'),
            );
          } else {
            resolve(output);
          }
        },
      );
    });
  }

  private getSearchCandidates(payload: unknown): YtDlpSearchPayload[] {
    if (typeof payload !== 'object' || payload === null) {
      return [];
    }
    const parsed = payload as YtDlpSearchPayload;
    if (Array.isArray(parsed.entries)) {
      return parsed.entries.filter(
        (entry): entry is YtDlpSearchPayload =>
          typeof entry === 'object' && entry !== null,
      );
    }
    return [parsed];
  }

  private toSearchResult(
    candidate: YtDlpSearchPayload,
  ): YouTubeSearchResult | undefined {
    if (
      typeof candidate.id !== 'string' ||
      !VIDEO_ID_PATTERN.test(candidate.id) ||
      typeof candidate.title !== 'string' ||
      candidate.title.trim().length === 0
    ) {
      return undefined;
    }

    const channel =
      typeof candidate.channel === 'string'
        ? candidate.channel
        : typeof candidate.uploader === 'string'
          ? candidate.uploader
          : 'YouTube';
    const durationSeconds =
      typeof candidate.duration === 'number' &&
      Number.isFinite(candidate.duration) &&
      candidate.duration > 0
        ? candidate.duration
        : 0;

    return {
      videoId: candidate.id,
      title: candidate.title.trim(),
      channel: channel.trim() || 'YouTube',
      durationSeconds,
      thumbnailUrl: `https://i.ytimg.com/vi/${candidate.id}/mqdefault.jpg`,
    };
  }

  private logYtDlpError(message: string, error: unknown): void {
    const missingDependency =
      error instanceof Error &&
      'code' in error &&
      (error as NodeJS.ErrnoException).code === 'ENOENT';
    if (!missingDependency || !this.dependencyErrorLogged) {
      this.logger.error(
        missingDependency ? 'YouTube features require yt-dlp' : message,
        error,
      );
    }
    this.dependencyErrorLogged ||= missingDependency;
  }

  private handleRequest(
    request: http.IncomingMessage,
    response: http.ServerResponse,
  ): void {
    const expectedPath = `/${this.token}`;
    const requestUrl = new URL(
      request.url ?? '/',
      `http://${LOOPBACK_HOST}`,
    );
    const audioPathPrefix = `${expectedPath}/audio/`;
    if (
      request.method === 'GET' &&
      requestUrl.pathname.startsWith(audioPathPrefix)
    ) {
      const videoId = requestUrl.pathname.slice(audioPathPrefix.length);
      this.handleAudioRequest(videoId, requestUrl, response);
      return;
    }
    if (request.method !== 'GET' || requestUrl.pathname !== expectedPath) {
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
        "media-src 'self' https://*.googlevideo.com",
        `style-src 'nonce-${nonce}'`,
      ].join('; '),
      'Content-Type': 'text/html; charset=utf-8',
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
    });
    response.end(this.getPlayerHtml(nonce));
  }

  private handleAudioRequest(
    videoId: string,
    requestUrl: URL,
    response: http.ServerResponse,
  ): void {
    const cached = this.streamCache.get(`audio:${videoId}`);
    if (
      !VIDEO_ID_PATTERN.test(videoId) ||
      cached === undefined ||
      cached.expiresAt <= Date.now()
    ) {
      response.writeHead(404, {
        'Cache-Control': 'no-store',
        'Content-Type': 'text/plain; charset=utf-8',
      });
      response.end('Audio stream unavailable');
      return;
    }

    const requestedStart = Number(requestUrl.searchParams.get('start'));
    const startSeconds =
      Number.isFinite(requestedStart) && requestedStart > 0
        ? Math.min(requestedStart, 24 * 60 * 60)
        : 0;
    const transcoder = spawn(
      'ffmpeg',
      [
        '-nostdin',
        '-hide_banner',
        '-loglevel',
        'error',
        '-ss',
        String(startSeconds),
        '-i',
        cached.url,
        '-vn',
        '-codec:a',
        'libmp3lame',
        '-b:a',
        '128k',
        '-f',
        'mp3',
        'pipe:1',
      ],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    );
    transcoder.stdin.end();
    this.transcodingProcesses.add(transcoder);

    response.writeHead(200, {
      'Accept-Ranges': 'none',
      'Cache-Control': 'no-store',
      'Content-Type': 'audio/mpeg',
      'X-Content-Type-Options': 'nosniff',
    });
    transcoder.stdout.pipe(response);
    transcoder.stderr.resume();

    const stopTranscoder = (): void => {
      if (transcoder.exitCode === null && transcoder.signalCode === null) {
        transcoder.kill();
      }
    };
    response.once('close', stopTranscoder);
    transcoder.once('error', (error) => {
      this.logger.error('Unable to start the YouTube audio transcoder', error);
      response.end();
    });
    transcoder.once('close', () => {
      this.transcodingProcesses.delete(transcoder);
      if (!response.writableEnded) {
        response.end();
      }
    });
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
    body {
      position: relative;
    }
    #youtube-player {
      display: block;
      object-fit: contain;
    }
    #youtube-audio {
      position: absolute;
      z-index: 1;
      right: 8px;
      bottom: 8px;
      left: 8px;
      width: calc(100% - 16px);
      height: 32px;
      opacity: 0;
      pointer-events: none;
      transform: translateY(5px);
      transition:
        opacity 120ms ease,
        transform 120ms ease;
    }
    body:hover #youtube-audio:not([hidden]),
    body:focus-within #youtube-audio:not([hidden]) {
      opacity: 1;
      pointer-events: auto;
      transform: translateY(0);
    }
    #sound-button {
      position: absolute;
      z-index: 1;
      top: 50%;
      left: 50%;
      min-height: 36px;
      padding: 8px 14px;
      border: 1px solid rgba(255, 255, 255, 0.7);
      border-radius: 5px;
      color: #fff;
      background: rgba(0, 0, 0, 0.82);
      font: 600 14px system-ui, sans-serif;
      cursor: pointer;
      transform: translate(-50%, -50%);
    }
    #sound-button:hover {
      background: rgba(32, 32, 32, 0.95);
    }
    #sound-button:focus-visible {
      outline: 2px solid #fff;
      outline-offset: 2px;
    }
    #sound-button[hidden] {
      display: none;
    }
  </style>
</head>
<body>
  <video
    id="youtube-player"
    playsinline
    preload="metadata"
    aria-label="YouTube video"
  ></video>
  <audio
    id="youtube-audio"
    controls
    hidden
    preload="none"
    aria-label="YouTube audio"
  ></audio>
  <button id="sound-button" type="button" hidden>▶ Play</button>
  <script nonce="${nonce}">
    (() => {
      'use strict';

      const token = '${this.token}';
      const videoIdPattern = /^[a-zA-Z0-9_-]{11}$/;
      const player = document.getElementById('youtube-player');
      const audio = document.getElementById('youtube-audio');
      const soundButton = document.getElementById('sound-button');
      let latestState;
      let currentVideoId;
      let currentVideoUrl;
      let currentAudioUrl;
      let initialPositionApplied = false;
      let initialPlaybackCorrected = false;
      let autoplayBlocked = false;
      let playPending = false;
      let lastSeekAt = 0;
      let soundEnabled = true;
      let playbackAuthorized = false;

      const report = (type, videoId, detail) => {
        window.parent.postMessage({ type, token, videoId, detail }, '*');
      };

      const describeError = (error) =>
        error instanceof Error
          ? error.name + ': ' + error.message
          : String(error || 'Unknown media error');

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

      const isSafeAudioUrl = (rawUrl, videoId) => {
        try {
          const url = new URL(rawUrl);
          return (
            url.origin === window.location.origin &&
            url.pathname === '/' + token + '/audio/' + videoId
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

      const applySoundMode = () => {
        const wantsSound = latestState?.muted === false;
        if (!wantsSound) {
          soundEnabled = false;
          playbackAuthorized = false;
          player.muted = true;
          audio.muted = true;
          audio.hidden = true;
          soundButton.hidden = true;
          return;
        }

        audio.hidden = !latestState.audioUrl;
        if (latestState.audioUrl) {
          player.muted = true;
          audio.muted = !soundEnabled;
        } else {
          player.muted = !soundEnabled;
        }
        soundButton.hidden = playbackAuthorized && soundEnabled;
      };

      const syncAudioPosition = () => {
        if (
          !latestState?.audioUrl ||
          audio.readyState < HTMLMediaElement.HAVE_METADATA
        ) {
          return;
        }
        if (Math.abs(audio.currentTime - player.currentTime) > 0.35) {
          audio.currentTime = player.currentTime;
        }
      };

      const playSynchronizedAudio = () => {
        if (
          !soundEnabled ||
          !playbackAuthorized ||
          !latestState?.audioUrl
        ) {
          return;
        }
        syncAudioPosition();
        const result = audio.play();
        if (result !== undefined) {
          result.catch((error) => {
            soundEnabled = false;
            playbackAuthorized = false;
            audio.muted = true;
            soundButton.hidden = false;
            report('youtube-audio-blocked', currentVideoId, describeError(error));
          });
        }
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
          (latestState.muted === false && !playbackAuthorized) ||
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

        const { videoId, videoUrl, audioUrl, status } = latestState;
        if (
          currentVideoId !== videoId ||
          currentVideoUrl !== videoUrl ||
          currentAudioUrl !== audioUrl
        ) {
          currentVideoId = videoId;
          currentVideoUrl = videoUrl;
          currentAudioUrl = audioUrl;
          initialPositionApplied = false;
          initialPlaybackCorrected = false;
          autoplayBlocked = false;
          playPending = false;
          lastSeekAt = 0;
          applySoundMode();
          player.src = videoUrl;
          player.load();
          if (audioUrl) {
            audio.src = audioUrl;
            audio.load();
          } else {
            audio.removeAttribute('src');
            audio.load();
          }
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
        applySoundMode();
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
        if (latestState?.muted === false) {
          playbackAuthorized = true;
          soundButton.hidden = true;
        }
        if (!initialPlaybackCorrected) {
          initialPlaybackCorrected = true;
          const expectedPosition = getExpectedPosition();
          if (Math.abs(player.currentTime - expectedPosition) > 0.75) {
            player.currentTime = expectedPosition;
          }
        }
        playSynchronizedAudio();
        report('youtube-playing', currentVideoId, Number(player.currentTime));
      });
      player.addEventListener('pause', () => {
        if (!audio.paused) {
          audio.pause();
        }
      });
      player.addEventListener('seeking', syncAudioPosition);
      player.addEventListener('seeked', () => {
        syncAudioPosition();
        playSynchronizedAudio();
      });
      player.addEventListener('timeupdate', () => {
        if (soundEnabled) {
          syncAudioPosition();
        }
      });
      player.addEventListener('error', () => {
        report(
          'youtube-error',
          currentVideoId,
          Number(player.error?.code) || undefined
        );
      });
      player.addEventListener('volumechange', () => {
        if (latestState?.audioUrl) {
          return;
        }
        if (latestState?.muted !== false && !player.muted) {
          player.muted = true;
        } else if (latestState?.muted === false) {
          soundEnabled = !player.muted;
          soundButton.hidden = playbackAuthorized && soundEnabled;
        }
      });
      audio.addEventListener('volumechange', () => {
        if (!latestState?.audioUrl) {
          return;
        }
        soundEnabled = !audio.muted && audio.volume > 0;
        soundButton.hidden = playbackAuthorized && soundEnabled;
      });
      audio.addEventListener('play', () => {
        playbackAuthorized = true;
        soundEnabled = true;
        audio.muted = false;
        soundButton.hidden = true;
        syncAudioPosition();
        const result = player.play();
        if (result !== undefined) {
          result.catch((error) => {
            report(
              'youtube-playback-blocked',
              currentVideoId,
              describeError(error)
            );
          });
        }
      });
      audio.addEventListener('pause', () => {
        if (!player.paused) {
          player.pause();
        }
      });
      audio.addEventListener('seeking', () => {
        if (player.readyState >= HTMLMediaElement.HAVE_METADATA) {
          player.currentTime = audio.currentTime;
        }
      });
      audio.addEventListener('loadedmetadata', () => {
        report('youtube-audio-ready', currentVideoId, Number(audio.duration));
      });
      audio.addEventListener('playing', () => {
        report('youtube-audio-playing', currentVideoId, Number(audio.currentTime));
      });
      audio.addEventListener('error', () => {
        report(
          'youtube-audio-error',
          currentVideoId,
          'code=' + String(audio.error?.code || 0) +
            ', network=' + String(audio.networkState) +
            ', ready=' + String(audio.readyState)
        );
      });
      soundButton.addEventListener('click', () => {
        soundEnabled = true;
        playbackAuthorized = true;
        autoplayBlocked = false;
        playPending = false;
        player.muted = latestState?.audioUrl !== undefined;
        player.volume = 1;
        audio.muted = false;
        audio.volume = 1;
        soundButton.hidden = true;
        playSynchronizedAudio();
        const result = player.play();
        if (result !== undefined) {
          result.catch((error) => {
            soundEnabled = false;
            playbackAuthorized = false;
            audio.muted = true;
            soundButton.hidden = false;
            report('youtube-playback-blocked', currentVideoId, describeError(error));
          });
        }
      });

      window.addEventListener('message', (event) => {
        const message = event.data;
        if (
          !message ||
          message.type !== 'youtube-state' ||
          message.token !== token ||
          !videoIdPattern.test(message.videoId) ||
          !isSafeVideoUrl(message.videoUrl) ||
          (message.audioUrl !== undefined &&
            !isSafeAudioUrl(message.audioUrl, message.videoId))
        ) {
          return;
        }

        latestState = {
          videoId: message.videoId,
          videoUrl: message.videoUrl,
          audioUrl: message.audioUrl,
          status: message.status,
          muted: message.muted !== false,
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
