/**
 * Test FolderStorage's logic focusing on dealing with the impact of async
 * I/O, range edge-cases, block splitting and merging, and forgetting data as
 * needed.
 *
 * This file is partially converted from a straight-up xpcshell test.  Most
 * tests use do_check_eq which does not generate any logging output and so if
 * you want to see what went wrong, you need to check
 * test_folder_storage.js.log.  The ArbPL UI will properly indicate in its
 * summary view that the tests failed, but if you look at the log, you will
 * be potentially misled, although the XPConnect error code killing the test
 * case can be seen in the first failing test.  (Subsequent tests get skipped
 * because do_check_eq kills the event loop when it fails.)
 **/

load('resources/loggest_test_framework.js');

var TD = $tc.defineTestsFor(
  { id: 'test_folder_storage' }, null, [$th_imap.TESTHELPER], ['app']);

function MockDB() {
}
MockDB.prototype = {
};

function MockAccount() {
}
MockAccount.prototype = {
  accountDef: {
    syncRange: 'auto',
  },
  tzOffset: 0,
  scheduleMessagePurge: function() {
  },
};

/**
 * Create the FolderStorage instance for a test run plus the required mocks.
 */
function makeTestContext() {
  var db = new MockDB(),
      account = new MockAccount();

  var folderId = 'A/1';
  var storage = new $_mailslice.FolderStorage(
    account, folderId,
    {
      $meta: {
        id: folderId,
        name: 'Inbox',
        path: 'Inbox',
        type: 'inbox',
        depth: 0
      },
      $impl: {
        nextId: 0,
        nextHeaderBlock: 0,
        nextBodyBlock: 0,
      },
      accuracy: [],
      headerBlocks: [],
      bodyBlocks: [],
      serverIdHeaderBlockMapping: {},
    },
    db,
    null);
  return {
    account: account,
    db: db,
    storage: storage,
    insertBody: function(date, uid, size, expectedBlockIndex) {
      var blockInfo = null;
      var bodyInfo = {
        date: date, size: size,
        to: null, cc: null, bcc: null, replyTo: null,
        attachments: [], relatedParts: [], references: [], bodyReps: [],
      };
      storage._insertIntoBlockUsingDateAndUID(
        'body', date, uid, 'S' + uid, size, bodyInfo,
        function blockPicked(info, block) {
          // Make sure the insertion happens in the block location we were
          // expecting.
          do_check_eq(storage._bodyBlockInfos.indexOf(info),
                      expectedBlockIndex);
          blockInfo = info;

          // Make sure the insertion took.
          if (block.uids.indexOf(uid) === -1)
            do_throw('UID was not inserted!');
          if (!block.bodies.hasOwnProperty(uid))
            do_throw('body was not inserted!');
        });
      return bodyInfo;
    },
    deleteBody: function(date, uid) {
      storage._deleteFromBlock('body', date, uid, function blockDeleted() {
      });
    },
    /**
     * Clear the list of dirty blocks.
     */
    resetDirtyBlocks: function() {
      storage._dirtyBodyBlocks = {};
    },
    /**
     * Assert that all of the given body blocks are marked dirty.
     */
    checkDirtyBodyBlocks: function(bodyIndices, nukedInfos) {
      var i, blockInfo;
      if (bodyIndices == null)
        bodyIndices = [];
      for (i = 0; i < bodyIndices.length; i++) {
        blockInfo = storage._bodyBlockInfos[bodyIndices[i]];
        do_check_true(
          storage._dirtyBodyBlocks.hasOwnProperty(blockInfo.blockId));
        do_check_true(
          storage._dirtyBodyBlocks[blockInfo.blockId] ===
            storage._bodyBlocks[blockInfo.blockId]);
      }
      if (nukedInfos == null)
        nukedInfos = [];
      for (i = 0; i < nukedInfos.length; i++) {
        blockInfo = nukedInfos[blockInfo];
        do_check_true(
          storage._dirtyBodyBlocks.hasOwnProperty(blockInfo.blockId));
        do_check_true(
          storage._dirtyBodyBlocks[blockInfo.blockId] === null);
      }
    },
    /**
     * Create a new header; no expectations, this is just setup logic.
     */
    insertHeader: function(date, uid) {
      var headerInfo = {
        date: date,
        id: uid,
        // have the server-id differ
        srvid: 'S' + uid,
        suid: folderId + '/' + uid,
        guid: uid,
      };
      storage.addMessageHeader(headerInfo);
      return headerInfo;
    },

    checkServerIdMapForHeaders: function(headers, expectedBlockId) {
      var serverIdHeaderBlockMapping = storage._serverIdHeaderBlockMapping,
          msg;
      for (var i = 0; i < headers.length; i++) {
        var header = headers[i];
        if (expectedBlockId !== null) {
          if (!serverIdHeaderBlockMapping.hasOwnProperty(header.srvid) ||
              serverIdHeaderBlockMapping[header.srvid] !== expectedBlockId) {
            msg = 'header with server id ' + header.srvid + ' has block id ' +
                  'of ' + serverIdHeaderBlockMapping[header.srvid] +
                  ' instead of ' + expectedBlockId;
            console.error(msg);
            do_throw(msg);
          }
       }
       else {
         if (serverIdHeaderBlockMapping.hasOwnProperty(header.srvid)) {
           msg = 'header with server id ' + header.srvid + ' should not be ' +
             'present in server id map, but has value: ' +
             serverIdHeaderBlockMapping[header.srvid];
           console.error(msg);
           do_throw(msg);
         }
       }
      }
    },

    checkNeedsRefresh: function(checkStart, checkEnd,
                                expectedStart, expectedEnd) {
      var result = storage.checkAccuracyCoverageNeedingRefresh(
                     checkStart, checkEnd, $_syncbase.OPEN_REFRESH_THRESH_MS);
      do_check_eq(expectedStart, result && result.startTS);
      do_check_eq(expectedEnd, result && result.endTS);
    },
  };
}

function makeDummyHeaders(count) {
  var dayNum = 1, monthNum = 0;
  var headers = [], uid = 100;
  while (count--) {
    headers.push({
      id: uid,
      srvid: 'S' + uid,
      suid: 'H/1/' + uid,
      guid: 'message-' + uid++,
      author: null,
      date: Date.UTC(2010, monthNum, dayNum++),
      flags: null, hasAttachments: null, subject: null, snippet: null,
    });
    // rather limited rollover support
    if (monthNum === 0 && dayNum === 32) {
      monthNum = 1;
      dayNum = 1;
    }
  }
  headers.reverse();
  return headers;
}

function thunkConsole(T) {
  var lazyConsole = T.lazyLogger('console');

  gConsoleLogFunc = function(msg) {
    lazyConsole.value(msg);
  };
}

/**
 * Byte size so that 2 fit in a block, but 3 will not.
 */
const BIG2 = 36 * 1024;
/**
 * Byte size so that 3 fit in a block, but 4 will not.
 */
const BIG3 = 28 * 1024;
/**
 * Byte size so that 5 fit in a block, but 6 will not.
 */
const BIG5 = 18 * 1024;

/**
 * Byte size that exceeds our target block size.
 */
const TOOBIG = 128 * 1024;


/**
 * Create messages distributed so that we have 5 headers per header block and
 * 3 bodies per body blocks.
 */
function injectSomeMessages(ctx, count, bodySize) {
  var headers = makeDummyHeaders(count),
      BS = BIG3;

  // headers are ordered newest[0] to oldest[n-1]
  for (var i = 0; i < headers.length; i++) {
    var header = headers[i];
    ctx.storage.addMessageHeader(header);
    var bodyInfo = {
      date: header.date, get size() { return bodySize; },
      set size(val) {},
      to: null, cc: null, bcc: null, replyTo: null,
      attachments: null, relatedParts: null, bodyReps: null
    };
    ctx.storage.addMessageBody(header, bodyInfo);
  }
  return headers;
}

////////////////////////////////////////////////////////////////////////////////
// Test helper functions

