import * as vscode from 'vscode';

const CONFIGURATION_SECTION = 'browserMusicSidebar';
const MINIMUM_REFRESH_INTERVAL = 500;

export interface BrowserMusicConfiguration {
  readonly player: string;
  readonly refreshInterval: number;
  readonly showTrackNotifications: boolean;
  readonly showYouTubeVideo: boolean;
}

export const getBrowserMusicConfiguration = (): BrowserMusicConfiguration => {
  const configuration = vscode.workspace.getConfiguration(CONFIGURATION_SECTION);
  const configuredInterval = configuration.get<number>('refreshInterval', 1500);

  return {
    player: configuration.get<string>('player', 'chromium').trim(),
    refreshInterval: Math.max(MINIMUM_REFRESH_INTERVAL, configuredInterval),
    showTrackNotifications: configuration.get<boolean>(
      'showTrackNotifications',
      false,
    ),
    showYouTubeVideo: configuration.get<boolean>('showYouTubeVideo', true),
  };
};

export const affectsBrowserMusicConfiguration = (
  event: vscode.ConfigurationChangeEvent,
): boolean => event.affectsConfiguration(CONFIGURATION_SECTION);
