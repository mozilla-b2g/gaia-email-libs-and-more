/**
 * Test ImapFolderStorage's logic focusing on dealing with the impact of async
 * I/O, range edge-cases, block splitting and merging, and forgetting data as
 * needed.
 **/

load('resources/loggest_test_framework.js');

var TD = $tc.defineTestsFor(
  { id: 'test_folder_storage' }, null, [$th_imap.TESTHELPER], ['app']);

var $imapslice = require('rdimap/imapclient/imapslice');

function MockDB() {
}
MockDB.prototype = {
};

function MockAccount() {
}
MockAccount.prototype = {
};

/**
 * Create the ImapFolderStorage instance for a test run plus the required mocks.
 */
function makeTestContext() {
  var db = new MockDB(),
      account = new MockAccount();

  var folderId = 'A/1';
  var storage = new $imapslice.ImapFolderStorage(
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
        nextHeaderBlock: 0,
        nextBodyBlock: 0,
      },
      accuracy: [],
      headerBlocks: [],
      bodyBlocks: []
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
        attachments: null, bodyReps: null
      };
      storage._insertIntoBlockUsingDateAndUID(
        'body', date, uid, size, bodyInfo, function blockPicked(info, block) {
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
      return blockInfo;
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
        suid: folderId + '/' + uid,
        guid: uid,
      };
      storage.addMessageHeader(headerInfo);
    },
  };
}

function makeDummyHeaders(count) {
  var headers = [], uid = 100, date = DateUTC(2010, 0, 1);
  while (count--) {
    headers.push({
      id: uid,
      suid: 'H/1/' + uid++,
      author: null,
      date: date++,
      flags: null, hasAttachments: null, subject: null, snippet: null,
    });
  }
  headers.reverse();
  return headers;
}

////////////////////////////////////////////////////////////////////////////////
// Sync accuracy regions.
//
// NB: End dates are EXCLUSIVE.

/**
 * We were using Date.UTC, but it turns out those timestamps are hard to read,
 * so let's just encode things so that they make sense to us...
 */
function DateUTC(y, m, d) {
  return y * 10000 + m * 100 + d;
}

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

  run_next_test();
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

  run_next_test();
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

  run_next_test();
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

  run_next_test();
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

  run_next_test();
});

////////////////////////////////////////////////////////////////////////////////
// Header/body insertion/deletion into/out of blocks.
//
// UIDs are in the 100's to make equivalence failure types more obvious.

/**
 * Byte size so that 2 fit in a block, but 3 will not.
 */
const BIG2 = 36 * 1024;
/**
 * Byte size so that 3 fit in a block, but 4 will not.
 */
const BIG3 = 28 * 1024;

function check_block(blockInfo, count, size, startTS, startUID, endTS, endUID) {
  do_check_eq(blockInfo.count, count);
  do_check_eq(blockInfo.estSize, size);
  do_check_eq(blockInfo.startTS, startTS);
  do_check_eq(blockInfo.startUID, startUID);
  do_check_eq(blockInfo.endTS, endTS);
  do_check_eq(blockInfo.endUID, endUID);
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
  run_next_test();
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

  run_next_test();
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

  run_next_test();
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
      uid1 = 101,
      uid2 = 102,
      uid3 = 103,
      uid4 = 104,
      BS = 512,
      bodyBlocks = ctx.storage._bodyBlockInfos;

  ctx.insertBody(d5, uid1, BIG2, 0);
  ctx.insertBody(d8, uid2, BIG2, 0);
  check_block(bodyBlocks[0], 2, 2 * BIG2, d5, uid1, d8, uid2);

  ctx.checkDirtyBodyBlocks([0]);
  ctx.resetDirtyBlocks();

  // - Split prefers the older block
  ctx.insertBody(d7, uid3, BIG2, 1);

  do_check_eq(bodyBlocks.length, 2);
  check_block(bodyBlocks[0], 1, 1 * BIG2, d8, uid2, d8, uid2);
  check_block(bodyBlocks[1], 2, 2 * BIG2, d5, uid1, d7, uid3);

  ctx.checkDirtyBodyBlocks([0, 1]);
  ctx.resetDirtyBlocks();

  // - Split prefers the newer block
  // splits [1] into [1, 2]
  ctx.insertBody(d6, uid4, BIG2, 1);

  do_check_eq(bodyBlocks.length, 3);
  check_block(bodyBlocks[0], 1, 1 * BIG2, d8, uid2, d8, uid2);
  check_block(bodyBlocks[1], 2, 2 * BIG2, d6, uid4, d7, uid3);
  check_block(bodyBlocks[2], 1, 1 * BIG2, d5, uid1, d5, uid1);

  ctx.checkDirtyBodyBlocks([1, 2]);

  run_next_test();
});

/**
 * Test the header block splitting logic on its own.
 */
TD.commonSimple('header block splitting',
                function test_header_block_splitting() {
  var ctx = makeTestContext(),
      expectedHeadersPerBlock = 246, // Math.ceil(48 * 1024 / 200)
      numHeaders = 492,
      // returned header list has numerically decreasing time/uid
      bigHeaders = makeDummyHeaders(numHeaders),
      bigUids = bigHeaders.map(function (x) { return x.id; }),
      bigInfo = ctx.storage._makeHeaderBlock(
        bigHeaders[numHeaders-1].date, bigHeaders[numHeaders-1].id,
        bigHeaders[0].date, bigHeaders[0].id,
        numHeaders * 200, bigUids.concat(), bigHeaders.concat()),
      bigBlock = ctx.storage._headerBlocks[bigInfo.blockId];

  var olderInfo = ctx.storage._splitHeaderBlock(bigInfo, bigBlock, 48 * 1024),
      olderBlock = ctx.storage._headerBlocks[olderInfo.blockId],
      newerInfo = bigInfo, newerBlock = bigBlock;

  do_check_eq(newerInfo.count, expectedHeadersPerBlock);
  do_check_eq(olderInfo.count, numHeaders - expectedHeadersPerBlock);

  do_check_eq(newerInfo.estSize, newerInfo.count * 200);
  do_check_eq(olderInfo.estSize, olderInfo.count * 200);


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

  run_next_test();
});


/**
 * Test that deleting a header out of a block that does not empty the block
 * updates the values appropriately, then empty it and see it go away.
 */
TD.commonSimple('deletion', function test_deletion() {
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

  run_next_test();
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

  run_next_test();
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

  run_next_test();
});

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
    3 * $_imapslice.HEADER_EST_SIZE_IN_BYTES);
  ctx.storage._headerBlockInfos.push(olderBlockInfo);

  ctx.insertHeader(dC, uidC1);
  ctx.insertHeader(dC, uidC2);
  ctx.insertHeader(dC, uidC3);

  // split [C's and B's, A's] to [C's, B's, A's]
  olderBlockInfo = ctx.storage._splitHeaderBlock(
    ctx.storage._headerBlockInfos[0], ctx.storage._headerBlocks[0],
    3 * $_imapslice.HEADER_EST_SIZE_IN_BYTES);
  ctx.storage._headerBlockInfos.splice(1, 0, olderBlockInfo);

  console.log(JSON.stringify(ctx.storage._headerBlockInfos));

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

////////////////////////////////////////////////////////////////////////////////

function run_test() {
  runMyTests(3);
}
