import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Logger } from '../util/logger';
import {
  createEmptyPlayerState,
  NoActivePlayerError,
  NowPlayingCliNotInstalledError,
  UnsupportedPlayerCommandError,
  type MediaPlayerService,
  type PlaybackStatus,
  type PlayerState,
  type RepeatMode,
} from './PlayerTypes';

const execFileAsync = promisify(execFile);
const COMMAND_TIMEOUT_MS = 4_000;
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const MAC_PLAYER_NAME = 'macOS Now Playing';

interface ProcessError extends Error {
  readonly code?: string | number;
  readonly stderr?: string;
}

export interface NowPlayingRunner {
  run(arguments_: readonly string[]): Promise<string>;
}

export class ExecFileNowPlayingRunner implements NowPlayingRunner {
  public async run(arguments_: readonly string[]): Promise<string> {
    try {
      const { stdout } = await execFileAsync(
        'nowplaying-cli',
        [...arguments_],
        {
          encoding: 'utf8',
          timeout: COMMAND_TIMEOUT_MS,
          maxBuffer: MAX_OUTPUT_BYTES,
          windowsHide: true,
        },
      );
      return stdout.trim();
    } catch (error: unknown) {
      const processError = error as ProcessError;
      if (processError.code === 'ENOENT') {
        throw new NowPlayingCliNotInstalledError();
      }

      const output = `${processError.message} ${processError.stderr ?? ''}`;
      if (output.toLowerCase().includes('no now playing')) {
        throw new NoActivePlayerError();
      }
      throw error;
    }
  }
}

interface MacMetadata {
  readonly title?: unknown;
  readonly artist?: unknown;
  readonly album?: unknown;
  readonly duration?: unknown;
  readonly elapsedTime?: unknown;
  readonly playbackRate?: unknown;
  readonly artworkData?: unknown;
  readonly artworkMIMEType?: unknown;
  readonly uniqueIdentifier?: unknown;
  readonly shuffleMode?: unknown;
  readonly repeatMode?: unknown;
}

export class MacPlayerService implements MediaPlayerService {
  public constructor(
    private readonly logger: Logger,
    private readonly runner: NowPlayingRunner = new ExecFileNowPlayingRunner(),
  ) {}

  public async getState(): Promise<PlayerState> {
    try {
      const output = await this.runner.run([
        'get',
        '--json',
        'title',
        'artist',
        'album',
        'duration',
        'elapsedTime',
        'playbackRate',
        'artworkData',
        'artworkMIMEType',
        'uniqueIdentifier',
        'shuffleMode',
        'repeatMode',
      ]);
      const metadata = this.parseMetadata(output);
      const title = this.readString(metadata.title);
      const identifier = this.readString(metadata.uniqueIdentifier);
      if (title.length === 0 && identifier.length === 0) {
        return createEmptyPlayerState();
      }

      const playbackRate = this.readNumber(metadata.playbackRate, 0);
      const duration = Math.max(0, this.readNumber(metadata.duration, 0));
      return {
        installed: true,
        active: true,
        playerName: MAC_PLAYER_NAME,
        title: title || 'Unknown title',
        artist: this.readString(metadata.artist) || 'Unknown artist',
        album: this.readString(metadata.album),
        artworkUrl: this.createArtworkUrl(
          metadata.artworkData,
          metadata.artworkMIMEType,
        ),
        status: this.parseStatus(playbackRate),
        positionSeconds: Math.max(
          0,
          this.readNumber(metadata.elapsedTime, 0),
        ),
        lengthSeconds: duration,
        volume: 0,
        muted: false,
        shuffle: this.parseShuffle(metadata.shuffleMode),
        repeat: this.parseRepeat(metadata.repeatMode),
        capabilities: {
          previous: true,
          next: true,
          seek: duration > 0,
          volume: false,
          mute: false,
          shuffle: false,
          repeat: false,
        },
      };
    } catch (error: unknown) {
      if (error instanceof NowPlayingCliNotInstalledError) {
        return createEmptyPlayerState(error.message, false);
      }
      if (error instanceof NoActivePlayerError) {
        return createEmptyPlayerState();
      }

      this.logger.error('Failed to read macOS Now Playing state', error);
      return createEmptyPlayerState('Unable to read macOS media information');
    }
  }