TD.commonSimple('tuple range intersection', function test_tuple_range_isect() {
  var intersect = $_mailslice.tupleRangeIntersectsTupleRange;

  function checkBoth(a, b, result) {
    do_check_eq(intersect(a, b), result);
    do_check_eq(intersect(b, a), result);
  }

  // -- non-intersecting variants
  // date-wise
  checkBoth(
    { startTS: 200, startUID: 0, endTS: 300, endUID: 0 },
    { startTS: 0, startUID: 0, endTS: 100, endUID: 0 },
    false);
  // uid-wise
  checkBoth(
    { startTS: 200, startUID: 1, endTS: 300, endUID: 0 },
    { startTS: 0, startUID: 0, endTS: 200, endUID: 0 },
    false);

  // -- intersecting variants
  // completely contained date-wise
  checkBoth(
    { startTS: 0, startUID: 0, endTS: 300, endUID: 0 },
    { startTS: 100, startUID: 0, endTS: 200, endUID: 0 },
    true);
  // completely contained uid-wise
  checkBoth(
    { startTS: 0, startUID: 0, endTS: 0, endUID: 40 },
    { startTS: 0, startUID: 10, endTS: 0, endUID: 20 },
    true);
  // completely contained date/uid-wise
  checkBoth(
    { startTS: 0, startUID: 0, endTS: 300, endUID: 0 },
    { startTS: 0, startUID: 1, endTS: 200, endUID: 0 },
    true);
  checkBoth(
    { startTS: 0, startUID: 0, endTS: 200, endUID: 20 },
    { startTS: 100, startUID: 0, endTS: 200, endUID: 10 },
    true);

  // partially contained date-wise
  checkBoth(
    { startTS: 0, startUID: 0, endTS: 200, endUID: 0 },
    { startTS: 100, startUID: 0, endTS: 300, endUID: 0 },
    true);
  // partially contained uid-wise
  checkBoth(
    { startTS: 0, startUID: 0, endTS: 0, endUID: 30 },
    { startTS: 0, startUID: 20, endTS: 0, endUID: 40 },
    true);
  // partially contained date/uid-wise
  checkBoth(
    { startTS: 0, startUID: 0, endTS: 100, endUID: 0 },
    { startTS: 0, startUID: 20, endTS: 200, endUID: 0 },
    true);
  checkBoth(
    { startTS: 0, startUID: 0, endTS: 200, endUID: 0 },
    { startTS: 100, startUID: 0, endTS: 200, endUID: 40 },
    true);
});

////////////////////////////////////////////////////////////////////////////////
// Sync accuracy regions.
//
// NB: End dates are EXCLUSIVE.

/**
 * We were using Date.UTC, but it turns out those timestamps are hard to read,
 * so let's just encode things so that they make sense to us...
 */
function DateUTC(y, m, d) {
  return y * 100000 + m * 1000 + d * 10;
}

/**
 * Helper to check the values of an accuracy range entry.
 */
function check_arange_eq(arange, startTS, endTS, highestModseq, updated) {
  do_check_eq(arange.startTS, startTS);
  do_check_eq(arange.endTS, endTS);
  do_check_eq(arange.fullSync.highestModseq, highestModseq);
  do_check_eq(arange.fullSync.updated, updated);
}

/**
 * No existing accuracy ranges, create a new one.
 */
TD.commonSimple('accuracy base case', function test_accuracy_base_case() {
  var ctx = makeTestContext(),
      d1 = DateUTC(2010, 0, 1),
      d2 = DateUTC(2010, 0, 2),
      dSync = DateUTC(2010, 1, 1);

  ctx.storage.markSyncRange(d1, d2, '1', dSync);

  var aranges = ctx.storage._accuracyRanges;
  do_check_eq(aranges.length, 1);
  check_arange_eq(aranges[0], d1, d2, '1', dSync);
});
/**
 * Accuracy range does not overlap existing ranges.
 */
TD.commonSimple('accuracy non-overlapping',
                function test_accuracy_nonoverlap() {
  var ctx = makeTestContext(),
      d1 = DateUTC(2010, 0, 1),
      d2 = DateUTC(2010, 0, 2),
      d3 = DateUTC(2010, 0, 3),
      d4 = DateUTC(2010, 0, 4),
      d5 = DateUTC(2010, 0, 5),
      d6 = DateUTC(2010, 0, 6),
      d7 = DateUTC(2010, 0, 7),
      d8 = DateUTC(2010, 0, 8),
      dSync1 = DateUTC(2010, 1, 1),
      dSync2 = DateUTC(2010, 1, 2),
      dSync3 = DateUTC(2010, 1, 3),
      dSync4 = DateUTC(2010, 1, 4),
      dSync5 = DateUTC(2010, 1, 5);

  // - date ranges where the exclusive nature of 'end' does not matter
  ctx.storage.markSyncRange(d5, d6, '1', dSync1);
  ctx.storage.markSyncRange(d1, d2, '2', dSync2);
  ctx.storage.markSyncRange(d3, d4, '3', dSync3);
  ctx.storage.markSyncRange(d7, d8, '4', dSync4);

  var aranges = ctx.storage._accuracyRanges;
  do_check_eq(aranges.length, 4);
  check_arange_eq(aranges[0], d7, d8, '4', dSync4);
  check_arange_eq(aranges[1], d5, d6, '1', dSync1);
  check_arange_eq(aranges[2], d3, d4, '3', dSync3);
  check_arange_eq(aranges[3], d1, d2, '2', dSync2);

  // - make sure adjacent values where end's exclusion matters doesn't break
  ctx.storage.markSyncRange(d2, d3, '5', dSync5);

  do_check_eq(aranges.length, 5);
  check_arange_eq(aranges[2], d3, d4, '3', dSync3);
  check_arange_eq(aranges[3], d2, d3, '5', dSync5);
  check_arange_eq(aranges[4], d1, d2, '2', dSync2);
});
/**
 * Accuracy range completely contains one or more existing ranges with no
 * partial overlap.
 */
TD.commonSimple('accuracy contains', function test_accuracy_contains() {
  var ctx = makeTestContext(),
      d2 = DateUTC(2010, 0, 2),
      d3 = DateUTC(2010, 0, 3),
      d4 = DateUTC(2010, 0, 4),
      d5 = DateUTC(2010, 0, 5),
      d6 = DateUTC(2010, 0, 6),
      d7 = DateUTC(2010, 0, 7),
      d8 = DateUTC(2010, 0, 8),
      d9 = DateUTC(2010, 0, 9),
      dA = DateUTC(2010, 0, 10),
      dB = DateUTC(2010, 0, 11),
      dC = DateUTC(2010, 0, 12),
      dSync1 = DateUTC(2010, 1, 1),
      dSync2 = DateUTC(2010, 1, 2),
      dSync3 = DateUTC(2010, 1, 3),
      dSync4 = DateUTC(2010, 1, 4),
      dSync5 = DateUTC(2010, 1, 5),
      dSync6 = DateUTC(2010, 1, 6),
      dSync7 = DateUTC(2010, 1, 7),
      aranges = ctx.storage._accuracyRanges;

  ctx.storage.markSyncRange(d4, d5, '1', dSync1);
  // - same
  ctx.storage.markSyncRange(d4, d5, '2', dSync2);

  do_check_eq(aranges.length, 1);
  check_arange_eq(aranges[0], d4, d5, '2', dSync2);

  // - larger on the start side
  ctx.storage.markSyncRange(d3, d5, '3', dSync3);

  do_check_eq(aranges.length, 1);
  check_arange_eq(aranges[0], d3, d5, '3', dSync3);

  // - larger on the end side
  ctx.storage.markSyncRange(d3, d6, '4', dSync4);

  do_check_eq(aranges.length, 1);
  check_arange_eq(aranges[0], d3, d6, '4', dSync4);

  // - larger on both sides
  ctx.storage.markSyncRange(d2, d7, '5', dSync5);

  do_check_eq(aranges.length, 1);
  check_arange_eq(aranges[0], d2, d7, '5', dSync5);

  // - (adjacent small ranges added correctly)
  ctx.storage.markSyncRange(dA, dB, '6', dSync6);
  ctx.storage.markSyncRange(d8, d9, '6', dSync6);

  do_check_eq(aranges.length, 3);
  check_arange_eq(aranges[2], d2, d7, '5', dSync5);
  check_arange_eq(aranges[1], d8, d9, '6', dSync6);
  check_arange_eq(aranges[0], dA, dB, '6', dSync6);

  // - contain multiple, larger on end side
  ctx.storage.markSyncRange(d2, dC, '7', dSync7);

  do_check_eq(aranges.length, 1);
  check_arange_eq(aranges[0], d2, dC, '7', dSync7);
});

/**
 * Accuracy range has partial overlap: younger, older, inside, younger+older,
 * younger+older+contained.
 */
