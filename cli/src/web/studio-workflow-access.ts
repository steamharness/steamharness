import type { Controller } from './workflow-controller';
import type { WorkflowHistory } from './workflow-history';
import { t } from './localization';

/** Studio can open the same storage from several CLI processes. Never write a stale snapshot. */
export class StudioHistoryAccess {
  private pending: Promise<unknown> = Promise.resolve();

  constructor(private readonly history: WorkflowHistory, private readonly controller: Controller,
    private readonly available: () => boolean, private readonly changed: () => void) {}

  async refresh(): Promise<void> { await this.run('read', () => undefined); }

  run<T>(mode: 'read' | 'write' | 'schedule', action: () => T | Promise<T>): Promise<T> {
    const operation = this.pending.then(async () => {
      try {
        if (!this.available()) {
          if (mode === 'write') throw new Error(t('Workflow workspace has closed.'));
          return await action();
        }
        if (mode === 'write') {
          const saved = await this.history.prepareWrite();
          if (saved) this.controller.replace(saved, { preserveSelection: true });
        } else if (mode === 'read') {
          await this.releaseIdle();
          if (!this.history.ownsHistory) {
            const saved = await this.history.readChanged();
            if (saved && this.available()) {
              this.controller.replace(saved, { observing: true, preserveSelection: true });
              this.changed();
            }
          }
        }
        return await action();
      } finally { await this.releaseIdle(); }
    });
    this.pending = operation.catch(() => undefined);
    return operation;
  }

  private async releaseIdle(): Promise<void> {
    if (this.history.ownsHistory && !this.controller.running) await this.history.release();
  }
}
