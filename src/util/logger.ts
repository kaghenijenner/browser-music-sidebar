import * as vscode from 'vscode';

export interface Logger {
  info(message: string): void;
  error(message: string, error?: unknown): void;
}

export class OutputChannelLogger implements Logger, vscode.Disposable {
  private readonly outputChannel = vscode.window.createOutputChannel(
    'Browser Music Sidebar',
    { log: true },
  );

  public info(message: string): void {
    this.outputChannel.info(message);
  }

  public error(message: string, error?: unknown): void {
    const details =
      error instanceof Error
        ? error.message
        : typeof error === 'string'
          ? error
          : error === undefined
            ? ''
            : 'Unknown error';
    this.outputChannel.error(details.length > 0 ? `${message}: ${details}` : message);
  }

  public dispose(): void {
    this.outputChannel.dispose();
  }
}
