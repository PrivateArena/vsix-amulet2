import * as vscode from 'vscode';
import type { PiSidebarProvider } from './provider';
import type { EditorChatManager } from './editor/panel-manager';
import type { SessionManager } from './session/session-manager';
import type { Logger } from './runtime/pi-runtime';

export function registerCommands(
  context: vscode.ExtensionContext,
  sessions: SessionManager,
  provider: PiSidebarProvider,
  editorManager: EditorChatManager,
  log: Logger,
): void {
  const reg = (id: string, fn: (...args: any[]) => any) =>
    context.subscriptions.push(vscode.commands.registerCommand(id, fn));

  reg('amulet.newChat', () => provider.dispatch({ type: 'newChat' }));
  reg('amulet.abort', () => provider.dispatch({ type: 'abort' }));
  reg('amulet.compact', () => provider.dispatch({ type: 'compact' }));
  reg('amulet.cycleModel', () => provider.dispatch({ type: 'cycleModel' }));
  reg('amulet.openChatInEditor', () => editorManager.open());
  reg('amulet.exportChat', () => provider.dispatch({ type: 'exportChat' }));
  reg('amulet.editMessage', () =>
    provider.dispatch({ type: 'openForkPicker' }),
  );

  reg('amulet.cycleThinkingLevel', async () => {
    const runtime = sessions.getActiveRuntime();
    if (!runtime.isReady) return;
    const result = await runtime.cycleThinkingLevel();
    if (result)
      vscode.window.setStatusBarMessage(
        `Amulet thinking: ${result.level}`,
        2000,
      );
    await provider.dispatch({ type: 'requestState' });
  });

  reg('amulet.focusInput', async () => {
    await provider.reveal();
    provider.focusInput();
  });

  reg('amulet.switchModel', () => switchModel(sessions, provider, log));

  reg('amulet.addFileToChat', async (uri?: vscode.Uri) => {
    const target = uri ?? vscode.window.activeTextEditor?.document.uri;
    if (!target) return;
    const rel = vscode.workspace.asRelativePath(target, false);
    await provider.reveal();
    provider.insertText(`@${rel} `);
    provider.focusInput();
  });

  reg('amulet.restartRuntime', async () => {
    await vscode.window.withProgress(
      {
        location: { viewId: 'amulet.chatView' },
        title: 'Restarting pi runtime…',
      },
      async () => {
        await sessions.restartAll();
        await provider.reconnect();
      },
    );
  });

  reg('amulet.showLog', () => log.show());
}

async function switchModel(
  sessions: SessionManager,
  provider: PiSidebarProvider,
  log: Logger,
): Promise<void> {
  const runtime = sessions.getActiveRuntime();
  if (!runtime.isReady) {
    void vscode.window.showWarningMessage('Amulet runtime is not ready yet.');
    return;
  }
  try {
    const models = await runtime.getAvailableModels();
    if (models.length === 0) {
      void vscode.window.showWarningMessage(
        'No models available. Check your pi auth configuration.',
      );
      return;
    }
    const current = (await runtime.getState()).model;
    const items: (vscode.QuickPickItem & {
      provider: string;
      modelId: string;
    })[] = models.map((m) => ({
      label: m.name || m.id,
      description: m.provider,
      detail:
        current && current.id === m.id && current.provider === m.provider
          ? '$(check) current'
          : undefined,
      provider: m.provider,
      modelId: m.id,
    }));
    const picked = await vscode.window.showQuickPick(items, {
      title: 'Switch Model',
      placeHolder: 'Select a model',
      matchOnDescription: true,
    });
    if (!picked) return;
    await provider.dispatch({
      type: 'setModel',
      provider: picked.provider,
      modelId: picked.modelId,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error(`switchModel failed: ${message}`);
    void vscode.window.showErrorMessage(`Amulet: ${message}`);
  }
}