TD.commonSimple('accuracy overlapping', function test_accuracy_overlap() {
  var ctx = makeTestContext(),
      d2 = DateUTC(2010, 0, 2),
      d3 = DateUTC(2010, 0, 3),
      d4 = DateUTC(2010, 0, 4),
      d5 = DateUTC(2010, 0, 5),
      d6 = DateUTC(2010, 0, 6),
      d7 = DateUTC(2010, 0, 7),
      d8 = DateUTC(2010, 0, 8),
      d9 = DateUTC(2010, 0, 9),
      dA = DateUTC(2010, 0, 10),
      dSync1 = DateUTC(2010, 1, 1),
      dSync2 = DateUTC(2010, 1, 2),
      dSync3 = DateUTC(2010, 1, 3),
      dSync4 = DateUTC(2010, 1, 4),
      dSync5 = DateUTC(2010, 1, 5),
      aranges = ctx.storage._accuracyRanges;

  ctx.storage.markSyncRange(d4, d9, '1', dSync1);

  // - younger
  ctx.storage.markSyncRange(d3, d5, '2', dSync2);

  do_check_eq(aranges.length, 2);
  check_arange_eq(aranges[0], d5, d9, '1', dSync1);
  check_arange_eq(aranges[1], d3, d5, '2', dSync2);

  // - older
  ctx.storage.markSyncRange(d8, dA, '3', dSync3);

  do_check_eq(aranges.length, 3);
  check_arange_eq(aranges[0], d8, dA, '3', dSync3);
  check_arange_eq(aranges[1], d5, d8, '1', dSync1);
  check_arange_eq(aranges[2], d3, d5, '2', dSync2);

  // - inside
  ctx.storage.markSyncRange(d6, d7, '4', dSync4);

  do_check_eq(aranges.length, 5);
  check_arange_eq(aranges[0], d8, dA, '3', dSync3);
  check_arange_eq(aranges[1], d7, d8, '1', dSync1);
  check_arange_eq(aranges[2], d6, d7, '4', dSync4);
  check_arange_eq(aranges[3], d5, d6, '1', dSync1);
  check_arange_eq(aranges[4], d3, d5, '2', dSync2);

  // - younger + older + contained
  ctx.storage.markSyncRange(d4, d9, '5', dSync5);

  do_check_eq(aranges.length, 3);
  check_arange_eq(aranges[0], d9, dA, '3', dSync3);
  check_arange_eq(aranges[1], d4, d9, '5', dSync5);
  check_arange_eq(aranges[2], d3, d4, '2', dSync2);
});

/**
 * Accuracy range merges when using the same modseq/update values.
 */
TD.commonSimple('accuracy merge', function test_accuracy_merge() {
  var ctx = makeTestContext(),
      d4 = DateUTC(2010, 0, 4),
      d5 = DateUTC(2010, 0, 5),
      d6 = DateUTC(2010, 0, 6),
      d7 = DateUTC(2010, 0, 7),
      d8 = DateUTC(2010, 0, 8),
      d9 = DateUTC(2010, 0, 9),
      dA = DateUTC(2010, 0, 10),
      dB = DateUTC(2010, 0, 11),
      dSync1 = DateUTC(2010, 1, 1),
      dSync2 = DateUTC(2010, 1, 2),
      aranges = ctx.storage._accuracyRanges;

  // - blatant overlap
  ctx.storage.markSyncRange(d5, d7, '1', dSync1);
  ctx.storage.markSyncRange(d6, d8, '1', dSync1);

  do_check_eq(aranges.length, 1);
  check_arange_eq(aranges[0], d5, d8, '1', dSync1);

  // - adjacent (exclusion lines up), both sides (single sided)
  ctx.storage.markSyncRange(d8, d9, '1', dSync1);
  ctx.storage.markSyncRange(d4, d5, '1', dSync1);

  do_check_eq(aranges.length, 1);
  check_arange_eq(aranges[0], d4, d9, '1', dSync1);

  // - adjacent merge, both-sides
  // other range
  ctx.storage.markSyncRange(dA, dB, '1', dSync1);
  // thing that should merge on both sides
  ctx.storage.markSyncRange(d9, dA, '1', dSync1);

  do_check_eq(aranges.length, 1);
  check_arange_eq(aranges[0], d4, dB, '1', dSync1);

  // - re-merge after split
  ctx.storage.markSyncRange(d6, d9, '2', dSync2);
  ctx.storage.markSyncRange(d6, d9, '1', dSync1);

  do_check_eq(aranges.length, 1);
  check_arange_eq(aranges[0], d4, dB, '1', dSync1);
});

/**
 * Check accuracy range stuff; generate a static set of accuracy ranges that
 * should cover all permutations (except for being first/last, but we are
 * reusing our range-finding helpers that have coverage)
 */
TD.commonSimple('accuracy refresh check', function test_accuracy_refresh() {
  var ctx = makeTestContext(),
      d1 = DateUTC(2010, 0, 1),
      d2 = DateUTC(2010, 0, 2),
      d3 = DateUTC(2010, 0, 3),
      d4 = DateUTC(2010, 0, 4),
      d5 = DateUTC(2010, 0, 5),
      d6 = DateUTC(2010, 0, 6),
      d7 = DateUTC(2010, 0, 7),
      d8 = DateUTC(2010, 0, 8),
      d9 = DateUTC(2010, 0, 9),
      dA = DateUTC(2010, 0, 10),
      dB = DateUTC(2010, 0, 11),
      dC = DateUTC(2010, 0, 12),
      dD = DateUTC(2010, 0, 13),
      dE = DateUTC(2010, 0, 14),
      dF = DateUTC(2010, 0, 15),
      d10 = DateUTC(2010, 0, 16),
      d11 = DateUTC(2010, 0, 17),
      d12 = DateUTC(2010, 0, 18),
      dSyncRecent = $_date.NOW() - $_syncbase.OPEN_REFRESH_THRESH_MS / 2,
      dSyncOld = $_date.NOW() - $_syncbase.OPEN_REFRESH_THRESH_MS * 2;

  // -- build ranges
  // - sufficient, fully be contained by/overlap on both sides into nothing
  ctx.storage.markSyncRange(d2, d5, 'x', dSyncRecent);

  // - insufficient, fully be contained by/overlap on both sides into nothing
  ctx.storage.markSyncRange(d7, dA, 'x', dSyncOld);

  // - insufficient, overlap on both sides into something so range is reduced
  ctx.storage.markSyncRange(dC, dD, 'x', dSyncRecent);
  ctx.storage.markSyncRange(dD, d10, 'x', dSyncOld);
  ctx.storage.markSyncRange(d10, d11, 'x', dSyncRecent);

  // -- check ranges
  // (We defer the checks until after the accuracy ranges are fully populated to
  //  make debugging simpler.)

  // - sufficient, fully be contained by/overlap on both sides into nothing
  // fully contained is good
  ctx.checkNeedsRefresh(d3, d4, null, null);
  // up to the limits is good
  ctx.checkNeedsRefresh(d2, d5, null, null);
  // start-side partial gets reduced (not lining up with accuracy range proper)
  ctx.checkNeedsRefresh(d3, d7, d5, d7);
  // end-side partial gets reduced (not lining up with accuracy range proper)
  ctx.checkNeedsRefresh(d1, d4, d1, d2);
  // check range exceeds/fully contains recent-enough; can't reduce the range
  ctx.checkNeedsRefresh(d1, d6, d1, d6);

  // - insufficient, fully be contained by/overlap on both sides into nothing
  // fully contained in too-old does nothing for us
  ctx.checkNeedsRefresh(d8, d9, d8, d9);
  // at limits too-old does nothing for us
  ctx.checkNeedsRefresh(d7, dA, d7, dA);
  // check range exceeds/fully contains too-old does nothing for us
  ctx.checkNeedsRefresh(d6, dB, d6, dB);

  // - insufficient, overlap on both sides into something so range is reduced
  // fully contained in too-old does nothing for us
  ctx.checkNeedsRefresh(dE, dF, dE, dF);
  // at limits of too-old does nothing for us
  ctx.checkNeedsRefresh(dD, d10, dD, d10);
  // recent enough truncates range before/after/both
  ctx.checkNeedsRefresh(dC, d10, dD, d10);
  ctx.checkNeedsRefresh(dD, d11, dD, d10);
  ctx.checkNeedsRefresh(dC, d11, dD, d10);
  // going outside the recent range loses us the truncation
  ctx.checkNeedsRefresh(dB, d12, dB, d12);
});


////////////////////////////////////////////////////////////////////////////////
// Header/body insertion/deletion into/out of blocks.
//
// UIDs are in the 100's to make equivalence failure types more obvious.

/**
 * Helper to check the values in a block info structure.
 */
function check_block(blockInfo, count, size, startTS, startUID, endTS, endUID) {
  do_check_eq(blockInfo.count, count);
  do_check_eq(blockInfo.startTS, startTS);
  do_check_eq(blockInfo.startUID, startUID);
  do_check_eq(blockInfo.endTS, endTS);
  do_check_eq(blockInfo.endUID, endUID);
  do_check_eq(blockInfo.estSize, size);
}

function check_body_block_contents(bodyBlock, uids, bodies) {
  do_check_neq(bodyBlock, undefined);
  do_check_eq(uids.length, bodyBlock.uids.length);
  for (var i = 0; i < uids.length; i++){
    do_check_eq(uids[i], bodyBlock.uids[i]);
    do_check_eq(bodies[i], bodyBlock.bodies[uids[i]]);
  }
}

/**
 * Base case: there are no blocks yet!
 */
