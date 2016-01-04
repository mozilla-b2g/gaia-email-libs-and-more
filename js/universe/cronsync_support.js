define(function(require) {
'use strict';

const logic = require('logic');
const router = require('../worker-router');
const syncbase = require('../syncbase');


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
 *   translate that into calls on
 *
 */
function CronSyncSupport(universe) {
  this._universe = universe;

  logic.defineScope(this, 'CronSync');

  this._ensureSyncResolve = null;

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
  this.sendCronSync('hello');

  this.ensureSync();
}
CronSyncSupport.prototype = {
  /**
   * Makes sure there is a sync timer set up for all accounts.
   */
  ensureSync: function() {
    // Only execute ensureSync if it is not already in progress. Otherwise, due
    // to async timing of mozAlarm setting, could end up with two sync tasks for
    // the same ID.
    if (this._ensureSyncResolve) {
      return;
    }

    logic(this, 'ensureSync_begin');

    this._ensureSyncPromise = new Promise((resolve) => {
      // No error pathway for the bridge hop, so just tracking resolve.
      this._ensureSyncResolve = resolve;
    });

    logic(this, 'ensureSync called');

    var accounts = this._universe.accounts,
        syncData = {};

    accounts.forEach(function(account) {
      // Store data by interval, use a more obvious string key instead of just
      // stringifying a number, which could be confused with an array construct.
      var interval = account.accountDef.syncInterval,
          intervalKey = 'interval' + interval;

      if (!syncData.hasOwnProperty(intervalKey)) {
        syncData[intervalKey] = [];
      }
      syncData[intervalKey].push(account.id);
    });

    this.sendCronSync('ensureSync', [syncData]);
  },

  /**
   * Called from cronsync-main once ensureSync as set any alarms needed. Need to
   * wait for it before signaling sync is done because otherwise the app could
   * get closed down before the alarm additions succeed.
   */
  onSyncEnsured: function() {
    this._ensureSyncResolve();
    this._ensureSyncResolve = null;
    logic(this, 'ensureSync_end');
  },

  /**
   * Synchronize the given account. This fetches new messages for the inbox, and
   * attempts to send pending outbox messages (if applicable). The callback
   * occurs after both of those operations have completed.
   */
  syncAccount: function(account) {
    return new Promise((resolve) => {
      var scope = logic.subscope(this, { accountId: account.id });

      // - Skip syncing if we are offline or the account is disabled
      if (!this._universe.online || !account.enabled) {
        debug('syncAccount early exit: online: ' +
              this._universe.online + ', enabled: ' + account.enabled);
        logic(scope, 'syncSkipped');
        resolve();
        return;
      }

      var latch = allback.latch();
      var inboxDone = latch.defer('inbox');

      var inboxFolder = account.getFirstFolderWithType('inbox');
      var storage = account.getFolderStorageForFolderId(inboxFolder.id);

      // XXX check when the folder was most recently synchronized and skip this
      // sync if it is sufficiently recent.

      // - Initiate a sync of the folder covering the desired time range.
      logic(scope, 'syncAccount_begin');
      logic(scope, 'syncAccountHeaders_begin');

      var slice = makeHackedUpSlice(storage, (newHeaders) => {
        logic(scope, 'syncAccountHeaders_end', { headers: newHeaders });

        // Reduce headers to the minimum number and data set needed for
        // notifications.
        var notifyHeaders = [];
        newHeaders.some(function(header, i) {
          notifyHeaders.push({
            date: header.date,
            from: header.author.name || header.author.address,
            subject: header.subject,
            accountId: account.id,
            messageSuid: header.suid
          });

          if (i === syncbase.CRONSYNC_MAX_MESSAGES_TO_REPORT_PER_ACCOUNT - 1) {
            return true;
          }
        });

        if (newHeaders.length) {
          debug('Asking for snippets for ' + notifyHeaders.length + ' headers');
          // POP3 downloads snippets as part of the sync process, there is no
          // need to call downloadBodies.
          if (account.accountDef.type === 'pop3+smtp') {
            logic(scope, 'syncAccount_end');
            inboxDone([newHeaders.length, notifyHeaders]);
          } else if (this._universe.online) {
            logic(scope, 'syncAccountSnippets_begin');
            this._universe.downloadBodies(
              newHeaders.slice(
                0, syncbase.CRONSYNC_MAX_SNIPPETS_TO_FETCH_PER_ACCOUNT),
              {
                maximumBytesToFetch: syncbase.MAX_SNIPPET_BYTES
              },
              () => {
                debug('Notifying for ' + newHeaders.length + ' headers');
                logic(scope, 'syncAccountSnippets_end');
                logic(scope, 'syncAccount_end');
                inboxDone([newHeaders.length, notifyHeaders]);
              });
          } else {
            logic(scope, 'syncAccount_end');
            debug('UNIVERSE OFFLINE. Notifying for ' + newHeaders.length +
                  ' headers');
            inboxDone([newHeaders.length, notifyHeaders]);
          }
        } else {
          logic(scope, 'syncAccount_end');
          inboxDone();
        }

        // Kill the slice.  This will release the connection and result in its
        // death if we didn't schedule snippet downloads above.
        slice.die();
      });

      // Pass true to force contacting the server.
      storage.sliceOpenMostRecent(slice, true);

      // Check the outbox; if it has pending messages, attempt to send them.
      var outboxFolder = account.getFirstFolderWithType('outbox');
      if (outboxFolder) {
        var outboxStorage = account
                                  .getFolderStorageForFolderId(outboxFolder.id);
        if (outboxStorage.getKnownMessageCount() > 0) {
          var outboxDone = latch.defer('outbox');
          logic(scope, 'sendOutbox_begin');
          this._universe.sendOutboxMessages(
            account,
            {
              reason: 'syncAccount'
            },
            () => {
              logic(scope, 'sendOutbox_end');
              outboxDone();
            });
        }
      }

      // After both inbox and outbox syncing are algorithmically done, wait for
      // any ongoing job operations to complete so that the app is not killed in
      // the middle of a sync.
      latch.then((latchResults) => {
        // Right now, we ignore the outbox sync's results; we only care about
        // the inbox.
        var inboxResult = latchResults.inbox[0];
        this._universe.waitForAccountOps(account, function() {
          // Also wait for any account save to finish. Most likely failure will
          // be new message headers not getting saved if the callback is not
          // fired until after account saves.
          account.runAfterSaves(function() {
            resolve(inboxResult);
          });
        });
      });
    });
  },

  /**
   * Triggered by an 'alarm' system message firing in the document context and
   * remoted to us.
   */
  onAlarm: function(accountIds, interval, wakelockId) {
    logic(this, 'alarmFired', { accountIds, interval, wakelockId });

    if (!accountIds) {
      return;
    }

    var accounts = this._universe.accounts,
        targetAccounts = [],
        ids = [];

    logic(this, 'cronSync:begin');
    // - Issue a log write to the 
    this._universe.cronsyncAccounts({
      accountIds
    });
    this._universe.__notifyStartedCronSync(accountIds);

    // Make sure the acount IDs are still valid. This is to protect against an
    // account deletion that did not clean up any alarms correctly.
    accountIds.forEach(function(id) {
      accounts.some(function(account) {
        if (account.id === id) {
          targetAccounts.push(account);
          ids.push(id);
          return true;
        }
      });
    });

    // Make sure next alarm is set up. In the case of a cold start background
    // sync, this is a bit redundant in that the startup of the mailuniverse
    // would trigger this work. However, if the app is already running, need to
    // be sure next alarm is set up, so ensure the next sync is set up here. Do
    // it here instead of after a sync in case an error in sync would prevent
    // the next sync from getting scheduled.
    this.ensureSync();

    var syncResults = [];
    var accountsResults = {
      accountIds: accountIds
    };

    var done = () => {
      // Make sure the ensure work is done before wrapping up.
      this._ensureSyncPromise.then(() => {
        if (syncResults.length) {
          accountsResults.updates = syncResults;
        }

        this._universe.__notifyStoppedCronSync(accountsResults);
        logic(this, 'syncAccounts_end', { accountsResults: accountsResults });
        logic(this, 'cronSync_end');
      });
    };

    // Nothing new to sync, probably old accounts. Just return and indicate that
    // syncing is done.
    if (!ids.length) {
      done();
      return;
    }

    logic(this, 'syncAccounts_begin');
    Promise.all(targetAccounts.map((account) => {
      return this.syncAccount(account).then((result) => {
        if (result) {
          syncResults.push({
            id: account.id,
            address: account.identities[0].address,
            count: result[0],
            latestMessageInfos: result[1]
          });
        }
      });
    }))
    .then(done);
  },

  shutdown: function() {
    router.unregister('cronsync');
  }
};

return CronSyncSupport;
}); // end define
