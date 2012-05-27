/**
 * Test ImapFolderStorage's logic focusing on dealing with the impact of async
 * I/O, range edge-cases, block splitting and merging, and forgetting data as
 * needed.
 **/

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

  var storage = new $imapslice.ImapFolderStorage(
    account, 'A-1',
    {
      $meta: {
        id: 'A-1',
        name: 'Inbox',
        path: 'Inbox',
        type: 'inbox'
      },
      $impl: {
        nextHeaderBlock: 0,
        nextBodyBlock: 0,
      },
      accuracy: [],
      headBlocks: [],
      bodyBlocks: []
    },
    db,
    null);
  return {
    account: account,
    db: db,
    storage: storage
  };
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
add_test(function test_accuracy_base_case() {
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
add_test(function test_accuracy_nonoverlap() {
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
add_test(function test_accuracy_contains() {
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
add_test(function test_accuracy_overlap() {
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
add_test(function test_accuracy_merge() {
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
// _pickInsertionBlockUsingDateAndUID
//
// Tests the core routine that picks the block to put headers/bodies into, and
// appropriately split them.

/**
 * Base case: there are no blocks yet!
 */
add_test(function test_insertion_no_existing_blocks() {

  run_next_test();
});
/**
 *
 */
add_test(function test_insertion_() {

  run_next_test();
});
/**
 * Insertion point is in an existing block and will not overflow, use it.
 */
add_test(function test_insertion_in_block_use() {

  run_next_test();
});
/**
 * Insertion point is in an existing block and will overflow, split it.
 */
add_test(function test_insertion_in_block_overflow_split() {

  run_next_test();
});
/**
 * Insertion point is outside existing blocks, pick non-overflowing older block
 * which will then become "full", and cause us to fall back to the newer block
 * for the next insertion.
 */
add_test(function test_insertion_outside_use_nonoverflow() {

  run_next_test();
});
/**
 * Insertion point is outside existing blocks, adjacent blocks are overflowing;
 * pick the right block to split (based on position).
 */
add_test(function test_insertion_outside_split_overflow() {

  run_next_test();
});

////////////////////////////////////////////////////////////////////////////////

function run_test() {
  run_next_test();
  do_timeout(3 * 1000, function() { do_throw('Too slow!'); });
}