TD.commonSimple('insertion: no existing blocks',
                function test_insertion_no_existing_blocks() {
  var ctx = makeTestContext(),
      d5 = DateUTC(2010, 0, 5),
      uid1 = 101,
      BS = 512,
      bodyBlocks = ctx.storage._bodyBlockInfos;

  do_check_eq(bodyBlocks.length, 0);

  ctx.insertBody(d5, uid1, BS, 0);

  do_check_eq(bodyBlocks.length, 1);
  check_block(bodyBlocks[0], 1, BS, d5, uid1, d5, uid1);

  ctx.checkDirtyBodyBlocks([0]);
});

/**
 * Insertion point is adjacent to an existing block and will not overflow it;
 * use the block, checking directional preferences.  The directional preferences
 * test requires us to artificially inject an additional block since we aren't
 * triggering deletion for these tests.
 */
TD.commonSimple('insertion: adjacent simple',
                function test_insertion_adjacent_simple() {
  var ctx = makeTestContext(),
      d5 = DateUTC(2010, 0, 5),
      d6 = DateUTC(2010, 0, 6),
      d7 = DateUTC(2010, 0, 7),
      d8 = DateUTC(2010, 0, 8),
      d9 = DateUTC(2010, 0, 9),
      uid1 = 101,
      uid2 = 102,
      uid3 = 103,
      uid4 = 104,
      uid5 = 105,
      uid6 = 106,
      BS = 512,
      bodyBlocks = ctx.storage._bodyBlockInfos;

  // base case
  ctx.insertBody(d5, uid2, BS, 0);

  // - uid growth cases
  // numerically greater UID
  ctx.insertBody(d5, uid3, BS, 0);

  do_check_eq(bodyBlocks.length, 1);
  check_block(bodyBlocks[0], 2, 2 * BS, d5, uid2, d5, uid3);

  // numerically lesser UID
  ctx.insertBody(d5, uid1, BS, 0);

  do_check_eq(bodyBlocks.length, 1);
  check_block(bodyBlocks[0], 3, 3 * BS, d5, uid1, d5, uid3);

  ctx.checkDirtyBodyBlocks([0]);

  // - directional preferences (after injecting more recent block)
  // inject the block that shouldn't be there...
  var synInfo = ctx.storage._makeBodyBlock(d8, uid4, d9, uid5);
  synInfo.count = 2;
  synInfo.estSize = 2 * BS;
  bodyBlocks.splice(0, 0, synInfo);

  // inject one in between, it should favor the older block
  ctx.insertBody(d7, uid6, BS, 1);
  check_block(bodyBlocks[0], 2, 2 * BS, d8, uid4, d9, uid5);
  check_block(bodyBlocks[1], 4, 4 * BS, d5, uid1, d7, uid6);
});

/**
 * Insertion point is in an existing block and will not overflow, use it.
 */
TD.commonSimple('insertion in existing block',
                function test_insertion_in_block_use() {
  var ctx = makeTestContext(),
      d5 = DateUTC(2010, 0, 5),
      d6 = DateUTC(2010, 0, 6),
      d7 = DateUTC(2010, 0, 7),
      uid1 = 101,
      uid2 = 102,
      uid3 = 103,
      BS = 512,
      bodyBlocks = ctx.storage._bodyBlockInfos;

  ctx.insertBody(d5, uid1, BS, 0);
  ctx.insertBody(d7, uid2, BS, 0);
  check_block(bodyBlocks[0], 2, 2 * BS, d5, uid1, d7, uid2);

  ctx.insertBody(d6, uid3, BS, 0);

  do_check_eq(bodyBlocks.length, 1);
  check_block(bodyBlocks[0], 3, 3 * BS, d5, uid1, d7, uid2);
});

/**
 * If we insert an item that's bigger than our threshold as the first item,
 * we don't want that to break by trying to split a block with 1 item into
 * 2 blocks.  We also want to make sure that oversized items don't break our
 * splitting logic by causing us to try and split before the first item or
 * after the last item.
 */
TD.commonSimple('inserting larger-than-block items',
                function test_insertion_oversized_items() {
  var ctx = makeTestContext(),
      d3 = DateUTC(2010, 0, 3),
      d4 = DateUTC(2010, 0, 4),
      d5 = DateUTC(2010, 0, 5),
      d6 = DateUTC(2010, 0, 6),
      d7 = DateUTC(2010, 0, 7),
      d8 = DateUTC(2010, 0, 8),
      d9 = DateUTC(2010, 0, 9),
      dA = DateUTC(2010, 0, 10),
      uid3 = 103, size3 = 3,
      uid4 = 104,
      uid5 = 105, size5 = 5,
      uid6 = 106,
      uid7 = 107, size7 = 7,
      uid8 = 108,
      uid9 = 109, size9 = 9,
      uidA = 110, sizeA = 10,
      bodyBlockInfos = ctx.storage._bodyBlockInfos,
      // this is a cache that won't get flushed during the test
      bodyBlockMap = ctx.storage._bodyBlocks;

  // - insert oversized into empty
  var b6 = ctx.insertBody(d6, uid6, TOOBIG, 0);
  do_check_eq(bodyBlockInfos.length, 1);
  check_block(bodyBlockInfos[0], 1, TOOBIG, d6, uid6, d6, uid6);

  // - insert younger oversized
  var b8 = ctx.insertBody(d8, uid8, TOOBIG, 0);
  do_check_eq(bodyBlockInfos.length, 2);
  check_block(bodyBlockInfos[0], 1, TOOBIG, d8, uid8, d8, uid8);
  check_block(bodyBlockInfos[1], 1, TOOBIG, d6, uid6, d6, uid6);

  // - insert older oversized
  var b4 = ctx.insertBody(d4, uid4, TOOBIG, 2);
  do_check_eq(bodyBlockInfos.length, 3);
  check_block(bodyBlockInfos[0], 1, TOOBIG, d8, uid8, d8, uid8);
  check_block(bodyBlockInfos[1], 1, TOOBIG, d6, uid6, d6, uid6);
  check_block(bodyBlockInfos[2], 1, TOOBIG, d4, uid4, d4, uid4);

  // - insert youngest smalls
  var b9 = ctx.insertBody(d9, uid9, size9, 0),
      bA = ctx.insertBody(dA, uidA, sizeA, 0);
  do_check_eq(bodyBlockInfos.length, 4);
  check_block(bodyBlockInfos[0], 2, size9 + sizeA, d9, uid9, dA, uidA);
  check_block(bodyBlockInfos[1], 1, TOOBIG, d8, uid8, d8, uid8);
  check_block(bodyBlockInfos[2], 1, TOOBIG, d6, uid6, d6, uid6);
  check_block(bodyBlockInfos[3], 1, TOOBIG, d4, uid4, d4, uid4);

  // - insert oldest smalls
  var b3 = ctx.insertBody(d3, uid3, size3, 4);
  do_check_eq(bodyBlockInfos.length, 5);
  check_block(bodyBlockInfos[0], 2, size9 + sizeA, d9, uid9, dA, uidA);
  check_block(bodyBlockInfos[1], 1, TOOBIG, d8, uid8, d8, uid8);
  check_block(bodyBlockInfos[2], 1, TOOBIG, d6, uid6, d6, uid6);
  check_block(bodyBlockInfos[3], 1, TOOBIG, d4, uid4, d4, uid4);
  check_block(bodyBlockInfos[4], 1, size3, d3, uid3, d3, uid3);

  // - insert small between bigs
  var b7 = ctx.insertBody(d7, uid7, size7, 2);
  do_check_eq(bodyBlockInfos.length, 6);
  check_block(bodyBlockInfos[0], 2, size9 + sizeA, d9, uid9, dA, uidA);
  check_block(bodyBlockInfos[1], 1, TOOBIG, d8, uid8, d8, uid8);
  check_block(bodyBlockInfos[2], 1, size7, d7, uid7, d7, uid7);
  check_block(bodyBlockInfos[3], 1, TOOBIG, d6, uid6, d6, uid6);
  check_block(bodyBlockInfos[4], 1, TOOBIG, d4, uid4, d4, uid4);
  check_block(bodyBlockInfos[5], 1, size3, d3, uid3, d3, uid3);

});

/**
 * Insertion point is in an existing block and will overflow, split it.
 */
