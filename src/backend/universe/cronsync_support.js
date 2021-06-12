/* eslint-disable no-prototype-builtins */
import logic from 'logic';
import * as router from '../worker-router';
import { CRONSYNC_MAX_DURATION_MS } from '../syncbase';

import { wrapMainThreadAcquiredWakelock } from '../wakelocks';
import { NOW } from 'shared/date';

/**
 * Support logic for cronsync/periodic sync to deal with the fact that the
 * mozAlarms control API and the notifications it generates can only occur in a
 * document context and not here on the worker.  Our counterpart in the document
 * context is cronsync-main.js.
 *
 * We:
 * - expose ensureSync that verifies that sync intervals are appropriately set
 *   for the given account id's.  The acutal logic happens in the document
 *   context, we're just RPC ships.
 * - handle messages from the document context that mozAlarms fired and we
 *   arrange the whole task pipeline as well as all the failsafes.  (Because the
 *   task mechanism and error recovery mechanisms are not yet foolproof, we
 *   do more here than we ideally would.)
 *
 * Startup-wise, our contract with MailUniverse is this:
 * - It instantiates us in its constructor.  We do not ensureSync() or say hello
 *   yet.
 * - It calls ensureSync on us once the AccountManager has been provided with
 *   the current set of account definitions so that we know the relevant sync
 *   intervals.  Note that we use the AccountManager's synchronous API to get
 *   access to the accounts.
 * - It calls systemReady on us when the AccountManager has fully initialized,
 *   meaning that we can safely schedule tasks.  At this point we send the
 *   'hello' message to cronsync-main which will let it release its
 *   'syncEnsured' and any 'alarm' message.  The rationale for this is that
 *   our onAlarm handler can't do anything useful until it can schedules tasks
 *   and it would be silly to introduce an additional layer of delayed
 *   processing here when cronsync-main already has one.
 */
