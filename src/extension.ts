import * as vscode from 'vscode';
import { createMediaPlayerService } from './player/PlayerServiceFactory';
import { MusicSidebarProvider } from './provider/MusicSidebarProvider';
import { YouTubePlayerServer } from './provider/YouTubePlayerServer';
import { YouTubeSidebarProvider } from './provider/YouTubeSidebarProvider';
import { getBrowserMusicConfiguration } from './util/config';
import { OutputChannelLogger } from './util/logger';

const COMMANDS = {
  playPause: 'browserMusicSidebar.playPause',
  next: 'browserMusicSidebar.next',
  previous: 'browserMusicSidebar.previous',
  refresh: 'browserMusicSidebar.refresh',
} as const;

export const activate = async (
  context: vscode.ExtensionContext,
): Promise<void> => {
  const logger = new OutputChannelLogger();
  const youtubePlayerServer = new YouTubePlayerServer(logger);
  await youtubePlayerServer.start();
  const playerService = createMediaPlayerService(
    context.extensionUri,
    () => getBrowserMusicConfiguration().player,
    logger,
  );
  const provider = new MusicSidebarProvider(
    context.extensionUri,
    playerService,
    logger,
    youtubePlayerServer.getUrl(),
    (videoId) => youtubePlayerServer.resolveVideoUrl(videoId),
  );
  const youtubeProvider = new YouTubeSidebarProvider(
    context.extensionUri,
    youtubePlayerServer,
    logger,
  );

  context.subscriptions.push(
    logger,
    youtubePlayerServer,
    provider,
    youtubeProvider,
    vscode.window.registerWebviewViewProvider(
      MusicSidebarProvider.viewType,
      provider,
      {
        webviewOptions: {
          retainContextWhenHidden: true,
        },
      },
    ),
    vscode.window.registerWebviewViewProvider(
      YouTubeSidebarProvider.viewType,
      youtubeProvider,
      {
        webviewOptions: {
          retainContextWhenHidden: true,
        },
      },
    ),
    vscode.commands.registerCommand(COMMANDS.playPause, () =>
      provider.playPause(),
    ),
    vscode.commands.registerCommand(COMMANDS.next, () => provider.next()),
    vscode.commands.registerCommand(COMMANDS.previous, () =>
      provider.previous(),
    ),
    vscode.commands.registerCommand(COMMANDS.refresh, () => provider.refresh()),
  );

  logger.info('Browser Music Sidebar activated');
};

export const deactivate = (): void => {
  // VS Code disposes all subscriptions registered by activate.
};