TD.commonSimple('insertion in block that will overflow',
                function test_insertion_in_block_overflow_split() {
  var ctx = makeTestContext(),
      d5 = DateUTC(2010, 0, 5),
      d6 = DateUTC(2010, 0, 6),
      d7 = DateUTC(2010, 0, 7),
      d8 = DateUTC(2010, 0, 8),
      uid1 = 101, size1 = BIG2 + 1,
      uid2 = 102, size2 = BIG2 + 2,
      uid3 = 103, size3 = BIG2 + 3,
      uid4 = 104, size4 = BIG2 + 4,
      BS = 512,
      bodyBlockInfos = ctx.storage._bodyBlockInfos,
      // this is a cache that won't get flushed during the test
      bodyBlockMap = ctx.storage._bodyBlocks;

  var b1 = ctx.insertBody(d5, uid1, size1, 0);
  var b2 = ctx.insertBody(d8, uid2, size2, 0);
  check_block(bodyBlockInfos[0], 2, size1 + size2, d5, uid1, d8, uid2);
  check_body_block_contents(
    bodyBlockMap[bodyBlockInfos[0].blockId],
    [uid2, uid1],
    [b2, b1]);

  ctx.checkDirtyBodyBlocks([0]);
  ctx.resetDirtyBlocks();

  // - Split prefers the older block
  var b3 = ctx.insertBody(d7, uid3, size3, 1);

  do_check_eq(bodyBlockInfos.length, 2);
  check_block(bodyBlockInfos[0], 1, size2, d8, uid2, d8, uid2);
  check_body_block_contents(
    bodyBlockMap[bodyBlockInfos[0].blockId],
    [uid2],
    [b2]);
  check_body_block_contents(
    bodyBlockMap[bodyBlockInfos[1].blockId],
    [uid3, uid1],
    [b3, b1]);
  check_block(bodyBlockInfos[1], 2, size3 + size1, d5, uid1, d7, uid3);

  ctx.checkDirtyBodyBlocks([0, 1]);
  ctx.resetDirtyBlocks();

  // - Split prefers the newer block
  // splits [1] into [1, 2]
  var b4 = ctx.insertBody(d6, uid4, size4, 1);

  do_check_eq(bodyBlockInfos.length, 3);
  check_block(bodyBlockInfos[0], 1, size2, d8, uid2, d8, uid2);
  check_body_block_contents(
    bodyBlockMap[bodyBlockInfos[0].blockId],
    [uid2],
    [b2]);
  check_block(bodyBlockInfos[1], 2, size3 + size4, d6, uid4, d7, uid3);
  check_body_block_contents(
    bodyBlockMap[bodyBlockInfos[1].blockId],
    [uid3, uid4],
    [b3, b4]);
  check_block(bodyBlockInfos[2], 1, size1, d5, uid1, d5, uid1);
  check_body_block_contents(
    bodyBlockMap[bodyBlockInfos[2].blockId],
    [uid1],
    [b1]);

  ctx.checkDirtyBodyBlocks([1, 2]);
});

/**
 * Test the header block splitting logic on its own.  Verify the server id
 * mapping is maintained throughout the split.
 */
TD.commonSimple('header block splitting',
                function test_header_block_splitting() {
  var ctx = makeTestContext(),
      expectedHeadersPerBlock = 115, // Math.ceil(48 * 1024 / 430)
      numHeaders = 230,
      // returned header list has numerically decreasing time/uid
      bigHeaders = makeDummyHeaders(numHeaders),
      bigUids = bigHeaders.map(function (x) { return x.id; }),
      bigInfo = ctx.storage._makeHeaderBlock(
        bigHeaders[numHeaders-1].date, bigHeaders[numHeaders-1].id,
        bigHeaders[0].date, bigHeaders[0].id,
        numHeaders * 430, bigUids.concat(), bigHeaders.concat()),
      bigBlock = ctx.storage._headerBlocks[bigInfo.blockId];

  var olderInfo = ctx.storage._splitHeaderBlock(bigInfo, bigBlock, 48 * 1024),
      olderBlock = ctx.storage._headerBlocks[olderInfo.blockId],
      newerInfo = bigInfo, newerBlock = bigBlock;

  do_check_eq(newerInfo.count, expectedHeadersPerBlock);
  do_check_eq(olderInfo.count, numHeaders - expectedHeadersPerBlock);

  do_check_eq(newerInfo.estSize, newerInfo.count * 430);
  do_check_eq(olderInfo.estSize, olderInfo.count * 430);


  do_check_eq(newerInfo.startTS,
              bigHeaders[expectedHeadersPerBlock-1].date);
  do_check_eq(newerInfo.startUID,
              bigHeaders[expectedHeadersPerBlock-1].id);
  do_check_eq(newerInfo.endTS, bigHeaders[0].date);
  do_check_eq(newerInfo.endUID, bigHeaders[0].id);
  do_check_true(newerBlock.headers[0] === bigHeaders[0]);
  do_check_eq(newerBlock.headers.length, newerInfo.count);
  do_check_eq(newerBlock.headers[0].id, newerBlock.uids[0]);
  do_check_eq(newerBlock.uids.length, newerInfo.count);
  do_check_true(newerBlock.headers[expectedHeadersPerBlock-1] ===
                bigHeaders[expectedHeadersPerBlock-1]);

  do_check_eq(olderInfo.startTS, bigHeaders[numHeaders-1].date);
  do_check_eq(olderInfo.startUID, bigHeaders[numHeaders-1].id);
  do_check_eq(olderInfo.endTS, bigHeaders[expectedHeadersPerBlock].date);
  do_check_eq(olderInfo.endUID, bigHeaders[expectedHeadersPerBlock].id);
  do_check_true(olderBlock.headers[0] === bigHeaders[expectedHeadersPerBlock]);
  do_check_eq(olderBlock.headers.length, olderInfo.count);
  do_check_eq(olderBlock.headers[0].id, olderBlock.uids[0]);
  do_check_eq(olderBlock.uids.length, olderInfo.count);
  do_check_true(olderBlock.headers[numHeaders - expectedHeadersPerBlock - 1] ===
                bigHeaders[numHeaders - 1]);

  ctx.checkServerIdMapForHeaders(
    bigHeaders.slice(0, expectedHeadersPerBlock), newerInfo.blockId);
  ctx.checkServerIdMapForHeaders(
    bigHeaders.slice(expectedHeadersPerBlock), olderInfo.blockId);
});


/**
 * Test that deleting a body out of a block that does not empty the block
 * updates the values appropriately, then empty it and see it go away.
 */
TD.commonSimple('body deletion', function test_body_deletion() {
  var ctx = makeTestContext(),
      d5 = DateUTC(2010, 0, 5),
      d7 = DateUTC(2010, 0, 7),
      d8 = DateUTC(2010, 0, 8),
      uid1 = 101,
      uid2 = 102,
      uid3 = 103,
      uid4 = 104,
      BS = 512,
      bodyBlocks = ctx.storage._bodyBlockInfos;

  // - Setup: [1, 2]
  ctx.insertBody(d5, uid1, BIG2, 0);
  ctx.insertBody(d8, uid2, BIG2, 0);
  ctx.insertBody(d7, uid3, BIG2, 1);

  do_check_eq(bodyBlocks.length, 2);
  check_block(bodyBlocks[0], 1, 1 * BIG2, d8, uid2, d8, uid2);
  check_block(bodyBlocks[1], 2, 2 * BIG2, d5, uid1, d7, uid3);

  // - Delete to [1, 1], end-side
  ctx.deleteBody(d7, uid3);

  do_check_eq(bodyBlocks.length, 2);
  check_block(bodyBlocks[0], 1, 1 * BIG2, d8, uid2, d8, uid2);
  check_block(bodyBlocks[1], 1, 1 * BIG2, d5, uid1, d5, uid1);

  // - Put it back in!
  ctx.insertBody(d7, uid3, BIG2, 1);

  do_check_eq(bodyBlocks.length, 2);
  check_block(bodyBlocks[0], 1, 1 * BIG2, d8, uid2, d8, uid2);
  check_block(bodyBlocks[1], 2, 2 * BIG2, d5, uid1, d7, uid3);

  // - Delete to [1, 1], start-side
  ctx.deleteBody(d5, uid1);

  do_check_eq(bodyBlocks.length, 2);
  check_block(bodyBlocks[0], 1, 1 * BIG2, d8, uid2, d8, uid2);
  check_block(bodyBlocks[1], 1, 1 * BIG2, d7, uid3, d7, uid3);

  // - Delete the d8 block entirely
  ctx.deleteBody(d8, uid2);
  do_check_eq(bodyBlocks.length, 1);
  check_block(bodyBlocks[0], 1, 1 * BIG2, d7, uid3, d7, uid3);

  // - Delete the d7 block entirely
  ctx.deleteBody(d7, uid3);
  do_check_eq(bodyBlocks.length, 0);
});


/**
 * Check server id mapping maintenance for addition and deletion.  Splitting is
 * tested via the header block splitting test.
 */
