import session from 'express-session';
import type { ManagerLogContext, LogoutContent } from './operation-log.js';

declare module 'express-session' {
  interface SessionData {
    userId?: string;
    userName?: string;
    csrfToken?: string;
    mailOAuthState?: string;
    temporaryUserSign?: string;
    operationLogContext?: ManagerLogContext;
    logoutContent?: LogoutContent;
    userStart?: string;
    userEnd?: string;
  }
}

// Web.config leaves ASP.NET sessionState at its default 20-minute sliding idle timeout.
export const managerSessionIdleMs = 20 * 60 * 1000;

export class ManagerSessionStore extends session.MemoryStore {
  private readonly expiry = new Map<string, { timer: ReturnType<typeof setTimeout>; data: session.SessionData }>();
  constructor(
    private readonly ended: (data: session.SessionData) => Promise<void>,
    private readonly idleMs = managerSessionIdleMs,
  ) {
    super();
  }

  private renew(id: string, data: session.SessionData): void {
    const previous = this.expiry.get(id);
    if (previous) clearTimeout(previous.timer);
    const timer = setTimeout(() => this.destroy(id), this.idleMs);
    timer.unref();
    this.expiry.set(id, { timer, data: structuredClone(data) });
  }
  override set(id: string, data: session.SessionData, callback?: (error?: unknown) => void): void {
    this.renew(id, data);
    super.set(id, data, callback);
  }
  override touch(id: string, data: session.SessionData, callback?: () => void): void {
    this.renew(id, data);
    super.touch(id, data, callback);
  }
  override destroy(id: string, callback?: (error?: unknown) => void): void {
    const state = this.expiry.get(id);
    if (state) {
      clearTimeout(state.timer);
      this.expiry.delete(id);
    }
    super.destroy(id, (error) => {
      if (error || !state) return callback?.(error);
      void this.ended(state.data).then(
        () => callback?.(),
        (error2) => callback?.(error2),
      );
    });
  }
  override clear(callback?: (error?: unknown) => void): void {
    for (const { timer } of this.expiry.values()) clearTimeout(timer);
    this.expiry.clear();
    super.clear(callback);
  }
}
