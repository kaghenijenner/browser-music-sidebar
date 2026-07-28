export type PlaybackStatus = 'Playing' | 'Paused' | 'Stopped' | 'Unknown';
export type RepeatMode = 'None' | 'Track' | 'Playlist' | 'Unknown';

export interface PlayerCapabilities {
  readonly previous: boolean;
  readonly next: boolean;
  readonly seek: boolean;
  readonly volume: boolean;
  readonly mute: boolean;
  readonly shuffle: boolean;
  readonly repeat: boolean;
}

export interface PlayerState {
  readonly installed: boolean;
  readonly active: boolean;
  readonly playerName: string;
  readonly title: string;
  readonly artist: string;
  readonly album: string;
  readonly artworkUrl?: string;
  readonly status: PlaybackStatus;
  readonly positionSeconds: number;
  readonly lengthSeconds: number;
  readonly volume: number;
  readonly muted: boolean;
  readonly shuffle: boolean | null;
  readonly repeat: RepeatMode;
  readonly capabilities: PlayerCapabilities;
  readonly message?: string;
}

export interface MediaPlayerService {
  getState(): Promise<PlayerState>;
  playPause(): Promise<void>;
  previous(): Promise<void>;
  next(): Promise<void>;
  seekRelative(offsetSeconds: number): Promise<void>;
  seekTo(positionSeconds: number): Promise<void>;
  setVolume(volume: number): Promise<void>;
  toggleMute(): Promise<void>;
  toggleShuffle(): Promise<void>;
  cycleRepeat(): Promise<void>;
}

export const NO_PLAYER_CAPABILITIES: PlayerCapabilities = {
  previous: false,
  next: false,
  seek: false,
  volume: false,
  mute: false,
  shuffle: false,
  repeat: false,
};

export const createEmptyPlayerState = (
  message = 'No active media',
  installed = true,
): PlayerState => ({
  installed,
  active: false,
  playerName: '',
  title: '',
  artist: '',
  album: '',
  status: 'Unknown',
  positionSeconds: 0,
  lengthSeconds: 0,
  volume: 0,
  muted: false,
  shuffle: null,
  repeat: 'Unknown',
  capabilities: NO_PLAYER_CAPABILITIES,
  message,
});

export class PlayerDependencyMissingError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'PlayerDependencyMissingError';
  }
}

export class PlayerctlNotInstalledError extends PlayerDependencyMissingError {
  public constructor() {
    super('playerctl is not installed.');
    this.name = 'PlayerctlNotInstalledError';
  }
}

export class NowPlayingCliNotInstalledError extends PlayerDependencyMissingError {
  public constructor() {
    super('nowplaying-cli is not installed.');
    this.name = 'NowPlayingCliNotInstalledError';
  }
}

export class NoActivePlayerError extends Error {
  public constructor() {
    super('No active media');
    this.name = 'NoActivePlayerError';
  }
}

export class UnsupportedPlayerCommandError extends Error {
  public constructor(command: string) {
    super(`${command} is not supported by this platform or media player.`);
    this.name = 'UnsupportedPlayerCommandError';
  }
}