TD.commonSimple('srvid mapping for add/del', function test_header_deletion() {
  // - add header and body.
  var ctx = makeTestContext(),
      d1 = DateUTC(2010, 0, 1),
      d2 = DateUTC(2010, 0, 2),
      d3 = DateUTC(2010, 0, 3),
      uid1 = 101, h1, b1,
      uid2 = 102, h2, b2,
      uid3 = 103, h3, b3;

  h1 = ctx.insertHeader(d1, uid1);
  b1 = ctx.insertBody(d1, uid1, BIG3, 0);
  h2 = ctx.insertHeader(d2, uid2);
  b2 = ctx.insertBody(d2, uid2, BIG3, 0);
  h3 = ctx.insertHeader(d3, uid3);
  b3 = ctx.insertBody(d3, uid3, BIG3, 0);

  // - make sure the server id's got in there
  ctx.checkServerIdMapForHeaders([h1, h2, h3], '0');

  // - delete h1
  ctx.storage.deleteMessageHeaderAndBody(h1);

  // - make sure the srvid is gone
  ctx.checkServerIdMapForHeaders([h1], null);
  ctx.checkServerIdMapForHeaders([h2, h3], '0');

  // - delete h2 via server id
  ctx.storage.deleteMessageByServerId(h2.srvid);

  // - make sure h2 got gone
  ctx.checkServerIdMapForHeaders([h1, h2], null);
  ctx.checkServerIdMapForHeaders([h3], '0');

  // - delete h3, blocks should now be nuked
  ctx.storage.deleteMessageHeaderAndBody(h3);

  // - make sure h3 getting gone was not affected by block nukage
  ctx.checkServerIdMapForHeaders([h1, h2, h3], null);
});

/**
 * Insertion point is outside existing blocks.  Check that we split, and where
 * there are multiple choices, that we pick according to our heuristic.
 */
TD.commonSimple('insertion outside existing blocks',
                function test_insertion_outside_use_nonoverflow_to_overflow() {
  var ctx = makeTestContext(),
      d5 = DateUTC(2010, 0, 5),
      d6 = DateUTC(2010, 0, 6),
      d7 = DateUTC(2010, 0, 7),
      d8 = DateUTC(2010, 0, 8),
      uid0 = 100,
      uid1 = 101,
      uid2 = 102,
      uid3 = 103,
      uid4 = 104,
      BS = 512,
      bodyBlocks = ctx.storage._bodyBlockInfos;

  // - Setup: two blocks, each with one BIG2 inside them.
  // note: different sequence from prior tests; this tests the outside case,
  // but without the decision between two blocks.
  ctx.insertBody(d5, uid1, BIG2, 0);
  ctx.insertBody(d7, uid3, BIG2, 0);
  ctx.insertBody(d8, uid2, BIG2, 0);
  do_check_eq(bodyBlocks.length, 2);
  check_block(bodyBlocks[0], 1, 1 * BIG2, d8, uid2, d8, uid2);
  check_block(bodyBlocks[1], 2, 2 * BIG2, d5, uid1, d7, uid3);

  ctx.deleteBody(d7, uid3);

  do_check_eq(bodyBlocks.length, 2);
  check_block(bodyBlocks[0], 1, 1 * BIG2, d8, uid2, d8, uid2);
  check_block(bodyBlocks[1], 1, 1 * BIG2, d5, uid1, d5, uid1);

  // - Insert d6, it picks the older one because it's not overflowing
  ctx.insertBody(d6, uid4, BIG2, 1);
  do_check_eq(bodyBlocks.length, 2);
  check_block(bodyBlocks[0], 1, 1 * BIG2, d8, uid2, d8, uid2);
  check_block(bodyBlocks[1], 2, 2 * BIG2, d5, uid1, d6, uid4);

  // - Insert d7, it picks the newer one because the older one is overflowing
  ctx.insertBody(d7, uid3, BIG2, 0);
  do_check_eq(bodyBlocks.length, 2);
  check_block(bodyBlocks[0], 2, 2 * BIG2, d7, uid3, d8, uid2);
  check_block(bodyBlocks[1], 2, 2 * BIG2, d5, uid1, d6, uid4);

  // - Insert another d7 with lower UID so it is 'outside', picks older
  ctx.insertBody(d7, uid0, BIG2, 1);
  do_check_eq(bodyBlocks.length, 3);
  check_block(bodyBlocks[0], 2, 2 * BIG2, d7, uid3, d8, uid2);
  check_block(bodyBlocks[1], 2, 2 * BIG2, d6, uid4, d7, uid0);
  check_block(bodyBlocks[2], 1, 1 * BIG2, d5, uid1, d5, uid1);
});

/**
 * Test that our range-logic does not break when faced with messages all from
 * the same timestamp and only differing in their UIDs.
 */
TD.commonSimple('insertion differing only by UIDs',
                function test_insertion_differing_only_by_uids() {
  var ctx = makeTestContext(),
      d5 = DateUTC(2010, 0, 5),
      uid1 = 101,
      uid2 = 102,
      uid3 = 103,
      uid4 = 104,
      uid5 = 105,
      uid6 = 106,
      bodyBlocks = ctx.storage._bodyBlockInfos;

  ctx.insertBody(d5, uid2, BIG3, 0);
  ctx.insertBody(d5, uid5, BIG3, 0);
  do_check_eq(bodyBlocks.length, 1);
  check_block(bodyBlocks[0], 2, 2 * BIG3, d5, uid2, d5, uid5);

  ctx.insertBody(d5, uid4, BIG3, 0);
  do_check_eq(bodyBlocks.length, 1);
  check_block(bodyBlocks[0], 3, 3 * BIG3, d5, uid2, d5, uid5);

  ctx.insertBody(d5, uid3, BIG3, 1);
  do_check_eq(bodyBlocks.length, 2);
  check_block(bodyBlocks[0], 2, 2 * BIG3, d5, uid4, d5, uid5);
  check_block(bodyBlocks[1], 2, 2 * BIG3, d5, uid2, d5, uid3);

  ctx.insertBody(d5, uid1, BIG3, 1);
  ctx.insertBody(d5, uid6, BIG3, 0);
  do_check_eq(bodyBlocks.length, 2);
  check_block(bodyBlocks[0], 3, 3 * BIG3, d5, uid4, d5, uid6);
  check_block(bodyBlocks[1], 3, 3 * BIG3, d5, uid1, d5, uid3);

  ctx.deleteBody(d5, uid4);
  ctx.deleteBody(d5, uid3);
  do_check_eq(bodyBlocks.length, 2);
  check_block(bodyBlocks[0], 2, 2 * BIG3, d5, uid5, d5, uid6);
  check_block(bodyBlocks[1], 2, 2 * BIG3, d5, uid1, d5, uid2);

  ctx.insertBody(d5, uid3, BIG3, 1);
  do_check_eq(bodyBlocks.length, 2);
  check_block(bodyBlocks[0], 2, 2 * BIG3, d5, uid5, d5, uid6);
  check_block(bodyBlocks[1], 3, 3 * BIG3, d5, uid1, d5, uid3);
});

// Expect, where 'first' is first reported, and 'last' is last reported,
// with no explicit time constraints.  For new-to-old, this means that
// firstDate >= lastDate.
function chexpect(firstDate, firstUID, lastDate, lastUID) {
  var seen = [];
  return function(headers, moreExpected) {
    console.log(
      "headers!", headers.length, ":",
      headers.map(function(x) { return "(" + x.date + ", " + x.id + ")"; }));

    // zero message case
    if (!headers.length) {
      if (moreExpected)
        return;
      do_check_eq(firstDate, null);
      do_check_eq(firstUID, null);
      do_check_eq(lastDate, null);
      do_check_eq(lastUID, null);
      return;
    }

    if (!seen.length) {
      do_check_eq(firstDate, headers[0].date);
      do_check_eq(firstUID, headers[0].id);
    }
    seen = seen.concat(headers);
    if (!moreExpected) {
      var last = seen.length - 1;
      do_check_eq(lastUID, seen[last].id);
      do_check_eq(lastDate, seen[last].date);
    }
  };
}

// The time ordering of the headers is always the same (most recent in
// a group at index 0, least recent at the last index) in a block, but
// this requires different logic than chexpect...
function rexpect(firstDate, firstUID, lastDate, lastUID) {
  var seen = [];
  return function(headers, moreExpected) {
    console.log(
      "headers!", headers.length, ":",
      headers.map(function(x) { return "(" + x.date + ", " + x.id + ")"; }));

    // zero message case
    if (!headers.length) {
      if (moreExpected)
        return;
      do_check_eq(firstDate, null);
      do_check_eq(firstUID, null);
      do_check_eq(lastDate, null);
      do_check_eq(lastUID, null);
      return;
    }

    if (!seen.length) {
      var last = headers.length - 1;
      do_check_eq(lastUID, headers[last].id);
      do_check_eq(lastDate, headers[last].date);
    }
    seen = headers.concat(seen);
    if (!moreExpected) {
      do_check_eq(firstDate, headers[0].date);
      do_check_eq(firstUID, headers[0].id);
    }
  };
}


/**
 * We have 3 header retrieval helper functions: getMessagesInImapDateRange
 * keys off IMAP-style date ranges, getMessagesBeforeMessage iterates over the
 * messages chronologically before a message (start-direction),
 * getMessagesAfterMessage iterates over the messages chronologically after a
 * message (end-direction).  We test all 3.
 */
