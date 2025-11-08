import * as path from 'node:path';
import type * as vscode from 'vscode';
import type { Logger } from '../util/logger';
import { MacPlayerService } from './MacPlayerService';
import { PlayerService } from './PlayerService';
import {
  createEmptyPlayerState,
  UnsupportedPlayerCommandError,
  type MediaPlayerService,
  type PlayerState,
} from './PlayerTypes';
import { WindowsPlayerService } from './WindowsPlayerService';

type PlayerSelector = () => string;

class UnsupportedPlatformPlayerService implements MediaPlayerService {
  public constructor(private readonly platform: string) {}

  public getState(): Promise<PlayerState> {
    return Promise.resolve(
      createEmptyPlayerState(
        `Music YouTube Sidebar does not support ${this.platform}.`,
        false,
      ),
    );
  }

  public playPause(): Promise<void> {
    return this.rejectUnsupported();
  }

  public previous(): Promise<void> {
    return this.rejectUnsupported();
  }

  public next(): Promise<void> {
    return this.rejectUnsupported();
  }

  public seekRelative(): Promise<void> {
    return this.rejectUnsupported();
  }

  public seekTo(): Promise<void> {
    return this.rejectUnsupported();
  }

  public setVolume(): Promise<void> {
    return this.rejectUnsupported();
  }

  public toggleMute(): Promise<void> {
    return this.rejectUnsupported();
  }

  public toggleShuffle(): Promise<void> {
    return this.rejectUnsupported();
  }

  public cycleRepeat(): Promise<void> {
    return this.rejectUnsupported();
  }

  private rejectUnsupported(): Promise<never> {
    return Promise.reject(new UnsupportedPlayerCommandError('Media control'));
  }
}

export const createMediaPlayerService = (
  extensionUri: vscode.Uri,
  getPlayer: PlayerSelector,
  logger: Logger,
  platform: NodeJS.Platform = process.platform,
): MediaPlayerService => {
  switch (platform) {
    case 'linux':
      return new PlayerService(getPlayer, logger);
    case 'darwin':
      return new MacPlayerService(logger);
    case 'win32':
      return new WindowsPlayerService(
        getPlayer,
        logger,
        path.join(
          extensionUri.fsPath,
          'scripts',
          'windows-media-control.ps1',
        ),
      );
    default:
      return new UnsupportedPlatformPlayerService(platform);
  }
};
