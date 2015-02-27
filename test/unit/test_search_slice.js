/**
 * Search slice testing.  We have a separate unit test that covers the core
 * search / matching logic in-depth including boundary conditions.  We are
 * more about verifying that the search slice abstraction operates correctly as
 * well as sanity checking the higher level stuff does not break.
 *
 * The key bits we test are:
 * - Searching works on text bodies (that have been downloaded)
 * - Searching works on HTML bodies (that have been downloaded)
 * - Search slices properly update when messages are updated (flag change)
 * - Search slices properly update when messages are deleted
 * - Search slices report new matching additions in the existing bounding range
 *   but not new additions that fail to match.
 * - Search slices do not freak out if they hear about updates/deletions of
 *   messages that did not match.
 * - Search slices properly reports a new matching addition when we are dealing
 *   with the latch-to-now scenario per atTop/atBottom semantics.
 * - That the search stops when we tell it to stop and that it doesn't keep
 *   looking.  (We had a bug where we would only actually stop once we had
 *   found a match.  Or at least code-reading suggested it, so a test it gets.)
 *
 * We only run this test on IMAP because all of this logic is protocol agnostic.
 * And also because we don't have folders for POP3 and the plain/html variants
 * really want to be the only things in their folder.
 *
 * ## On Search Helpers ##
 *
 * This file just directly uses the search API without any complicated do_BLAH
 * wrappers and magic assertions under the hood about what the search returns.
 * This is partially because we have a test refactoring plan that will be more
 * of a headache if I do that, and partially because I don't think we need
 * comprehensive magic assertion checking on the search logic.  The filtering
 * mechanism is fairly straightforward and these tests are intended to provide
 * the comprehensive coverage relating to edge cases.  When we do refactor and
 * it helps the clarity of this test to migrate/clean-up the helpers, I look
 * forward to that.
 **/