TD.commonSimple('header iteration', function test_header_iteration() {
  var ctx = makeTestContext(),
      dA = DateUTC(2010, 0, 4),
      uidA1 = 101, uidA2 = 102, uidA3 = 103,
      dB = DateUTC(2010, 0, 5),
      uidB1 = 111, uidB2 = 112, uidB3 = 113,
      dC = DateUTC(2010, 0, 6),
      uidC1 = 121, uidC2 = 122, uidC3 = 123,
      dFuture = DateUTC(2011, 0, 1);

  ctx.insertHeader(dA, uidA1);
  ctx.insertHeader(dA, uidA2);
  ctx.insertHeader(dA, uidA3);
  ctx.insertHeader(dB, uidB1);
  ctx.insertHeader(dB, uidB2);
  ctx.insertHeader(dB, uidB3);

  // split to [B's, A's]
  var olderBlockInfo = ctx.storage._splitHeaderBlock(
    ctx.storage._headerBlockInfos[0], ctx.storage._headerBlocks[0],
    3 * $_syncbase.HEADER_EST_SIZE_IN_BYTES);
  ctx.storage._headerBlockInfos.push(olderBlockInfo);

  ctx.insertHeader(dC, uidC1);
  ctx.insertHeader(dC, uidC2);
  ctx.insertHeader(dC, uidC3);

  // split [C's and B's, A's] to [C's, B's, A's]
  olderBlockInfo = ctx.storage._splitHeaderBlock(
    ctx.storage._headerBlockInfos[0], ctx.storage._headerBlocks[0],
    3 * $_syncbase.HEADER_EST_SIZE_IN_BYTES);
  ctx.storage._headerBlockInfos.splice(1, 0, olderBlockInfo);

  console.log(JSON.stringify(ctx.storage._headerBlockInfos));

  // -- getMessagesInImapDateRange
  // Effectively unconstrained date range, no limit
  ctx.storage.getMessagesInImapDateRange(
    0, dFuture, null, null,
    chexpect(dC, uidC3, dA, uidA1));
  // Effectively unconstrained date range, limited
  ctx.storage.getMessagesInImapDateRange(
    0, dFuture, 4, 4,
    chexpect(dC, uidC3, dB, uidB3));

  // Constrained date ranges, no limit
  ctx.storage.getMessagesInImapDateRange(
    dB, dC, null, null,
    chexpect(dB, uidB3, dB, uidB1));
  ctx.storage.getMessagesInImapDateRange(
    dA, dC, null, null,
    chexpect(dB, uidB3, dA, uidA1));

  // Contrained date range bracketing, no limit
  ctx.storage.getMessagesInImapDateRange(
    dB - 1, dB + 1, null, null,
    chexpect(dB, uidB3, dB, uidB1));

  // Constrained date ranges, limited
  ctx.storage.getMessagesInImapDateRange(
    dA, dC, 1, 1,
    chexpect(dB, uidB3, dB, uidB3));
  ctx.storage.getMessagesInImapDateRange(
    dA, dC, 2, 2,
    chexpect(dB, uidB3, dB, uidB2));
  ctx.storage.getMessagesInImapDateRange(
    dA, dC, 3, 3,
    chexpect(dB, uidB3, dB, uidB1));
  ctx.storage.getMessagesInImapDateRange(
    dA, dC, 4, 4,
    chexpect(dB, uidB3, dA, uidA3));

  // -- getMessagesBeforeMessage
  // start from last message, no limit
  ctx.storage.getMessagesBeforeMessage(
    dC, uidC3, null,
    chexpect(dC, uidC2, dA, uidA1));
  // start from last message, limit avoids block crossing
  ctx.storage.getMessagesBeforeMessage(
    dC, uidC3, 2,
    chexpect(dC, uidC2, dC, uidC1));
  // start from last message, limit allows block crossing
  ctx.storage.getMessagesBeforeMessage(
    dC, uidC3, 5,
    chexpect(dC, uidC2, dB, uidB1));
  ctx.storage.getMessagesBeforeMessage(
    dC, uidC3, 6,
    chexpect(dC, uidC2, dA, uidA3));

  // start from last message using null/null lazy logic.
  ctx.storage.getMessagesBeforeMessage(
    null, null, null,
    chexpect(dC, uidC2, dA, uidA1));

  // start from non-last message, no limit
  ctx.storage.getMessagesBeforeMessage(
    dC, uidC2, null,
    chexpect(dC, uidC1, dA, uidA1));
  // start from non-last message, limit avoids block crossing
  ctx.storage.getMessagesBeforeMessage(
    dC, uidC2, 1,
    chexpect(dC, uidC1, dC, uidC1));
  // start from non-last message, limit allows block crossing
  ctx.storage.getMessagesBeforeMessage(
    dC, uidC2, 4,
    chexpect(dC, uidC1, dB, uidB1));
  ctx.storage.getMessagesBeforeMessage(
    dC, uidC2, 5,
    chexpect(dC, uidC1, dA, uidA3));
  ctx.storage.getMessagesBeforeMessage(
    dC, uidC1, 2,
    chexpect(dB, uidB3, dB, uidB2));


  // start from first message, nothing to find before
  ctx.storage.getMessagesBeforeMessage(
    dA, uidA1, null,
    chexpect(null, null, null, null));


  // -- getMessagesAfterMessage
  // start from first message, no limit
  ctx.storage.getMessagesAfterMessage(
    dA, uidA1, null,
    rexpect(dC, uidC3, dA, uidA2));
  // start from last message, limit avoids block crossing
  ctx.storage.getMessagesAfterMessage(
    dA, uidA1, 2,
    rexpect(dA, uidA3, dA, uidA2));
  // start from last message, limit allows block crossing
  ctx.storage.getMessagesAfterMessage(
    dA, uidA1, 5,
    rexpect(dB, uidB3, dA, uidA2));
  ctx.storage.getMessagesAfterMessage(
    dA, uidA1, 6,
    rexpect(dC, uidC1, dA, uidA2));

  // start from non-first message, no limit
  ctx.storage.getMessagesAfterMessage(
    dA, uidA2, null,
    rexpect(dC, uidC3, dA, uidA3));
  // start from non-first message, limit avoids block crossing
  ctx.storage.getMessagesAfterMessage(
    dA, uidA2, 1,
    rexpect(dA, uidA3, dA, uidA3));
  // start from non-first message, limit allows block crossing
  ctx.storage.getMessagesAfterMessage(
    dA, uidA2, 4,
    rexpect(dB, uidB3, dA, uidA3));
  ctx.storage.getMessagesAfterMessage(
    dA, uidA2, 5,
    rexpect(dC, uidC1, dA, uidA3));
  ctx.storage.getMessagesAfterMessage(
    dA, uidA3, 2,
    rexpect(dB, uidB2, dB, uidB1));


  // start from first message, nothing to find after
  ctx.storage.getMessagesAfterMessage(
    dC, uidC3, null,
    chexpect(null, null, null, null));
});

/**
 * Test that messages in the future are properly retrieved by the FolderStorage.
 */
TD.commonSimple('future headers', function test_future_headers() {
  var ctx = makeTestContext(),
      // Ensure that our message's date is in the future (without messing with
      // $date.NOW()).
      dA = Date.UTC(new Date().getFullYear() + 1, 0, 4),
      uidA1 = 101, uidA2 = 102, uidA3 = 103;

  ctx.insertHeader(dA, uidA1);
  ctx.insertHeader(dA, uidA2);
  ctx.insertHeader(dA, uidA3);

  // -- getMessagesInImapDateRange
  // Effectively unconstrained date range, no limit
  ctx.storage.getMessagesInImapDateRange(
    0, null, null, null,
    chexpect(dA, uidA3, dA, uidA1));
});

////////////////////////////////////////////////////////////////////////////////
// Discard blocks from in-memory cache

