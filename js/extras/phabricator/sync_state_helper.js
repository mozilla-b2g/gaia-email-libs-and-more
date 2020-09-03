import logic from 'logic';

import { millisecsToSeconds, makeDaysAgo } from '../../date';

/**
 * See `sync.md`.
 */
export default class PhabricatorSyncStateHelper {
  constructor(ctx, rawSyncState, accountId, why) {
    logic.defineScope(this, 'PhabricatorSyncState', { ctxId: ctx.id, why });

    if (!rawSyncState) {
      logic(ctx, 'creatingDefaultSyncState', {});
      const startSyncFrom_millis = makeDaysAgo(7);
      const startSyncFrom_secs = millisecsToSeconds(startSyncFrom_millis);

      rawSyncState = {
        lastDateModifiedEpochSecs: startSyncFrom_secs,
        firstDateModifiedEpochSecs: startSyncFrom_secs,
      };
    }

    this._accountId = accountId;
    this.rawSyncState = rawSyncState;

    // A running list of tasks to spin-off
    this.tasksToSchedule = [];
  }

  _makeDrevConvTask(drevId, drevPhid, modifiedStamp) {
    let convId = this._accountId + '.' + drevId;
    let task = {
      type: 'sync_drev',
      accountId: this._accountId,
      convId,
      drevPhid,
      modifiedStamp,
    };
    this.tasksToSchedule.push(task);
    return task;
  }
}