import logic from 'logic';
import { encodeInt } from 'shared/a64';

import { makeDaysAgo, makeDaysBefore } from 'shared/date';

/**
 * See `README.md`.
 */
export default class ICalSyncStateHelper {
  constructor(ctx, rawSyncState, accountId, why) {
    logic.defineScope(this, 'ICalSyncState', { ctxId: ctx.id, why });

    if (!rawSyncState) {
      logic(ctx, 'creatingDefaultSyncState', {});
      rawSyncState = {
        nextConvId: 1,
        rangeOldestTS: makeDaysAgo(30),
        rangeNewestTS: makeDaysAgo(-30),
        uidToConvIdAndLastModified: new Map(),
      };
    }

    this._accountId = accountId;
    this.rawSyncState = rawSyncState;

    this.uidToConvIdAndLastModified = rawSyncState.uidToConvIdAndLastModified;
    // We clear UIDs as we see them; anything left at the end should be deleted.
    this.unseenUids = new Set(rawSyncState.uidToConvIdAndLastModified.keys());

    this.eventsByUid = new Map();

    // A running list of tasks to spin-off
    this.tasksToSchedule = [];
    // A running list of conversations to delete
    this.convMutations = null;
  }

  _makeUidConvTask({ convId, uid, lastModifiedTS, jcalEvents, rangeOldestTS, rangeNewestTS }) {
    let task = {
      type: 'sync_uid',
      accountId: this._accountId,
      convId,
      uid,
      lastModifiedTS,
      rangeOldestTS,
      rangeNewestTS,
      jcalEvents,
    };
    this.tasksToSchedule.push(task);
    return task;
  }

  _issueUniqueConvId() {
    return (this._accountId + '.' +
            encodeInt(this.rawSyncState.nextConvId++));
  }

  /**
   * First phase of event processing where we aggregate all observed events by
   * their UID.  This is because we inherently expect to see multiple events for
   * a given UID that is/was associated with a recurrence and it's handy for the
   * next phase `processEvents` to already have the complete set together since
   * it eliminates an extra case to handle.
   */
  ingestEvent(event) {
    const uid = event.getFirstPropertyValue('uid');
    let eventArray = this.eventsByUid.get(uid);
    if (!eventArray) {
      eventArray = [];
      this.eventsByUid.set(uid, eventArray);
    }
    eventArray.push(event);
  }

  /**
   * Statefully process events, generating synchronization tasks as necessary as
   * a byproduct.
   */
  processEvents() {
    for (const [uid, eventArray] of this.eventsByUid.entries()) {
      // There must be a first event and it should share the same last-modified
      // as all the rest, which is all we care about.
      const event = eventArray[0];

      // This will be a VCardTime...
      const lastModifiedDateTime = event.getFirstPropertyValue('last-modified');
      // ...which we want as a normal JS Timestamp for comparison purposes.
      const lastModifiedTS = lastModifiedDateTime.toJSDate().valueOf();

      let existingSyncInfo = this.uidToConvIdAndLastModified.get(uid);
      let convId;
      let needsIndexing = false;
      if (!existingSyncInfo) {
        convId = this._issueUniqueConvId();
        this.uidToConvIdAndLastModified.set(uid, { convId, lastModifiedTS });
        needsIndexing = true;
      } else {
        this.unseenUids.delete(uid);

        convId = existingSyncInfo.convId;
        // If the time isn't the change,
        if (existingSyncInfo.lastModifiedTS !== lastModifiedTS) {
          needsIndexing = true;
          existingSyncInfo.lastModifiedTS = lastModifiedTS;
        }
      }

      if (needsIndexing) {
        // Sort the recurring event proper to be the first of the events.
        eventArray.sort((cA, cB) => {
          // 0 if no recurrence id, 1 if recurrence-id, then sort ascending.
          const aVal = cA.hasProperty('recurrence-id') ? 1 : 0;
          const bVal = cB.hasProperty('recurrence-id') ? 1 : 0;
          return bVal - aVal;
        });
        const jcalEvents = eventArray.map(cEvent => cEvent.toJSON());
        this._makeUidConvTask({
          convId,
          uid,
          lastModifiedTS,
          jcalEvents,
          rangeOldestTS: this.rawSyncState.rangeOldestTS,
          rangeNewestTS: this.rawSyncState.rangeNewestTS,
        });
      }
    }

    // If there are any UIDs that have disappeared, schedule `sync_uid` tasks
    // that will delete them.
    if (this.unseenUids.size) {
      this.convMutations = new Map();
      for (const uid of this.unseenUids) {
        const existingSyncInfo = this.uidToConvIdAndLastModified.get(uid);
        this.uidToConvIdAndLastModified.delete(uid);
        this._makeUidConvTask({
          convId: existingSyncInfo.convId,
          uid,
          lastModifiedTS: 0,
          jcalEvents: [],
          rangeOldestTS: this.rawSyncState.rangeOldestTS,
          rangeNewestTS: this.rawSyncState.rangeNewestTS,
        });
      }
    }
  }
}
