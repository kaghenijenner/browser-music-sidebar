import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Logger } from '../util/logger';
import {
  createEmptyPlayerState,
  NoActivePlayerError,
  PlayerctlNotInstalledError,
  type MediaPlayerService,
  type PlaybackStatus,
  type PlayerState,
  type RepeatMode,
} from './PlayerTypes';

const execFileAsync = promisify(execFile);
const FIELD_SEPARATOR = '\u001f';
const COMMAND_TIMEOUT_MS = 4_000;
const DEFAULT_UNMUTED_VOLUME = 0.5;

interface ProcessError extends Error {
  readonly code?: string | number;
  readonly stderr?: string;
}

export interface PlayerctlRunner {
  run(arguments_: readonly string[]): Promise<string>;
}

export class ExecFilePlayerctlRunner implements PlayerctlRunner {
  public async run(arguments_: readonly string[]): Promise<string> {
    try {
      const { stdout } = await execFileAsync('playerctl', [...arguments_], {
        encoding: 'utf8',
        timeout: COMMAND_TIMEOUT_MS,
        maxBuffer: 1024 * 1024,
        windowsHide: true,
      });
      return stdout.trim();
    } catch (error: unknown) {
      const processError = error as ProcessError;
      if (processError.code === 'ENOENT') {
        throw new PlayerctlNotInstalledError();
      }

      const output = `${processError.message} ${processError.stderr ?? ''}`;
      if (
        output.includes('No players found') ||
        output.includes('No player could handle this command')
      ) {
        throw new NoActivePlayerError();
      }
      throw error;
    }
  }
}

type PlayerSelector = () => string;

export class PlayerService implements MediaPlayerService {
  private lastAudibleVolume = DEFAULT_UNMUTED_VOLUME;

  public constructor(
    private readonly getPlayer: PlayerSelector,
    private readonly logger: Logger,
    private readonly runner: PlayerctlRunner = new ExecFilePlayerctlRunner(),
  ) {}

  public async getState(): Promise<PlayerState> {
    try {
      const [status, metadata] = await Promise.all([
        this.run(['status']),
        this.run([
          'metadata',
          '--format',
          [
            '{{playerName}}',
            '{{title}}',
            '{{artist}}',
            '{{album}}',
            '{{mpris:artUrl}}',
            '{{mpris:length}}',
          ].join(FIELD_SEPARATOR),
        ]),
      ]);

      const fields = metadata.split(FIELD_SEPARATOR);
      const playbackStatus = this.parseStatus(status);
      const title = fields[1]?.trim() ?? '';
      const artist = fields[2]?.trim() ?? '';
      const album = fields[3]?.trim() ?? '';

      if (playbackStatus === 'Stopped' && title.length === 0) {
        return createEmptyPlayerState();
      }

      const [position, volume, shuffle, repeat] = await Promise.all([
        this.tryRun(['position']),
        this.tryRun(['volume']),
        this.tryRun(['shuffle']),
        this.tryRun(['loop']),
      ]);
      const parsedVolume = this.parseBoundedNumber(volume, 0, 1, 0);
      const parsedLength =
        this.parseBoundedNumber(
          fields[5],
          0,
          Number.MAX_SAFE_INTEGER,
          0,
        ) / 1_000_000;
      if (parsedVolume > 0) {
        this.lastAudibleVolume = parsedVolume;
      }

      return {
        installed: true,
        active: true,
        playerName: fields[0]?.trim() ?? this.getPlayer(),
        title: title || 'Unknown title',
        artist: artist || 'Unknown artist',
        album,
        artworkUrl: this.parseArtworkUrl(fields[4]),
        status: playbackStatus,
        positionSeconds: this.parseBoundedNumber(
          position,
          0,
          Number.MAX_SAFE_INTEGER,
          0,
        ),
        lengthSeconds: parsedLength,
        volume: parsedVolume,
        muted: parsedVolume <= 0.001,
        shuffle: this.parseShuffle(shuffle),
        repeat: this.parseRepeat(repeat),
        capabilities: {
          previous: true,
          next: true,
          seek: position !== undefined && parsedLength > 0,
          volume: volume !== undefined,
          mute: volume !== undefined,
          shuffle: shuffle !== undefined,
          repeat: repeat !== undefined,
        },
      };
    } catch (error: unknown) {
      if (error instanceof PlayerctlNotInstalledError) {
        return createEmptyPlayerState(error.message, false);
      }
      if (error instanceof NoActivePlayerError) {
        return createEmptyPlayerState();
      }

      this.logger.error('Failed to read player state', error);
      return createEmptyPlayerState('Unable to read media information');
    }
  }

