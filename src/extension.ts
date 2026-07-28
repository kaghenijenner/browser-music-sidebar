import * as vscode from 'vscode';
import { createMediaPlayerService } from './player/PlayerServiceFactory';
import { MusicSidebarProvider } from './provider/MusicSidebarProvider';
import { getBrowserMusicConfiguration } from './util/config';
import { OutputChannelLogger } from './util/logger';

const COMMANDS = {
  playPause: 'browserMusicSidebar.playPause',
  next: 'browserMusicSidebar.next',
  previous: 'browserMusicSidebar.previous',
  refresh: 'browserMusicSidebar.refresh',
} as const;

export const activate = (context: vscode.ExtensionContext): void => {
  const logger = new OutputChannelLogger();
  const playerService = createMediaPlayerService(
    context.extensionUri,
    () => getBrowserMusicConfiguration().player,
    logger,
  );
  const provider = new MusicSidebarProvider(
    context.extensionUri,
    playerService,
    logger,
  );

  context.subscriptions.push(
    logger,
    provider,
    vscode.window.registerWebviewViewProvider(
      MusicSidebarProvider.viewType,
      provider,
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
