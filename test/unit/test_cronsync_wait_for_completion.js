/**
 * Make sure cronsync waits for the *entire* sync to complete, including the
 * rather important database save.
 *
 * There are two ways cronsync ends (if we assume there is nothing in the
 * outbox):
 * - With messages!  This implies snippet fetches.
 * - No messages!  This also implies no snippet fetches.  This is important
 *   because it means job-ops don't enter the picture and so if cronsync uses
 *   the wrong logic to decide when things are over, we can screw up.
 *
 * We primarily just care about the DB save here, so the key thing we do is
 * to withhold the db commit success notification to make sure that cronsync
 * doesn't go off declaring victory early.  We then release the notification to
 * move on.
 *
 * Permutations:
 * - Number of accounts with cronsync enabled: [0, 1, 2].  (Note: we have two
 *   accounts defined throughout the test, we just enable/disable them.  Arguably
 *   we also want the number of accounts that exist in the matrix, but I'm giving
 *   us the benefit of the doubt competence-wise, if only because otherwise it
 *   gets to be a hassle.
 * - Messages in the outbox? [0, 1, 2]
 * - Are there new messages?  [0, 1, 2, 5, 6].  5 and 6 are because of
 *   MAX_MESSAGES_TO_REPORT_PER_ACCOUNT which is 5 right now.
 **/