  public async playPause(): Promise<void> {
    await this.run(['play-pause']);
  }

  public async previous(): Promise<void> {
    await this.run(['previous']);
  }

  public async next(): Promise<void> {
    await this.run(['next']);
  }

  public async seekRelative(offsetSeconds: number): Promise<void> {
    if (!Number.isFinite(offsetSeconds) || offsetSeconds === 0) {
      return;
    }
    const suffix = offsetSeconds > 0 ? '+' : '-';
    await this.run(['position', `${Math.abs(offsetSeconds)}${suffix}`]);
  }

  public async seekTo(positionSeconds: number): Promise<void> {
    if (!Number.isFinite(positionSeconds)) {
      return;
    }
    await this.run(['position', String(Math.max(0, positionSeconds))]);
  }

  public async setVolume(volume: number): Promise<void> {
    if (!Number.isFinite(volume)) {
      return;
    }
    const boundedVolume = Math.min(1, Math.max(0, volume));
    await this.run(['volume', String(boundedVolume)]);
    if (boundedVolume > 0) {
      this.lastAudibleVolume = boundedVolume;
    }
  }

  public async toggleMute(): Promise<void> {
    const currentVolume = this.parseBoundedNumber(
      await this.run(['volume']),
      0,
      1,
      0,
    );
    if (currentVolume > 0.001) {
      this.lastAudibleVolume = currentVolume;
      await this.setVolume(0);
    } else {
      await this.setVolume(this.lastAudibleVolume);
    }
  }

  public async toggleShuffle(): Promise<void> {
    await this.run(['shuffle', 'Toggle']);
  }

  public async cycleRepeat(): Promise<void> {
    const current = this.parseRepeat(await this.tryRun(['loop']));
    const next: Exclude<RepeatMode, 'Unknown'> =
      current === 'None' ? 'Track' : current === 'Track' ? 'Playlist' : 'None';
    await this.run(['loop', next]);
  }

  private async run(arguments_: readonly string[]): Promise<string> {
    const configuredPlayer = this.getPlayer().trim();
    const playerArguments =
      configuredPlayer.length > 0 ? ['--player', configuredPlayer] : [];
    return this.runner.run([...playerArguments, ...arguments_]);
  }

  private async tryRun(arguments_: readonly string[]): Promise<string | undefined> {
    try {
      return await this.run(arguments_);
    } catch (error: unknown) {
      if (
        error instanceof PlayerctlNotInstalledError ||
        error instanceof NoActivePlayerError
      ) {
        throw error;
      }
      this.logger.info(`Optional player capability unavailable: ${arguments_[0] ?? ''}`);
      return undefined;
    }
  }

  private parseStatus(value: string): PlaybackStatus {
    if (value === 'Playing' || value === 'Paused' || value === 'Stopped') {
      return value;
    }
    return 'Unknown';
  }

  private parseShuffle(value: string | undefined): boolean | null {
    if (value === 'On') {
      return true;
    }
    if (value === 'Off') {
      return false;
    }
    return null;
  }

  private parseRepeat(value: string | undefined): RepeatMode {
    if (value === 'None' || value === 'Track' || value === 'Playlist') {
      return value;
    }
    return 'Unknown';
  }

  private parseBoundedNumber(
    value: string | undefined,
    minimum: number,
    maximum: number,
    fallback: number,
  ): number {
    const parsed = Number(value);
    return Number.isFinite(parsed)
      ? Math.min(maximum, Math.max(minimum, parsed))
      : fallback;
  }

  private parseArtworkUrl(value: string | undefined): string | undefined {
    const candidate = value?.trim();
    if (candidate === undefined || candidate.length === 0) {
      return undefined;
    }

    if (/^data:image\/[a-zA-Z0-9.+-]+(?:;base64)?,/u.test(candidate)) {
      return candidate;
    }

    try {
      const url = new URL(candidate);
      return url.protocol === 'https:' || url.protocol === 'http:'
        ? url.toString()
        : undefined;
    } catch {
      return undefined;
    }
  }
}