define(function(require) {

var LegacyGelamTest = require('./resources/legacy_gelamtest');
var $msggen = require('./resources/messageGenerator');
var $searchfilter = require('searchfilter');

/*
 * Novelty matching/non-matching word prefixes that are also somewhat obvious
 * about whether we expect them to match or not.  We append an index number to
 * these for the message bodies.
 */
var MATCHING_WORD    = 'yeaaaaaah';
var NONMATCHING_WORD = 'noooooooo';

/**
 * Helper that keeps growing the slice until it claims it is atBottom.
 */
function waitForSearchToSearchEverything(slice, callback) {
  function completeHandler() {
    // all done at the bottom
    if (slice.atBottom) {
      callback();
    }
    else {
      slice.oncomplete = completeHandler;
      // request the default chunk size which is what front-ends should
      // theoretically be using unless they know better.
      slice.requestGrowth(1);
    }
  }
  slice.oncomplete = completeHandler;
}

var allTests = [];

function commonCase(name, fn) {
  allTests.push(new LegacyGelamTest(name, fn));
}

/**
 * Create a search-filter on the back-end side and kill it immediately before
 * any of its database calls can complete.  Verify that no comparisons are run.
 *
 * Also, make sure the slice gets added to/removed from _slices appropriately.
 */
commonCase('stop searching when killed', function(T, RT) {
  T.group('setup');
  var testUniverse = T.actor('TestUniverse', 'U'),
      testAccount = T.actor('TestAccount', 'A', { universe: testUniverse,
                                                  restored: false }),
      eLazy = T.lazyLogger('lazy');
  var testFolder = testAccount.do_createTestFolder(
    'search_abort',
    { count: 3, age: { days: 1 }, age_incr: {days: 1 } });
  // This will synchronize the folder and then evict all blocks when the sync
  // completes...
  testAccount.do_viewFolder(
    'sync', testFolder,
    { count: 3, full: 3, flags: 0, deleted: 0 },
    { top: true, bottom: true, grow: false },
    { syncedToDawnOfTime: true });

  T.group('aborted search');
  T.action('search and abort', eLazy, function() {
    // there should be one load trying to load the header block after we
    // initiate the search.
    eLazy.expect('pending loads',  1);
    eLazy.expect('slices.length pre-die',  1);
    eLazy.expect('slices.length post-die',  0);
    eLazy.expect('all blocks loaded');
    eLazy.expect('messages checked',  0);

    var dummyProxy = {
      sendStatus: function() {}
    };

    // This search will have to wait for the blocks to load because they got
    // evicted above, which means that our die() gets a chance to run before
    // any headers are reported.
    var backendSlice = testAccount.account.searchFolderMessages(
      testFolder.mailFolder.id, dummyProxy, 'foo', { subject: true });
    var folderStorage = backendSlice._storage;
    eLazy.log('pending loads', folderStorage._pendingLoads.length);
    eLazy.log('slices.length pre-die', folderStorage._slices.length);
    backendSlice.die();
    eLazy.log('slices.length post-die', folderStorage._slices.length);

    folderStorage._deferredCalls.push(function() {
      eLazy.log('all blocks loaded');
      eLazy.log('messages checked',
                       backendSlice.filterer.messagesChecked);
    });
  });
});

commonCase('empty search returns zero results', function(T, RT) {
  T.group('setup');
  var testUniverse = T.actor('TestUniverse', 'U'),
      testAccount = T.actor('TestAccount', 'A', { universe: testUniverse,
                                                  restored: true }),
      eBackendSearchSlice = T.actor('SearchSlice'),
      eBodies = T.lazyLogger('bodies'),
      eFolderSlice = T.lazyLogger('folderSlice'),
      eSearch = T.lazyLogger('searchy');

  var testFolder = testAccount.do_createTestFolder(
    'search_empty', { count: 3, age: { days: 1 }, age_incr: {days: 1 } });

  var fullView = testAccount.do_openFolderView(
    'full download view', testFolder,
    { count: 3, full: 3, flags: 0, deleted: 0 },
    { top: true, bottom: true, grow: false },
    { syncedToDawnOfTime: true });

  T.action('download all bodies', eBodies, function() {
    eBodies.expect('downloaded');
    fullView.slice.maybeRequestBodies(
      0, fullView.slice.items.length - 1,
      // none of these bodies will be more than a meg.
      { maximumBytesToFetch: 1024 * 1024 },
      function() {
        eBodies.log('downloaded');
      });
  });

  T.group('empty search');
  var searchSlice, initialMatchHeaders;
  T.action('initial', eSearch, eBackendSearchSlice, function() {
    eSearch.expect('initial search completed');
    eSearch.expect('slice item length zero',  0);

    searchSlice = testAccount.MailAPI.searchFolderMessages(
      testFolder.mailFolder, '', { subject: true });

    waitForSearchToSearchEverything(searchSlice, function() {
      eSearch.log('initial search completed');
      eSearch.log('slice item length zero', searchSlice.items.length);
    });
  });
});

/**
 * We test everything the file doc-block promises.  We are parameterized by the
 * field(s) we use to search on because we once broke text/html body searching
 * for a year so it's rather important we test that.  We do believe we can
 * reliably assume any screw-ups related to filtering will be orthogonal so we
 * don't need to test all combinations, although we do believe we need to test
 * at least one combination.
 *
 * @param {String} opts.folderName
 * @param {Object} opts.searchFlags
 * @param {Function} opts.messageMaker
 */
function testSearchSlices(T, RT, opts) {
  T.group('setup');
  var testUniverse = T.actor('TestUniverse', 'U'),
      testAccount = T.actor('TestAccount', 'A', { universe: testUniverse,
                                                  restored: true }),
      eBackendSearchSlice = T.actor('SearchSlice'),
      eBodies = T.lazyLogger('bodies'),
      eFolderSlice = T.lazyLogger('folderSlice'),
      eSearch = T.lazyLogger('searchy');


  // Besides having the right things match, we want enough matches in our
  // initial set so that we can shrink a message off each end of the slice
  // and then have a message in the middle that we can alter the flag on and
  // then delete.  We also want a non-matching message in that same range that
  // we can alter the flag on and delete.
  //
  // After that initial set and our manipulations, we want to be able to add
  // new matching messages outside our existing range (both above and below)
  // and one inside our range.
  //
  // We then want to be able to grow the ranges back out and see both the new
  // messages and the messages we had previously abandoned.  We then want to
  // add a 'newest' message that matches and that because of our new-latch
  // behaviour will show up.
  //
  // So here we have a list of names that we'll stash in a dict after we
  // generate the messages.  We generate a match if it has match in the name.
  // We do not add all the messages initially, just some!  The names say it all.
  // These messages are ordered newest to oldest and will have date-stamps
  // appropriately generated.
  var messageNames = [
    'newMatchToAdd', 'initialNewestMiss', 'newestMatchToShrinkOff',
    'spareShrunkNewishMatchToDelete', 'ignoredNewishMatchToAdd',
    'randomNewishMiss',
    'newestMatchAfterShrink', 'insideMatchToMessWith', 'insideMissToMessWith',
    'insideMatchToAdd', 'insideMissToAdd', 'oldestMatchAfterShrink',
    'randomOldishMiss', 'spareShrunkOldishMatchToDelete',
    'ignoredOldishMatchToAdd',
    'oldestMatchToShrinkOff', 'randomOldestMiss'
  ];
  var initialMsgNames = [
    'initialNewestMiss',      'newestMatchToShrinkOff',
    'spareShrunkNewishMatchToDelete',
    'randomNewishMiss',       'newestMatchAfterShrink',
    'insideMatchToMessWith',  'insideMissToMessWith',
    'oldestMatchAfterShrink', 'randomOldishMiss',
    'spareShrunkOldishMatchToDelete',
    'oldestMatchToShrinkOff', 'randomOldestMiss'
  ];
  function nameMatchPred(name) {
    return /match/i.test(name);
  }
  var initialMatchNames = initialMsgNames.filter(nameMatchPred);

  var msgGen = new $msggen.MessageGenerator(testAccount._useDate);

  /**
   * Given the list of names, create the ordered set of synthetic messages
   * stored as a dict with the hidden-ish list inside as `_list`.
   */
  function makeSynMessagesDict(names, msgDefMaker) {
    var orderedList = [];
    var msgs = { _list: orderedList };

    for (var i = 0; i < names.length; i++) {
      var name = names[i];
      var isMatch = /match/i.test(name);
      var wordForThought = (isMatch ? MATCHING_WORD : NONMATCHING_WORD) + i;
      var msgDef = msgDefMaker(wordForThought, i);
      msgDef.age = { days: i };
      if (msgDef.subject) {
        msgDef.subject = name + ' ' + msgDef.subject;
      }
      else {
        msgDef.subject = name;
      }
      var synMessage = msgGen.makeMessage(msgDef);
      orderedList.push(synMessage);
      msgs[name] = synMessage;
    }

    return msgs;
  }

  /**
   * Extract a subset of synthetic mesages by name from the ordered set returned
   * by makeSynMessagesDict.
   */
  function pluckOrderedMessagesFromDict(msgdict, names) {
    var result = [], lastIndex;
    for (var i = 0; i < names.length; i++) {
      var name = names[i];
      var cur = msgdict[name];
      if (!cur) {
        throw new Error('Bad name: ' + name);
      }
      var curIndex = msgdict._list.indexOf(cur);
      if (i && lastIndex > curIndex) {
        throw new Error('ordering screwup, last was ' + lastIndex +
                        ' but cur is ' + curIndex);
      }
      result.push(cur);
      lastIndex = curIndex;
    }
    return result;
  }

  /**
   * Match up the headers to the names and return them as a named/ordered dict
   * along the lines of the one returned by makeSynMessagesDict.  Explode in a
   * violent display of exceptions otherwise.  Note that all matching occurs
   * based on subject and nothing deeper happens.  We know there is sufficient
   * logging around the data in the context we're in.
   */
  function matchAndAssertHeadersMatchExpectedNamesAsDict(mailSlice, names) {
    var dict = { _list: mailSlice.items.concat() };
    var items = mailSlice.items;
    if (items.length !== names.length) {
      throw new Error('Slice item count does not match up with name count');
    }
    for (var i = 0; i < items.length; i++) {
      var header = items[i];
      // unwrap MailMatchedHeader to MailHeader
      if (header.header) {
        var wrapped = header;
        header = header.header;
        header.matchOwner = wrapped;
      }
      var name = names[i];
      var indicatedName = header.subject.split(' ', 1)[0];
      if (indicatedName !== name) {
        throw new Error('got ' + indicatedName + ' expected ' + name);
      }
      dict[name] = header;
    }
    return dict;
  }

  // (statically) create the messages in question; we could do this dynamically
  // too but there's no impact, so hey.
  var synMsgDict = makeSynMessagesDict(messageNames, opts.messageMaker);
  var initialSynMsgs = pluckOrderedMessagesFromDict(synMsgDict,
                                                    initialMsgNames);

  var testFolder = testAccount.do_createTestFolder(
    opts.folderName,
    function returnInitialSynMessages() {
      return initialSynMsgs;
    });

  // body searches need the full body on-hand
  T.group('sync all messages in folder and download all message bodies');
  var DISABLE_THRESH_USING_FUTURE = -60 * 60 * 1000;
  // REFACTOR-TODO: smoosh this all into a 'sync everything helper'
  testUniverse.do_adjustSyncValues({
    // have the slice include all the messages
    fillSize: initialSynMsgs.length,
    // get all the messages in one fetch
    wholeFolderSync: initialSynMsgs.length + 1,
  });

  var fullView = testAccount.do_openFolderView(
    'full download view', testFolder,
    { count: initialSynMsgs.length, full: initialSynMsgs.length, flags: 0,
      deleted: 0 },
    { top: true, bottom: true, grow: false },
    { syncedToDawnOfTime: true });

  var initialHeadersDict = null;
  T.action('download all bodies', eBodies, function() {
    eBodies.expect('downloaded');
    fullView.slice.maybeRequestBodies(
      0, fullView.slice.items.length - 1,
      // none of these bodies will be more than a meg.
      { maximumBytesToFetch: 1024 * 1024 },
      function() {
        initialHeadersDict = matchAndAssertHeadersMatchExpectedNamesAsDict(
                               fullView.slice, initialMsgNames);
        eBodies.log('downloaded');
      });
  });

  T.group('search on initial state');
  var searchSlice, initialMatchHeaders;
  T.action('initial', eSearch, eBackendSearchSlice, function() {
    eSearch.expect('initial search completed');

    searchSlice = testAccount.MailAPI.searchFolderMessages(
      testFolder.mailFolder, MATCHING_WORD, opts.searchFlags);

    waitForSearchToSearchEverything(searchSlice, function() {
      initialMatchHeaders =
        matchAndAssertHeadersMatchExpectedNamesAsDict(searchSlice,
                                                      initialMatchNames);
      eSearch.log('initial search completed');
    });
  });
  T.action('hook search changes', function() {
    searchSlice.onadd = function(match) {
      eSearch.log('header added', match.header.subject);
    };
    searchSlice.onchange = function(match) {
      eSearch.log('header changed', match.header.subject);
      eSearch.log('starred', match.header.isStarred);
    };
    searchSlice.onremove = function(match) {
      eSearch.log('header removed', match.header.subject);
    };
  });


  T.group('shrink off');
  // shrink some off, we should hear splices to know when it's done
  T.action('shrink', eSearch, function() {
    // the high range is chopped off first with a splice so locally ascending
    eSearch.expect(
      'header removed',
      initialMatchHeaders.spareShrunkOldishMatchToDelete.subject);
    eSearch.expect(
      'header removed', initialMatchHeaders.oldestMatchToShrinkOff.subject);
    // then the low range, again locally ascending
    eSearch.expect(
      'header removed', initialMatchHeaders.newestMatchToShrinkOff.subject);
    eSearch.expect(
      'header removed',
      initialMatchHeaders.spareShrunkNewishMatchToDelete.subject);

    searchSlice.requestShrinkage(
      searchSlice.items.indexOf(
        initialMatchHeaders.newestMatchAfterShrink.matchOwner),
      searchSlice.items.indexOf(
        initialMatchHeaders.oldestMatchAfterShrink.matchOwner));
  });

  /*
   * Updates: We always just flip the flag.  This is portable if we decide to
   * have a POP3 variant.  We do the flipping on the header in the folder
   * (non-search) slice to avoid getting tricked should we start doing
   * predictive flag updates in the front-end API too.
   */
  T.group('updates');
  T.action('see update for match in search slice', eSearch, function() {
    eSearch.expect('header changed',
                   initialMatchHeaders.insideMatchToMessWith.subject);
    eSearch.expect('starred',  true);

    testAccount.expect_runOp(
      'modtags',
      { local: true, server: true, save: 'local' });

    initialHeadersDict.insideMatchToMessWith.setStarred(true);
  });
  /*
   * Star the matches we shrank off.  Expect to hear about changes from the full
   * folder slice but not from the search slice.
   */
  T.action('no updates for matches outside slice', eSearch, eFolderSlice,
           function() {
    // the job is explicitly processed oldest to newest
    eFolderSlice.expect('folder header changed',
                        initialMatchHeaders.oldestMatchToShrinkOff.subject);
    eFolderSlice.expect('starred',  true);
    eFolderSlice.expect('folder header changed',
                        initialMatchHeaders.newestMatchToShrinkOff.subject);
    eFolderSlice.expect('starred',  true);

    testAccount.expect_runOp(
      'modtags',
      { local: true, server: true, save: 'local' });

    fullView.slice.onadd = function(header) {
      eFolderSlice.log('folder header added',
                              header.subject);
      if (opts.bodyRequiredForMatch) {
        // suppress until we get the body loaded.
        header.data = { suppress: true };
        // we really want the bodies to get downloaded, so also trigger a body
        // download and use withBodyReps so the callback doesn't trigger until
        // the parts are actually downloaded.
        header.getBody({ withBodyReps: true }, function() {
          header.data.suppress = false;
          eFolderSlice.log('folder header body downloaded',
                                  header.subject);
        });
      }
    };
    fullView.slice.onchange = function(header) {
      if (!header.data || !header.data.suppress) {
        eFolderSlice.log('folder header changed', header.subject);
        eFolderSlice.log('starred', header.isStarred);
      }
    };
    fullView.slice.onremove = function(header) {
      eFolderSlice.log('folder header removed', header.subject);
    };

    testAccount.MailAPI.markMessagesStarred([
      initialHeadersDict.newestMatchToShrinkOff,
      initialHeadersDict.oldestMatchToShrinkOff
    ], true);
  });
  T.action('no updates for misses inside slice', eSearch, eFolderSlice,
           function() {
    eFolderSlice.expect('folder header changed',
                        initialHeadersDict.insideMissToMessWith.subject);
    eFolderSlice.expect('starred',  true);

    testAccount.expect_runOp(
      'modtags',
      { local: true, server: true, save: 'local' });

    initialHeadersDict.insideMissToMessWith.setStarred(true);
  });

  T.group('deletions');
  T.action('see deletions of match in search slice', eSearch, function() {
    eSearch.expect('header removed',
                   initialMatchHeaders.insideMatchToMessWith.subject);

    testAccount.expect_runOp(
      'delete',
      // this will establish a second connection for IMAP
      { local: true, server: true, save: 'local', conn: true });

    initialHeadersDict.insideMatchToMessWith.deleteMessage();
  });
  T.action('no deletions for misses inside slice', eSearch, eFolderSlice,
           function() {
    eFolderSlice.expect('folder header removed',
                        initialHeadersDict.insideMissToMessWith.subject);

    testAccount.expect_runOp(
      'delete',
      { local: true, server: true, save: 'local', conn: true });

    initialHeadersDict.insideMissToMessWith.deleteMessage();
  });
  T.action('no deletions for matches outside slice', eSearch, eFolderSlice,
           function() {
    // the job is explicitly processed oldest to newest
    eFolderSlice.expect(
      'folder header removed',
      initialMatchHeaders.spareShrunkOldishMatchToDelete.subject);
    eFolderSlice.expect(
      'folder header removed',
      initialMatchHeaders.spareShrunkNewishMatchToDelete.subject);

    testAccount.expect_runOp(
      'delete',
      { local: true, server: true, save: 'local', conn: true });

    testAccount.MailAPI.deleteMessages([
      initialHeadersDict.spareShrunkNewishMatchToDelete,
      initialHeadersDict.spareShrunkOldishMatchToDelete
    ]);
  });

  /*
   * Addition is somewhat complicated / annoying because body searches obviously
   * want the entire body downloaded before they can match.  We take what could
   * be considered a short-cut and just have our full-body
   */
  T.group('match additions');
  testAccount.do_addMessagesToFolder(
    testFolder,
    function() {
      return pluckOrderedMessagesFromDict(synMsgDict, ['insideMatchToAdd']);
    });
  T.action('see addition of match in search slice', eSearch, eFolderSlice,
           function() {
    var addingSubject = synMsgDict.insideMatchToAdd.subject;
    eFolderSlice.expect(
      'folder header added', addingSubject);
    eFolderSlice.expect('synced');
    if (opts.bodyRequiredForMatch) {
      eFolderSlice.expect(
        'folder header body downloaded', addingSubject);
    }
    // (This is using a different logger so the ordering of the search add
    // versus when the download occurs does not affect test correctness.)
    eSearch.expect('header added',  addingSubject);

    fullView.slice.oncomplete = function() {
      eFolderSlice.log('synced');
    };

    fullView.slice.refresh();
  });


  testAccount.do_addMessagesToFolder(
    testFolder,
    function() {
      return pluckOrderedMessagesFromDict(synMsgDict, ['insideMissToAdd']);
    });
  T.action('no additions for misses inside slice', eSearch, eFolderSlice,
           function() {
    var addingSubject = synMsgDict.insideMissToAdd.subject;
    eFolderSlice.expect(
      'folder header added', addingSubject);
    eFolderSlice.expect('synced');
    if (opts.bodyRequiredForMatch) {
      eFolderSlice.expect(
        'folder header body downloaded', addingSubject);
    }

    fullView.slice.oncomplete = function() {
      eFolderSlice.log('synced');
    };

    fullView.slice.refresh();
  });

  testAccount.do_addMessagesToFolder(
    testFolder,
    function() {
      return pluckOrderedMessagesFromDict(
        synMsgDict, ['ignoredNewishMatchToAdd', 'ignoredOldishMatchToAdd']);
    });
  T.action('no additions for matches outside slice', eSearch, eFolderSlice,
           function() {
    var newSubject = synMsgDict.ignoredNewishMatchToAdd.subject,
        oldSubject = synMsgDict.ignoredOldishMatchToAdd.subject;
    eFolderSlice.expect(
      'folder header added', newSubject);
    eFolderSlice.expect(
      'folder header added', oldSubject);
    eFolderSlice.expect('synced');
    if (opts.bodyRequiredForMatch) {
      eFolderSlice.expect(
        'folder header body downloaded', newSubject);
      eFolderSlice.expect(
        'folder header body downloaded', oldSubject);
    }

    fullView.slice.oncomplete = function() {
      eFolderSlice.log('synced');
    };

    fullView.slice.refresh();
  });

  T.group('re-grow');
  var regrownMatchHeaders;
  T.action('grow to bottom again, encompassing added headers too', eSearch,
           function() {
    // so, first off, we should absolutely not be at the bottom right now.
    eSearch.expect('at bottom before grow',  false);
    // and then we should hear about the messages in order (noting that we
    // deleted "spareShrunkOldishMatchToDelete")
    eSearch.expect('header added',
                   synMsgDict.ignoredOldishMatchToAdd.subject);
    eSearch.expect('header added',
                   synMsgDict.oldestMatchToShrinkOff.subject);
    eSearch.expect('at bottom after grow',  true);
    eSearch.expect('headers.length',  searchSlice.items.length + 2);
    eSearch.expect('desiredHeaders',  searchSlice.items.length + 2);

    var backendSearchSlice = $searchfilter.SearchSlice._TEST_latestInstance;
    searchSlice.oncomplete = function() {
      eSearch.log('at bottom after grow', searchSlice.atBottom);
      eSearch.log('headers.length', searchSlice.items.length);
      eSearch.log('desiredHeaders', backendSearchSlice.desiredHeaders);
    };

    eSearch.log('at bottom before grow', searchSlice.atBottom);
    // ask for way more messages than we know are there.
    searchSlice.requestGrowth(10, false);
  });
  T.action('grow to top again, encompassing added headers too', eSearch,
           function() {
    // so, first off, we should absolutely not be at the top right now.
    eSearch.expect('at top before grow',  false);
    // and then we should hear about the messages newest to oldest because the
    // splice is processed in batch order and these should all be in a single
    // block (noting that we deleted "spareShrunkNewishMatchToDelete")
    eSearch.expect('header added',
                   synMsgDict.newestMatchToShrinkOff.subject);
    eSearch.expect('header added',
                   synMsgDict.ignoredNewishMatchToAdd.subject);
    eSearch.expect('at top after grow',  true);
    eSearch.expect('headers.length',  searchSlice.items.length + 2);
    eSearch.expect('desiredHeaders',  searchSlice.items.length + 2);

    var backendSearchSlice = $searchfilter.SearchSlice._TEST_latestInstance;
    searchSlice.oncomplete = function() {
      eSearch.log('at top after grow', searchSlice.atTop);
      eSearch.log('headers.length', searchSlice.items.length);
      eSearch.log('desiredHeaders', backendSearchSlice.desiredHeaders);
    };

    eSearch.log('at top before grow', searchSlice.atTop);
    // ask for way more messages than we know are there.
    searchSlice.requestGrowth(-10, false);
  });


  T.group('see latched new');
  testAccount.do_addMessagesToFolder(
    testFolder,
    function() {
      return pluckOrderedMessagesFromDict(synMsgDict, ['newMatchToAdd']);
    });
  T.action('see addition of new match when latched to top/new', eSearch,
           eFolderSlice, function() {
    var addingSubject = synMsgDict.newMatchToAdd.subject;
    eFolderSlice.expect(
      'folder header added', addingSubject);
    eFolderSlice.expect('synced');
    if (opts.bodyRequiredForMatch) {
      eFolderSlice.expect(
        'folder header body downloaded', addingSubject);
    }
    // (This is using a different logger so the ordering of the search add
    // versus when the download occurs does not affect test correctness.)
    eSearch.expect(
      'header added', addingSubject);

    fullView.slice.oncomplete = function() {
      eFolderSlice.log('synced');
    };

    fullView.slice.refresh();
  });
}

commonCase('search author', function(T, RT) {
  testSearchSlices(T, RT, {
    folderName: 'search_author',
    searchFlags: { author: true },
    bodyRequiredForMatch: false,
    messageMaker: function(word, i) {
      return { from: { name: word, address: 'bob@example.nul' } };
    },
  });
});

commonCase('search recipients', function(T, RT) {
  testSearchSlices(T, RT, {
    folderName: 'search_recipients',
    searchFlags: { recipients: true },
    bodyRequiredForMatch: false,
    messageMaker: function(word, i) {
      return { to: [{ name: word, address: 'bob@example.nul' }] };
    },
  });
});

commonCase('search subject', function(T, RT) {
  testSearchSlices(T, RT, {
    folderName: 'search_subject',
    searchFlags: { subject: true },
    bodyRequiredForMatch: false,
    messageMaker: function(word, i) {
      return { subject: word };
    },
  });
});

/**
 * Vary where we stash the matching keyword.
 */
commonCase('search recipients or subject', function(T, RT) {
  testSearchSlices(T, RT, {
    folderName: 'search_subject',
    searchFlags: { recipients: true, subject: true },
    bodyRequiredForMatch: false,
    messageMaker: function(word, i) {
      if (i % 2) {
        return { to: [{ name: word, address: 'bob@example.nul' }] };
      }
      else {
        return { subject: word };
      }
    },
  });
});


commonCase('search unquoted text/plain bodies', function(T, RT) {
  testSearchSlices(T, RT, {
    folderName: 'search_body_unquoted_plain',
    searchFlags: { body: 'no-quotes' },
    bodyRequiredForMatch: true,
    messageMaker: function(word, i) {
      return { body: { body: word } };
    },
  });
});

commonCase('search quoted text/plain bodies', function(T, RT) {
  testSearchSlices(T, RT, {
    folderName: 'search_body_quoted_plain',
    searchFlags: { body: 'yes-quotes' },
    bodyRequiredForMatch: true,
    messageMaker: function(word, i) {
      return { body: { body: '> ' + word } };
    },
  });
});

commonCase('search unquoted text/html bodies', function(T, RT) {
  testSearchSlices(T, RT, {
    folderName: 'search_body_unquoted_html',
    searchFlags: { body: 'no-quotes' },
    bodyRequiredForMatch: true,
    messageMaker: function(word, i) {
      var htmlstr = '<b>' + word.substring(0, 4) + '</b>' +
                      '<blockquote>gibberish</blockquote>' +
                      word.substring(4);
      return { body: { body: htmlstr, contentType: 'text/html' } };
    },
  });
});

commonCase('search quoted text/html bodies', function(T, RT) {
  testSearchSlices(T, RT, {
    folderName: 'search_body_quoted_html',
    searchFlags: { body: 'yes-quotes' },
    bodyRequiredForMatch: true,
    messageMaker: function(word, i) {
      var htmlstr = '<blockquote>' + word.substring(0, 4) + '</blockquote>' +
                      word.substring(4);
      return { body: { body: htmlstr, contentType: 'text/html' } };
    },
  });
});

return allTests;

}); // end define
