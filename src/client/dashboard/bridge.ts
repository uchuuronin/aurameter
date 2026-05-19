/**
 * devvit bridge — typed wrapper around the devvit web sdk postMessage api.
 *
 * the custom post iframe communicates with the devvit server exclusively
 * through this module. nothing else in the client touches window.parent.
 *
 * usage:
 *   bridge.send({ type: 'ready' });
 *   bridge.onMessage((msg) => { ... });
 */

import type { clientMessage, serverMessage } from '../../core/dashboard/types.js';

type messageHandler = (msg: serverMessage) => void;

class DevvitBridge {
  private handlers: messageHandler[] = [];

  constructor() {
    window.addEventListener('message', (ev) => {
      // devvit wraps messages in { type: 'devvit-message', data: { message: ... } }
      const raw = ev.data as { type?: string; data?: { message?: unknown } };
      if (raw?.type !== 'devvit-message') return;
      const msg = raw?.data?.message as serverMessage | undefined;
      if (!msg) return;
      for (const h of this.handlers) h(msg);
    });
  }

  send(msg: clientMessage): void {
    window.parent.postMessage(
      { type: 'devvit-message', data: { message: msg } },
      '*'
    );
  }

  onMessage(handler: messageHandler): () => void {
    this.handlers.push(handler);
    return () => {
      this.handlers = this.handlers.filter((h) => h !== handler);
    };
  }
}

export const bridge = new DevvitBridge();
