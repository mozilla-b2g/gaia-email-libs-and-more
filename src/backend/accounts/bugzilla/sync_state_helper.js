import logic from 'logic';

import { millisecsToSeconds, makeDaysAgo } from 'shared/date';

/**
 * See `sync.md`.
 */
export default class BugzillaSyncStateHelper {
  constructor(ctx, rawSyncState, accountId, why) {
    logic.defineScope(this, 'BugzillaSyncState', { ctxId: ctx.id, why });

    if (!rawSyncState) {
      logic(ctx, 'creatingDefaultSyncState', {});
      // During initial development we're using a week as the horizon, but once
      // this seems sufficiently stable, this should probably be at least a
      // month and probably actually much longer.
      const startSyncFrom_millis = makeDaysAgo(30);

      rawSyncState = {
        lastChangeDatestamp: startSyncFrom_millis,
        // The bugzilla search mechanism doesn't actually have a way of creating
        // this constraint on queries for the grow situation, but we can ignore
        // results with a last_changed_time that are newer than than this when
        // browing backwards.  (Noting that because it's not possible to
        // backdate bugzilla changes, we don't have to worry about timestamps
        // between the first and last because inductively we've already synced
        // those bugs and the only change that can happen is that they can be
        // "touched" and move to be more recent than the last change.)
        firstChangeDatestamp: startSyncFrom_millis,
      };
    }

    this._accountId = accountId;
    this.rawSyncState = rawSyncState;

    // A running list of tasks to spin-off
    this.tasksToSchedule = [];
  }

  _makeBugConvTask({ bugId, lastChangeDatestamp }) {
    let convId = this._accountId + '.' + bugId;
    let task = {
      type: 'sync_bug',
      accountId: this._accountId,
      convId,
      bugId,
      lastChangeDatestamp,
    };
    this.tasksToSchedule.push(task);
    return task;
  }

  /**
   * Mark a DREV for further synchronization.  We don't care if we knew about
   * it before or not.
   */
  foundBug(drevInfo) {
    this._makeBugConvTask(drevInfo);
  }
}
