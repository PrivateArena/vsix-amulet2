import * as vscode from 'vscode';
import type { HostMessage, WebviewMessage } from '../shared/protocol';
import type { Logger } from './runtime/pi-runtime';
import type { SessionManager } from './session/session-manager';
import {
  createWebviewSurface,
  type WebviewSurface,
} from './webview/webview-surface';

/** Cap on posts held while the webview boots — a backstop, not a real limit. */
const MAX_QUEUED_POSTS = 32;

export class PiSidebarProvider implements vscode.WebviewViewProvider {
  static readonly viewType = 'pintra.chatView';

  private view: vscode.WebviewView | undefined;
  private surface: WebviewSurface | undefined;
  /** True once the webview app has signalled `ready` and can receive posts. */
  private webviewReady = false;
  /** Posts made before the app booted; flushed on `ready`. Bounded. */
  private queued: HostMessage[] = [];

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly sessions: SessionManager,
    private readonly log: Logger,
    private readonly appVersion: string = '',
  ) {}

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    // A reload swaps in a fresh app instance, so posts have to queue again
    // until it announces itself.
    this.webviewReady = false;
    const webview = webviewView.webview;
    webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.extensionUri, 'dist'),
        vscode.Uri.joinPath(this.extensionUri, 'media'),
      ],
    };

    const surface = createWebviewSurface(
      webview,
      this.extensionUri,
      this.sessions,
      this.log,
      this.appVersion,
      // The sidebar always opens on a fresh chat; the prior conversation stays
      // in session history (non-destructive), reachable via the history dropdown.
      {
        isVisible: () => webviewView.visible,
        openFresh: true,
        onReady: () => this.flush(webviewView),
      },
    );
    this.surface = surface;

    webviewView.onDidDispose(() => {
      surface.dispose();
      if (this.surface === surface) this.surface = undefined;
      if (this.view === webviewView) {
        this.view = undefined;
        this.webviewReady = false;
      }
    });
  }

  private flush(webviewView: vscode.WebviewView): void {
    if (this.view !== webviewView) return;
    this.webviewReady = true;
    const queued = this.queued;
    this.queued = [];
    for (const message of queued) void webviewView.webview.postMessage(message);
  }

  post(message: HostMessage): void {
    // Before `ready`, both `this.view` being unset (the command activated the
    // extension) and the app still booting mean a post is silently lost — so
    // hold it and replay on `ready` instead. Bounded so a view that never
    // finishes booting can't accumulate forever.
    if (!this.view || !this.webviewReady) {
      this.queued = [...this.queued, message].slice(-MAX_QUEUED_POSTS);
      return;
    }
    void this.view.webview.postMessage(message);
  }

  async reveal(): Promise<void> {
    await vscode.commands.executeCommand('pintra.chatView.focus');
  }

  focusInput(): void {
    this.post({ type: 'focusInput' });
  }

  insertText(text: string): void {
    this.post({ type: 'insertText', text });
  }

  async reconnect(): Promise<void> {
    await this.surface?.bridge.connect();
  }

  async dispatch(message: WebviewMessage): Promise<void> {
    await this.reveal();
    if (!this.surface) {
      await new Promise((r) => setTimeout(r, 0));
    }
    await this.surface?.bridge.handleMessage(message);
  }
}