export default function CronSyncSupport({ universe, db, accountManager }) {
  // Needed so we can schedule tasks.
  this._universe = universe;
  // Needed so we can directly write to the bounded log.
  this._db = db;
  // Needed so we can get at the current accountDefs
  this._accountManager = accountManager;

  logic.defineScope(this, 'CronSync');

  // Slots used by ensureSync to ensure there is only one outstanding ensureSync
  // request at a time.  See its docs for more details.
  this._ensureSyncPromise = null;
  this._ensureSyncResolve = null;

  // In the event that multiple cronsync alarms fire, we only keep around one
  // wakelock.  This is that one, lucky wakelock.
  this._activeWakeLock = null;
  this._activeCronSyncLogConclusion = null;
  /**
   * Account ids for which we have an outstanding cronsync request.
   */
  this._activelyCronSyncingAccounts = new Set();

  this.sendCronSync = router.registerSimple('cronsync', (data) => {
    var args = data.args;
    logic(this, 'message', { cmd: data.cmd });
    switch (data.cmd) {
      case 'alarm':
        this.onAlarm.apply(this, args);
        break;
      case 'syncEnsured':
        this.onSyncEnsured.apply(this, args);
        break;
      default:
        break;
    }
  });

  this._bound_cronsyncSuccess = this._cronsyncVictoriousCompletion.bind(this);
  this._bound_cronsyncImminentDoom = this._cronsyncImminentDoom.bind(this);
}
CronSyncSupport.prototype = {
  /**
   * Called by MailUniverse when the account manager has completed
   * initialization so cronsync-main can release its held messages to us and we
   * can get this party started[1].  See our class doc-block for more info.
   *
   * 1: This was not a modern reference when this code was written[2].
   * 2: Nor was it a modern reference when I first learned about it.
   */
  systemReady: function() {
    this.sendCronSync('hello');
  },

  /**
   * Makes sure there is a sync timer set up for all accounts as they are
   * configured at this instant.
   *
   * Most of this happens on the main thread.  What happens on the main thread
   * is itself asynchronous, so we ensure that we only have one outstanding
   * request issued to the front-end at a time by using the presence of
   * the _ensureSyncPromise as an indicator.  If this happens, we will simply
   * have the second request use the same promise as the outstanding request.
   *
   * We do this because the following can and does happen:
   * - The mail app is started because of a mozAlarm
   * - MailUniverse calls ensureSync() at startup as it always does.
   * - The mozAlarm that woke us up triggers a cronsync, and part of what we do
   *   in cronsync is call ensureSync.
   * In this case, we really only need to be invoking ensureSync once, hence
   * the consolidation.  This is safe in this specific case because the fired
   * alarm (by invariant!) will not be reported to mozAlarms.getAll() because it
   * is removed as part of the firing process.  Hence any call to ensureSync
   * regardless of the timing relative to our message handler being registered
   * will schedule the alarm.
   *
   * It's also worth noting that we are assuming that the latency of our
   * ensureSync request cycle is significantly less than the sync interval we
   * schedule.  Phrased otherwise, we will break if we schedule the mozAlarm and
   * it fires before our ensureSync completion notification comes back.  Based
   * on the implementation of mozAlarms and our control flow, I think we are
   * guaranteed safe even with a zero timeout, but it's still worth calling out.
   * (And our testing should key off our log indicating we've completed before
   * compelling the real or fake alarm to fire.)
   *
   * @return {Promise}
   *   A promise that will be resolved when the ensureSync request has
   *   completed.
   */
  ensureSync(why) {
    // Only execute ensureSync if it is not already in progress. Otherwise, due
    // to async timing of mozAlarm setting, could end up with two sync tasks for
    // the same ID.
    if (this._ensureSyncPromise) {
      logic(this, 'ensureSyncConsolidated', { why });
      return this._ensureSyncPromise;
    }

    logic(this, 'ensureSync:begin', { why });

    this._ensureSyncPromise = new Promise((resolve) => {
      // No error pathway for the bridge hop, so just tracking resolve.
      this._ensureSyncResolve = resolve;
    });

    let syncData = {};

    for (let accountDef of this._accountManager.getAllAccountDefs()) {
      // Store data by interval, use a more obvious string key instead of just
      // stringifying a number, which could be confused with an array construct.
      let interval = accountDef.syncInterval,
      intervalKey = 'interval' + interval;

      if (!syncData.hasOwnProperty(intervalKey)) {
        syncData[intervalKey] = [];
      }
      syncData[intervalKey].push(accountDef.id);
    }

    this.sendCronSync('ensureSync', [syncData]);
    return null;
  },

  /**
   * Called from cronsync-main once ensureSync as set any alarms needed. Need to
   * wait for it before signaling sync is done because otherwise the app could
   * get closed down before the alarm additions succeed.
   */
  onSyncEnsured: function() {
    logic(this, 'ensureSync:end');
    this._ensureSyncResolve();
    this._ensureSyncPromise = null;
    this._ensureSyncResolve = null;
  },

  /**
   * A fancy wrapper around scheduling a sync_refresh for an account. Our
   * value-adds:
   * - We add a specific bounded-log entry for this account sync.
   * - We know when the account still has an outstanding sync and avoid
   *   scheduling a new one and explicitly log that we skipped the sync for
   *   this account.  This is mainly for dealing with the dev scenario where we
   *   crank the sync interval down so low that account syncs may legitimately
   *   stack up.
   * - We return true if we ended up scheduling a cronsync, false if we did not.
   *   This is part of the prior bullet point, but the net result is that our
   *   caller knows not to keep extending timeouts if we're not actually
   *   scheduling anything new.
   *
   * We otherwise do not give any feedback to the core cronsync driver logic.
   * It knows a cronsync has completed when the task
   */
  cronsyncAccount: function({ accountId, logTimestamp }) {
    let cronsyncLogEntry = {
      accountId,
      startTS: null,
      endTS: null,
      status: null
    };
    let cronsyncLogWrapped = {
      type: 'cronsync', timestamp: logTimestamp, id: accountId,
      entry: cronsyncLogEntry
    };

    if (this._activelyCronSyncingAccounts.has(accountId)) {
      cronsyncLogEntry.status = 'already-active';
      this._db.addBoundedLogs([cronsyncLogWrapped]);
      return false;
    }

    let foldersTOC = this._accountManager.accountFoldersTOCs.get(accountId);
    if (!foldersTOC) {
      // The only way this happens if we're racing account removal.  But if
      // that happens, it is indeed best for us to skip over the account at
      // this point.  Our state will quickly converge.
      cronsyncLogEntry.status = 'account-dead';
      this._db.addBoundedLogs([cronsyncLogWrapped]);
      return false;
    }
    let inboxFolderId = foldersTOC.getCanonicalFolderByType('inbox').id;
    this._universe.syncRefreshFolder(inboxFolderId, 'cronsync').then(() => {
      this._activelyCronSyncingAccounts.delete(accountId);
      cronsyncLogEntry.endTS = NOW();
      // XXX this needs to use some combination of syncBlocked and the
      // success and failure timestamps branded onto the account and/or folders
      // in order to figure out whether we actually did the sync or not.  For
      // now we'll just be inferring from the online status of the containing
      // cronsync log.
      cronsyncLogEntry.status = 'completed...somehow';
      this._db.updateBoundedLogs([cronsyncLogWrapped]);
    });

    this._activelyCronSyncingAccounts.add(accountId);

    cronsyncLogEntry.startTS = logTimestamp;
    cronsyncLogEntry.status = 'issued';
    this._db.addBoundedLogs([cronsyncLogWrapped]);

    return true;
  },

  /**
   * Initiate a cronsync for the given accounts.  Triggered by an 'alarm' system
   * message firing in the document context and remoted to us.
   *
   * It is possible and even expected that multiple calls to onAlarm can happen
   * within a short period of time due to accounts with different intervals
   * clustering around the same time.  (Ex: 5 minute sync, 10 minute sync, 15
   * minute sync can end up happening as 3 calls all clustered together every
   * 15 minutes.)
   *
   * We normalize this so that we really only ever have one conceptually active
   * cronsync at a time; if more alarms fire, then we end up just adding the new
   *
   *
   * Our contract with the front-end is that we will tell it when all
   * outstanding cronsyncs have completed.
   */
  onAlarm: function(syncAccountIds, interval, wakelockId,
                    accountIdsWithNotifications) {
    logic(this, 'alarmFired', { syncAccountIds, interval, wakelockId });

    // This is the timestamp we'll use with our log entry.
    let logTimestamp = NOW();

    let wakelock = wrapMainThreadAcquiredWakelock({
      wakelockId,
      timeout: CRONSYNC_MAX_DURATION_MS
    });

    // - Build and log the initial bounded log entry (before doing anything)
    let cronsyncLogEntry = {
      startTS: logTimestamp,
      startOnline: this._universe.online,
      accountIds: syncAccountIds,
      endTS: null,
      endOnline: null,
      result: null
    };
    let cronsyncLogWrapped = {
      type: 'cronsync', timestamp: logTimestamp, id: 'cronsync',
      entry: cronsyncLogEntry
    };
    this._db.addBoundedLogs([cronsyncLogWrapped]);

    // - Ensure alarm timers.
    // Make sure next alarm is set up. In the case of a cold start background
    // sync, this is a bit redundant in that the startup of the mailuniverse
    // would trigger this work. However, if the app is already running, need to
    // be sure next alarm is set up, so ensure the next sync is set up here. Do
    // it here instead of after a sync in case an error in sync would prevent
    // the next sync from getting scheduled.
    //
    // NB: We don't care about the returned promise here because our 'victory'
    // method will ensure that it waits for the outstanding ensureSync at that
    // time to complete.  We do that there rather than doing Promise.all() on
    // this one because of our consolidation of multiple alarm requests.  We'd
    // end up generating a whole bunch of complicated promise chains and guards
    // when that is not our goal.
    this.ensureSync('alarm');

    // -- Infer new_tracking to be cleared based on no outstanding notifications
    //
    // cronsync-main.js looked for all accounts with outstanding notifications
    // and sent them to us as part of accountIdsWithNotifications.  If we have
    // an account and it has no notification, then we can surmise one of 2
    // things is true:
    // 1. There was a notification and the user closed it, implying that they
    //    want us to clear the new state for the given account.
    // 2. There was no notification.
    // Happily, even if the 2nd is true, clearing empty state is harmless
    // (and idempotent).  So we just do this.
    //
    // Note that we do this for *all* accounts, not just the ones told to us in
    // syncAccountIds because when new_flush is run, it considers the newness
    // state across *all* accounts, not just the modified ones.  So if we didn't
    // do this, notifications for accounts not currently being synced could come
    // back to life.  (NB: new_flush operates across all accounts rather than
    // just per-account because under a richer notification API than we
    // currently support we might generate a single super-notification, and in
    // that case it would suck to have )
    for (let accountDef of this._accountManager.getAllAccountDefs()) {
      if (accountIdsWithNotifications.indexOf(accountDef.id) === -1) {
        this._universe.clearNewTrackingForAccount({
          accountId: accountDef.id,
          // We're making the new_tracking reflect the actual (and desired) UI
          // reality, so this need not generate an update.  (And race-wise,
          // not generating an update is preferable since it means that if a new
          // message arrived and was reported by us after the clear was issued,
          // this way the user will still see that notification until they clear
          // it too or some other change causes us to do a new_flush.
          silent: true
        });
      }
    }

    // -- Trigger sync_refresh tasks for each account we're syncing.
    //
    // Note that we're not explicitly going to wait around on the sync groups,
    // which is why we don't care about the return value of syncRefreshFolder.
    // See below for more details.
    let cronsyncsIssued = 0;
    for (let accountId of syncAccountIds) {
      if (this.cronsyncAccount({ accountId, logTimestamp })) {
        cronsyncsIssued++;
      }
    }

    let logConclusion = (result) => {
      cronsyncLogEntry.endTS = NOW();
      cronsyncLogEntry.endOnline = this._universe.online;
      cronsyncLogEntry.result = result;
      this._db.updateBoundedLogs([cronsyncLogWrapped]);
    };

    // -- Deal with overlapping alarms
    if (this._activeWakeLock) {
      // - Already an active cronsync
      // (yes, one of us is still active)
      if (cronsyncsIssued) {
        logic(this, 'cronSync:handoff');
        // We actually did something, so rollover to the new wakelock.
        this._activeWakeLock.unlock();
        this._activeWakeLock = wakelock;
        this._activeWakeLock.imminentDoomHandler =
          this._bound_cronsyncImminentDoom;
        // likewise, have the old log closed out in the favor of this new one.
        this._activeCronSyncLogConclusion('superseded');
        this._activeCronSyncLogConclusion = logConclusion;
      } else {
        logic(this, 'cronSync:no-sync-no-handoff');
        // We did not schedule anything new, leave the current wakelock active
        // with its existing timeout.
        wakelock.unlock();
        // likewise indicate for our new/current log entry that we ended up
        // not going with this one.
        logConclusion('ignored-ineffective');
      }
    } else {
      logic(this, 'cronSync:begin');
      // - No pre-existing cronsync
      this._activeWakeLock = wakelock;
      this._activeWakeLock.imminentDoomHandler =
        this._bound_cronsyncImminentDoom;
      this._activeCronSyncLogConclusion = logConclusion;

      // We can declare victory when the ensure sync has completed and the task
      // queue is empty.  This covers syncs, the new_tracking flush and others.
      this._universe.taskManager.once(
        'taskQueueEmpty', this._bound_cronsyncSuccess);
    }
    // at this point the following things are true, inductively:
    // * we have a this._activeWakeLock and it's counting down. tick tock!
    // * we have a this._activeCronSyncLogConclusion
    // * we have once'd the task queue being empty, and it will trigger after
    //   the sync_refresh tasks and their spinoff new_tracking tasks have
    //   completed.  If there were outbox tasks in there too, they will also get
    //   their chance to happen.  Overdue flag changes to apply to the server?
    //   They also get a chance to shine!  Hooray hooray!
  },

  /**
   * This cronsync has completed successfully and all is right in the world.
   * Notify the front-end that the cronsync completed and they can maybe shut
   * the process down.
   */
  _cronsyncVictoriousCompletion: function() {
    // (see inside realCompletion for rationale on these)
    let wakelockOnEntry = this._activeWakeLock;
    let logConclusionOnEntry = this._activeCronSyncLogConclusion;
    this._activeWakeLock = null;
    this._activeCronSyncLogConclusion = null;

    // It's possible for us to end up needing to wait for ensureSync to
    // complete.  Since we don't schedule additional paranoid alarms, that's
    // the one thing we absolutely must not screw up.  So we put our logic in
    // here and have it wait for the promise if needed.
    let realCompletion = () => {
      // As is the exciting nature of async programming, it's possible that
      // a new, valid cronsync came in while we were waiting for the ensureSync.
      // Such a thing is, of course, nuts.  But it's safer for us to just handle
      // it...

      // So if there's an active wakelock again, it means that the "no
      // pre-existing" cronsync path was taken.  This also non-obviously implies
      // that (cronsyncsIssued > 0) was true and so something is actually going
      // to happen and the 'taskQueueEmpty' event will be emitted.  We know this
      // must be the case because the fact that it fired for us means that the
      // tasks must have completed ergo not broken and removed from the
      // _activelyCronSyncingAccounts suppression set.
      if (this._activeWakeLock) {
        logic(this, 'cronSync:last-minute-handoff');
        logConclusionOnEntry('success-left-open');
        wakelockOnEntry.unlock();
        return;
      }
      logic(this, 'cronSync:end');
      this._universe.broadcastOverBridges('cronSyncComplete', {});
      logConclusionOnEntry('success');
      wakelockOnEntry.unlock();
    };
    if (this._ensureSyncPromise) {
      this._ensureSyncPromise.then(realCompletion);
    } else {
      realCompletion();
    }
  },

  /**
   * Invoked by our wakelock immediately prior to it unlocking our wakelocks
   * because our failsafe wakelock timeout is firing.  Now is when we tell the
   * frontend that we've failed it and it should probably do a window.close().
   * We front-run the unlock, so as long as the front-end processes this
   * notification and invokes window.close() immediately, it will get the
   * benefit of the wakelock and can even re-acquire its wakelock.
   */
  _cronsyncImminentDoom: function() {
    logic(this, 'cronSyncEpicFail');
    this._universe.broadcastOverBridges(
      'cronSyncEpicFail',
      { epicnessLevel: 'so epic'});
  },

  shutdown: function() {
    router.unregister('cronsync');
  }
};
