import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Logger } from '../util/logger';
import {
  createEmptyPlayerState,
  NoActivePlayerError,
  PlayerDependencyMissingError,
  UnsupportedPlayerCommandError,
  type MediaPlayerService,
  type PlaybackStatus,
  type PlayerState,
  type RepeatMode,
} from './PlayerTypes';

const execFileAsync = promisify(execFile);
const COMMAND_TIMEOUT_MS = 8_000;
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

interface ProcessError extends Error {
  readonly code?: string | number;
  readonly stderr?: string;
  readonly stdout?: string;
}

type WindowsAction =
  | 'GetState'
  | 'Toggle'
  | 'Previous'
  | 'Next'
  | 'SeekRelative'
  | 'SeekTo'
  | 'SetShuffle'
  | 'SetRepeat';

export interface WindowsMediaRunner {
  run(
    action: WindowsAction,
    player: string,
    value?: string,
  ): Promise<string>;
}

export class PowerShellWindowsMediaRunner implements WindowsMediaRunner {
  public constructor(private readonly scriptPath: string) {}

  public async run(
    action: WindowsAction,
    player: string,
    value?: string,
  ): Promise<string> {
    const arguments_ = [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      this.scriptPath,
      '-Action',
      action,
      '-Player',
      player,
    ];
    if (value !== undefined) {
      arguments_.push('-Value', value);
    }

    try {
      const { stdout } = await execFileAsync('powershell.exe', arguments_, {
        encoding: 'utf8',
        timeout: COMMAND_TIMEOUT_MS,
        maxBuffer: MAX_OUTPUT_BYTES,
        windowsHide: true,
      });
      return stdout.replace(/^\uFEFF/u, '').trim();
    } catch (error: unknown) {
      const processError = error as ProcessError;
      if (processError.code === 'ENOENT') {
        throw new PlayerDependencyMissingError(
          'Windows PowerShell is not available.',
        );
      }
      const output =
        `${processError.message} ${processError.stderr ?? ''} ${processError.stdout ?? ''}`.toLowerCase();
      if (output.includes('no active media')) {
        throw new NoActivePlayerError();
      }
      throw error;
    }
  }
}

interface WindowsState {
  readonly active?: unknown;
  readonly playerName?: unknown;
  readonly title?: unknown;
  readonly artist?: unknown;
  readonly album?: unknown;
  readonly artworkUrl?: unknown;
  readonly status?: unknown;
  readonly positionSeconds?: unknown;
  readonly lengthSeconds?: unknown;
  readonly shuffle?: unknown;
  readonly repeat?: unknown;
  readonly capabilities?: {
    readonly previous?: unknown;
    readonly next?: unknown;
    readonly seek?: unknown;
    readonly shuffle?: unknown;
    readonly repeat?: unknown;
  };
}

type PlayerSelector = () => string;

export class WindowsPlayerService implements MediaPlayerService {
  public constructor(
    private readonly getPlayer: PlayerSelector,
    private readonly logger: Logger,
    scriptPath: string,
    private readonly runner: WindowsMediaRunner =
      new PowerShellWindowsMediaRunner(scriptPath),
  ) {}

  public async getState(): Promise<PlayerState> {
    try {
      const raw = this.parseState(await this.run('GetState'));
      if (raw.active !== true) {
        return createEmptyPlayerState();
      }

      return {
        installed: true,
        active: true,
        playerName: this.readString(raw.playerName) || 'Windows media session',
        title: this.readString(raw.title) || 'Unknown title',
        artist: this.readString(raw.artist) || 'Unknown artist',
        album: this.readString(raw.album),
        artworkUrl: this.readArtworkUrl(raw.artworkUrl),
        status: this.parseStatus(raw.status),
        positionSeconds: Math.max(0, this.readNumber(raw.positionSeconds)),
        lengthSeconds: Math.max(0, this.readNumber(raw.lengthSeconds)),
        volume: 0,
        muted: false,
        shuffle:
          typeof raw.shuffle === 'boolean' ? raw.shuffle : null,
        repeat: this.parseRepeat(raw.repeat),
        capabilities: {
          previous: raw.capabilities?.previous === true,
          next: raw.capabilities?.next === true,
          seek: raw.capabilities?.seek === true,
          volume: false,
          mute: false,
          shuffle: raw.capabilities?.shuffle === true,
          repeat: raw.capabilities?.repeat === true,
        },
      };
    } catch (error: unknown) {
      if (error instanceof PlayerDependencyMissingError) {
        return createEmptyPlayerState(error.message, false);
      }
      if (error instanceof NoActivePlayerError) {
        return createEmptyPlayerState();
      }

      this.logger.error('Failed to read Windows media state', error);
      return createEmptyPlayerState('Unable to read Windows media information');
    }
  }