  public async playPause(): Promise<void> {
    await this.runner.run(['togglePlayPause']);
  }

  public async previous(): Promise<void> {
    await this.runner.run(['previous']);
  }

  public async next(): Promise<void> {
    await this.runner.run(['next']);
  }

  public async seekRelative(offsetSeconds: number): Promise<void> {
    if (!Number.isFinite(offsetSeconds) || offsetSeconds === 0) {
      return;
    }
    const state = await this.getState();
    if (!state.active) {
      throw new NoActivePlayerError();
    }
    await this.seekTo(state.positionSeconds + offsetSeconds);
  }

  public async seekTo(positionSeconds: number): Promise<void> {
    if (!Number.isFinite(positionSeconds)) {
      return;
    }
    await this.runner.run(['seek', String(Math.max(0, positionSeconds))]);
  }

  public setVolume(): Promise<void> {
    return Promise.reject(
      new UnsupportedPlayerCommandError('Volume control'),
    );
  }

  public toggleMute(): Promise<void> {
    return Promise.reject(new UnsupportedPlayerCommandError('Mute'));
  }

  public toggleShuffle(): Promise<void> {
    return Promise.reject(new UnsupportedPlayerCommandError('Shuffle'));
  }

  public cycleRepeat(): Promise<void> {
    return Promise.reject(new UnsupportedPlayerCommandError('Repeat'));
  }

  private parseMetadata(output: string): MacMetadata {
    if (output.length === 0) {
      return {};
    }
    const parsed: unknown = JSON.parse(output);
    return typeof parsed === 'object' && parsed !== null ? parsed : {};
  }

  private readString(value: unknown): string {
    return typeof value === 'string' && value !== 'null' ? value.trim() : '';
  }

  private readNumber(value: unknown, fallback: number): number {
    const parsed =
      typeof value === 'number'
        ? value
        : typeof value === 'string'
          ? Number(value)
          : Number.NaN;
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  private parseStatus(playbackRate: number): PlaybackStatus {
    return playbackRate > 0 ? 'Playing' : 'Paused';
  }

  private parseShuffle(value: unknown): boolean | null {
    if (typeof value === 'boolean') {
      return value;
    }
    if (typeof value === 'string') {
      if (/^(on|true|songs|albums)$/iu.test(value)) {
        return true;
      }
      if (/^(off|false)$/iu.test(value)) {
        return false;
      }
    }
    return null;
  }

  private parseRepeat(value: unknown): RepeatMode {
    const normalized = this.readString(value).toLowerCase();
    if (normalized === 'off' || normalized === 'none') {
      return 'None';
    }
    if (normalized === 'one' || normalized === 'track') {
      return 'Track';
    }
    if (normalized === 'all' || normalized === 'playlist') {
      return 'Playlist';
    }
    return 'Unknown';
  }

  private createArtworkUrl(
    artworkData: unknown,
    artworkMimeType: unknown,
  ): string | undefined {
    const data = this.readString(artworkData);
    if (data.length === 0 || data.length > MAX_OUTPUT_BYTES) {
      return undefined;
    }
    if (/^data:image\/[a-zA-Z0-9.+-]+;base64,/u.test(data)) {
      return data;
    }

    const requestedMimeType = this.readString(artworkMimeType);
    const mimeType = /^image\/[a-zA-Z0-9.+-]+$/u.test(requestedMimeType)
      ? requestedMimeType
      : 'image/jpeg';
    return /^[a-zA-Z0-9+/=\r\n]+$/u.test(data)
      ? `data:${mimeType};base64,${data.replace(/\s/gu, '')}`
      : undefined;
  }
}