define(['rdcommon/testcontext', './resources/th_main',
        './resources/messageGenerator', 'exports'],
       function($tc, $th_main, $msggen, exports) {

/**
 * Given a dictionary whose keys are property names and values are lists of
 * values the property should take on, call the `invokeWhat` function with
 * every possible permutation of all of that stuff.  Specifically, `invokeWhat`
 * will be invoked with a dictionary with the same keys as `factorDict` but with
 * only one of the the values from the list at each time.
 *
 * It's better to call this funciton a few times with different permutations
 * where only one property at a time has a big list of possibilities because
 * math.
 */
function permuteUsingDict(factorDict, invokeWhat) {
  // - flatten the dict to a list of tuples while warming up the type/shape
  var factorList = [];
  // we mutate this in-place for simplicity but we'll snapshot with a JSON
  // roundtrip because our loggers don't snapshot right now.
  var curPermutation = {};
  for (var key in factorDict) {
    var values = factorDict[key];
    factorList.push([key, values]);
    // who cares (it's premature), but let's get the type/shape stable already.
    curPermutation[key] = values[0];
  }

  function iterationIsForSuckers(factorIndex) {
    var tupe = factorList[factorIndex];
    var key = tupe[0];
    var values = tupe[1];
    var recurseNotCall = factorIndex < factorList.length - 1;
    for (var i = 0; i < values.length; i++) {
      curPermutation[key] = values[i];
      if (recurseNotCall) {
        iterationIsForSuckers(factorIndex + 1);
      }
      else {
        // snapshot so what we tell them is immutable
        invokeWhat(JSON.parse(JSON.stringify(curPermutation)));
      }
    }
  }

  iterationIsForSuckers(0);
}


var TD = exports.TD = $tc.defineTestsFor(
  { id: 'test_cronsync_wait_for_completion' }, null,
  [$th_main.TESTHELPER], ['app']);

TD.commonCase('cronsync waits for completion', function(T, RT) {
  var TEST_PARAMS = RT.envOptions;

  T.group('setup');
  var testUniverse = T.actor('testUniverse', 'U'),
      testAccountA = T.actor(
        'testAccount', 'A',
        {
          universe: testUniverse,
          displayName: 'A Xample',
          emailAddress: 'a@' + TEST_PARAMS.emailDomain
        }),
      testAccountB = T.actor('testAccount', 'B',
        {
          universe: testUniverse,
          displayName: 'B Xample',
          emailAddress: 'b@' + TEST_PARAMS.emailDomain
        }),
      eSync = T.lazyLogger('sync');

  // --- Do the initial inbox sync.
  // We're mainly doing this because for IMAP we currently pre-populate the
  // folder with 1 message so our probing can guess the timezone correctly.
  var initialMsgs = (TEST_PARAMS.type === 'imap' ? 1 : 0);
  var inboxA = testAccountA.do_useExistingFolderWithType('inbox', '');
  testAccountA.do_viewFolder(
    'sync', inboxA,
    { count: initialMsgs, full: initialMsgs, flags: 0, deleted: 0 },
    { top: true, bottom: true, grow: false, newCount: null },
    { syncedToDawnOfTime: true });
  var inboxB = testAccountB.do_useExistingFolderWithType('inbox', '');
  testAccountB.do_viewFolder(
    'sync', inboxB,
    { count: initialMsgs, full: initialMsgs, flags: 0, deleted: 0 },
    { top: true, bottom: true, grow: false, newCount: null },
    { syncedToDawnOfTime: true });

  // We are actually running with the real, actual mozAlarms API powering us.
  // So what we want is a value that is sufficiently far in the future that it
  // won't fire during the test but it's also not ridiculous.  We pick an hour.
  var SYNC_INTERVAL = 60 * 60 * 1000;

  /** Enable/disable sync on accounts as appropriate. */
  function enableAccounts(numToEnable) {
    var enabledAccounts = [];
    testUniverse.__testAccounts.forEach(function(testAccount, iAccount) {
      if (iAccount < numToEnable) {
        enabledAccounts.push(testAccount);
        testAccount.do_modifyAccount({ syncInterval: SYNC_INTERVAL });
      } else {
        testAccount.do_modifyAccount({ syncInterval: 0 });
      }
      // create and cache the inboxFolder if not already cached by a prior
      // permutation.
      if (!testAccount.inboxFolder) {
        testAccount.inboxFolder =
          testAccount.do_useExistingFolderWithType('inbox', '');
      }
    });
    return enabledAccounts;
  }

  /** Realistically cram messages into the outbox on the given accounts */
  function queueStuckOutboxMessages(accounts, count) {
    accounts.forEach(function(testAccount, iAccount) {
      T.action('force send failures for', testAccount, function() {
        testAccount.testServer.toggleSendFailure(true);
      });
      for (var iMsg = 0; iMsg < count; iMsg++) {
        testAccount.do_composeAndSendMessage(
          'Account ' + iAccount + ' Message ' + iMsg,
          { success: false });
      }
    });
  }

  /**
   * Cram messages into the account's Inbox on the server.  (The inbox is the
   * only folder cronsync cares about right now.)
   */
  function addNewMessagesToInbox(accounts, count) {
    accounts.forEach(function(testAccount) {
      testAccount.do_addMessagesToFolder(
        testAccount.inboxFolder, { count: count });
    });
  }

  /**
   * Kick-off cron-sync but cause all outbox and sync operations to stall,
   * requiring calls to releaseOutbox(acctNum) and releaseSync(acctNum) to
   * let those continue.
   */
  function triggerCronSync(accounts, params) {
    testUniverse.do_cronsync_trigger({
      accounts: accounts,
      inboxHasNewMessages: params.newMessageCount,
      outboxHasMessages: params.outboxMessageCount
    });
  }

  function releaseOutbox(accounts, numMessages, expectFuncForLast) {
    accounts.forEach(function(testAccount, iAccount) {
      testUniverse.do_cronsync_releaseOutbox(
        testAccount,
        (iAccount === accounts.length - 1) ? expectFuncForLast : null);
    });
  }

  function releaseSync(accounts, numMessages, expectFuncForLast) {
    accounts.forEach(function(testAccount, iAccount) {
      testUniverse.do_cronsync_releaseAccountSyncButStallSave(testAccount);
      testUniverse.do_cronsync_releaseSyncDatabaseSave(
        testAccount,
        (iAccount === accounts.length - 1) ? expectFuncForLast : null);
    });
  }

  function expectCronsyncAllDone() {
    testUniverse.expect_cronsync_completed();
  }

  function testCronSyncYo(params) {
    var groupTitle =
      params.enabledCount + ' syncing ' +
      params.newMessageCount + ' new messages, ' +
      params.outboxMessageCount + ' in outbox';

    T.group(groupTitle);
    // do our setup stuff
    var accounts = enableAccounts(params.enabledCount);
    queueStuckOutboxMessages(accounts, params.outboxMessageCount);
    addNewMessagesToInbox(accounts, params.newMessageCount);

    T.group('(sync)');
    triggerCronSync(accounts, params);
    if (params.outboxFinishesFirst) {
      releaseOutbox(accounts, params.outboxMessageCount);
      releaseSync(accounts, params.newMessageCount, expectCronsyncAllDone);
    }
    else {
      releaseSync(accounts, params.newMessageCount);
      releaseOutbox(accounts, params.outboxMessageCount, expectCronsyncAllDone);
    }
  };

  T.group('=== vary number of accounts, outbox involvement ===');
  permuteUsingDict(
    {
      enabledCount: [1, 2],
      outboxMessageCount: [0, 1],
      newMessageCount: [/*0,*/ 1],
      outboxFinishesFirst: [false, true],
    }, // 16 permutations! ah! ah! ah!
    testCronSyncYo);

  T.group('=== vary new message count for edge cases ===');
  permuteUsingDict(
    {
      enabledCount: [1],
      outboxMessageCount: [0],
      newMessageCount: [2, 5, 6], // [0, 1] already covered
      outboxFinishesFirst: [false],
    }, // 3 permutations! ah! ah! meh.
    testCronSyncYo);

  T.group('=== vary outbox count for edge cases ===');
  permuteUsingDict(
    {
      enabledCount: [1],
      outboxMessageCount: [2], // [0, 1] already covered
      newMessageCount: [0],
      outboxFinishesFirst: [true],
    }, // 1 permutation?  Is that even a permutation?
    testCronSyncYo);
});

}); // end define