  public async playPause(): Promise<void> {
    await this.run('Toggle');
  }

  public async previous(): Promise<void> {
    await this.run('Previous');
  }

  public async next(): Promise<void> {
    await this.run('Next');
  }

  public async seekRelative(offsetSeconds: number): Promise<void> {
    if (!Number.isFinite(offsetSeconds) || offsetSeconds === 0) {
      return;
    }
    await this.run('SeekRelative', String(offsetSeconds));
  }

  public async seekTo(positionSeconds: number): Promise<void> {
    if (!Number.isFinite(positionSeconds)) {
      return;
    }
    await this.run('SeekTo', String(Math.max(0, positionSeconds)));
  }

  public setVolume(): Promise<void> {
    return Promise.reject(
      new UnsupportedPlayerCommandError('Volume control'),
    );
  }

  public toggleMute(): Promise<void> {
    return Promise.reject(new UnsupportedPlayerCommandError('Mute'));
  }

  public async toggleShuffle(): Promise<void> {
    const state = await this.getState();
    if (!state.active) {
      throw new NoActivePlayerError();
    }
    if (!state.capabilities.shuffle) {
      throw new UnsupportedPlayerCommandError('Shuffle');
    }
    await this.run('SetShuffle', String(state.shuffle !== true));
  }

  public async cycleRepeat(): Promise<void> {
    const state = await this.getState();
    if (!state.active) {
      throw new NoActivePlayerError();
    }
    if (!state.capabilities.repeat) {
      throw new UnsupportedPlayerCommandError('Repeat');
    }
    const next =
      state.repeat === 'None'
        ? 'Track'
        : state.repeat === 'Track'
          ? 'Playlist'
          : 'None';
    await this.run('SetRepeat', next);
  }

  private run(action: WindowsAction, value?: string): Promise<string> {
    return this.runner.run(action, this.getPlayer().trim(), value);
  }

  private parseState(output: string): WindowsState {
    if (output.length === 0) {
      return {};
    }
    const parsed: unknown = JSON.parse(output);
    return typeof parsed === 'object' && parsed !== null ? parsed : {};
  }

  private readString(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
  }

  private readNumber(value: unknown): number {
    const parsed =
      typeof value === 'number'
        ? value
        : typeof value === 'string'
          ? Number(value)
          : Number.NaN;
    return Number.isFinite(parsed) ? parsed : 0;
  }

  private parseStatus(value: unknown): PlaybackStatus {
    const status = this.readString(value);
    if (status === 'Playing' || status === 'Paused' || status === 'Stopped') {
      return status;
    }
    return 'Unknown';
  }

  private parseRepeat(value: unknown): RepeatMode {
    const repeat = this.readString(value);
    if (repeat === 'None' || repeat === 'Track') {
      return repeat;
    }
    return repeat === 'List' || repeat === 'Playlist' ? 'Playlist' : 'Unknown';
  }

  private readArtworkUrl(value: unknown): string | undefined {
    if (
      typeof value === 'string' &&
      value.length <= MAX_OUTPUT_BYTES &&
      /^data:image\/[a-zA-Z0-9.+-]+;base64,/u.test(value)
    ) {
      return value;
    }
    return undefined;
  }
}