TD.commonSimple('block cache flushing', function() {
  var ctx = makeTestContext();

  // no blocks should be loaded before stuff starts
  do_check_eq(ctx.storage._loadedHeaderBlockInfos.length, 0);
  do_check_eq(ctx.storage._loadedBodyBlockInfos.length, 0);

  $_syncbase.TEST_adjustSyncValues({
    HEADER_EST_SIZE_IN_BYTES: BIG3,
  });
  var headers = injectSomeMessages(ctx, 9, BIG3);

  // check that we have the expected number of blocks and they are all dirty
  do_check_eq(ctx.storage._loadedHeaderBlockInfos.length, 4);
  do_check_eq(ctx.storage._loadedBodyBlockInfos.length, 4);
  do_check_true(ctx.storage._dirtyHeaderBlocks.hasOwnProperty('0'));
  do_check_true(ctx.storage._dirtyHeaderBlocks.hasOwnProperty('1'));
  do_check_true(ctx.storage._dirtyHeaderBlocks.hasOwnProperty('2'));
  do_check_true(ctx.storage._dirtyHeaderBlocks.hasOwnProperty('3'));
  do_check_true(ctx.storage._dirtyBodyBlocks.hasOwnProperty('0'));
  do_check_true(ctx.storage._dirtyBodyBlocks.hasOwnProperty('1'));
  do_check_true(ctx.storage._dirtyBodyBlocks.hasOwnProperty('2'));
  do_check_true(ctx.storage._dirtyBodyBlocks.hasOwnProperty('3'));

  // - flush and see nothing discarded because everything is dirty
  ctx.storage.flushExcessCachedBlocks();
  do_check_eq(ctx.storage._loadedHeaderBlockInfos.length, 4);
  do_check_eq(ctx.storage._loadedBodyBlockInfos.length, 4);

  // - clear the dirty bit of some stuff and see flushes happen
  // (use different blocks to expose dumb typo bugs)
  delete ctx.storage._dirtyHeaderBlocks['3'];
  delete ctx.storage._dirtyBodyBlocks['2'];
  ctx.storage.flushExcessCachedBlocks();
  do_check_eq(ctx.storage._loadedHeaderBlockInfos.length, 3);
  do_check_eq(ctx.storage._loadedBodyBlockInfos.length, 3);
  do_check_false(ctx.storage._headerBlocks.hasOwnProperty('3'));
  do_check_false(ctx.storage._bodyBlocks.hasOwnProperty('2'));

  // - clear all dirty bits, keep alive via mail slices
  delete ctx.storage._dirtyHeaderBlocks['0'];
  delete ctx.storage._dirtyHeaderBlocks['1'];
  delete ctx.storage._dirtyHeaderBlocks['2'];
  delete ctx.storage._dirtyBodyBlocks['0'];
  delete ctx.storage._dirtyBodyBlocks['1'];
  delete ctx.storage._dirtyBodyBlocks['3'];

  var startHeader = headers[4], endHeader = headers[0];
  ctx.storage._slices.push({
    startTS: startHeader.date, startUID: startHeader.id,
    endTS: endHeader.date, endUID: endHeader.id,
  });
  ctx.storage.flushExcessCachedBlocks();
  do_check_eq(ctx.storage._loadedHeaderBlockInfos.length, 2);
  do_check_eq(ctx.storage._loadedBodyBlockInfos.length, 2);
  do_check_false(ctx.storage._headerBlocks.hasOwnProperty('2'));
  do_check_false(ctx.storage._bodyBlocks.hasOwnProperty('3'));

  // clear slices, all blocks should be collected
  ctx.storage._slices.pop();
  ctx.storage.flushExcessCachedBlocks();
  do_check_eq(ctx.storage._loadedHeaderBlockInfos.length, 0);
  do_check_eq(ctx.storage._loadedBodyBlockInfos.length, 0);
  do_check_false(ctx.storage._headerBlocks.hasOwnProperty('0'));
  do_check_false(ctx.storage._headerBlocks.hasOwnProperty('1'));
  do_check_false(ctx.storage._bodyBlocks.hasOwnProperty('0'));
  do_check_false(ctx.storage._bodyBlocks.hasOwnProperty('1'));
});

////////////////////////////////////////////////////////////////////////////////
// Purge messages from disk

TD.commonCase('message purging', function test_message_purging(T, RT) {
  thunkConsole(T);

  var eCheck = T.lazyLogger('check');

  var testSitch = function testSitch(name, args) {
    T.action(eCheck, name, function() {
      var useNow = Date.UTC(2010, 0, args.count + 1).valueOf();
      $_date.TEST_LetsDoTheTimewarpAgain(useNow);
      $_syncbase.TEST_adjustSyncValues({
        HEADER_EST_SIZE_IN_BYTES: args.headerSize,
        BLOCK_PURGE_ONLY_AFTER_UNSYNCED_MS: 14 * $_date.DAY_MILLIS,
        BLOCK_PURGE_HARD_MAX_BLOCK_LIMIT: args.maxBlocks,
      });
      var ctx = makeTestContext();
      var headers =
            injectSomeMessages(ctx, args.count, args.bodySize);

      console.log('PRE: header block count:',
                  ctx.storage._headerBlockInfos.length);
      console.log('PRE: body block count:',
                  ctx.storage._bodyBlockInfos.length);

      var getOldestAccuracyStart = function () {
        var aranges = ctx.storage._accuracyRanges;
        if (!aranges.length)
          return null;
        return aranges[aranges.length - 1].startTS;
      };

      // (older range first)
      ctx.storage.markSyncRange(
        headers[headers.length - 1].date, // (oldest header)
        headers[args.accuracyRange0StartsOn].date, // (middle-age header)
        'abba', useNow - (args.accuracyAge1_days * $_date.DAY_MILLIS));
      ctx.storage.markSyncRange(
        headers[args.accuracyRange0StartsOn].date, // (middle-age header)
        // add an extra day because the end part of the range is exclusive...
        headers[0].date + $_date.DAY_MILLIS, // (youngest header)
        'abba', useNow - (args.accuracyAge0_days * $_date.DAY_MILLIS));

      ctx.account.accountDef.syncRange = args.syncRange;

      eCheck.expect_namedValue('messagesPurged', args.purged);

      if (args.purged) {
        var lastRemainingHeader = headers[args.count - args.purged - 1];
        eCheck.expect_namedValue('cutTS', lastRemainingHeader.date);
        eCheck.expect_namedValue('oldestAccuracyStart',
                                 lastRemainingHeader.date);
      }
      else {
        eCheck.expect_namedValue('cutTS', 0);
        eCheck.expect_namedValue('oldestAccuracyStart',
                                 getOldestAccuracyStart());
      }
      eCheck.expect_namedValue('arange count', args.aranges);

      // this should complete synchronously
      ctx.storage.purgeExcessMessages(function(numDeleted, cutTS) {
        eCheck.namedValue('messagesPurged', numDeleted);
        eCheck.namedValue('cutTS', cutTS);
        eCheck.namedValue('oldestAccuracyStart',
                          getOldestAccuracyStart());

        // dump the accuracy ranges for introspection for my sanity
        var aranges = ctx.storage._accuracyRanges;
        eCheck.namedValue('arange count', aranges.length);
        for (var i = 0; i < aranges.length; i++) {
          console.log('arange', i, '[', aranges[i].startTS,
                      aranges[i].endTS, ')');
        }
      });
    });
  };

  // Note that because of the quantization


  testSitch(
    'accuracy range protects all',
    {
      count: 14,
      headerSize: BIG5,
      bodySize: BIG3,

      // the sync range won't be protecting us here
      syncRange: '1d',
      accuracyAge0_days: 1,
      accuracyRange0StartsOn: 7,
      accuracyAge1_days: 2,
      // the block limit won't kick in
      maxBlocks: 100,

      purged: 0,
      aranges: 2,
    });

  testSitch(
    'accuracy range protects some',
    {
      count: 14,
      headerSize: BIG5,
      bodySize: BIG3,

      // the sync range won't be protecting us here
      syncRange: '1d',
      accuracyAge0_days: 1,
      accuracyRange0StartsOn: 7,
      // the accuracy range is more than 14 days old, so we will purge
      accuracyAge1_days: 20,
      // the block limit won't kick in
      maxBlocks: 100,

      purged: 7,
      aranges: 1,
    });

  testSitch(
    'sync range protects',
    {
      count: 14,
      headerSize: BIG5,
      bodySize: BIG3,

      // the sync range will protect 1 week's worth of messages
      syncRange: '1w',
      // both accuracy ranges are old, so won't be protected
      accuracyAge0_days: 19,
      accuracyRange0StartsOn: 4,
      accuracyAge1_days: 20,
      // the block limit won't kick in
      maxBlocks: 100,

      purged: 7,
      aranges: 2,
    });

  testSitch(
    'block range culls headers',
    {
      count: 15,
      // we will have 6 blocks of headers (we would have 5 fully filled, but our
      // split logic slightly biases)
      headerSize: BIG3,
      // and 4 blocks of bodies (we would have 3 fully filled, but biasing)
      bodySize: BIG5,

      // the sync range should be trying to protect everything
      syncRange: '1m',
      // the accuracy ranges should be trying to protect everything
      accuracyAge0_days: 1,
      accuracyRange0StartsOn: 7,
      accuracyAge1_days: 2,
      // the block limit will kick in
      maxBlocks: 3,

      purged: 5,
      aranges: 2
    });

  testSitch(
    'block range culls bodies',
    {
      count: 15,
      // we will have 4 blocks of headers
      headerSize: BIG5,
      // and 6 blocks of bodies
      bodySize: BIG3,

      // the sync range should be trying to protect everything
      syncRange: '1m',
      // the accuracy ranges should be trying to protect everything
      accuracyAge0_days: 1,
      accuracyRange0StartsOn: 7,
      accuracyAge1_days: 1,
      // the block limit will kick in
      maxBlocks: 3,

      purged: 5,
      aranges: 1
    });
});

////////////////////////////////////////////////////////////////////////////////

function run_test() {
  runMyTests(5);
}
