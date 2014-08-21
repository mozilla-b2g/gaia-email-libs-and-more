/**
 * Test headerCounter.js' ability to count all the headers
 * within a particular folderStorage object which satisfy
 * a certain filter function. This is derived from
 * test_folder_storage.js
 **/

define(['rdcommon/testcontext', './resources/th_main',
        './resources/folder_storage_shared',
        'date', 'mailslice', 'syncbase',
        'slice_bridge_proxy', 'headerCounter', 'exports'],
       function($tc, $th_main, $shared, $date, $mailslice, $syncbase,
                $sliceBridgeProxy, $headerCounter, exports) {

var TD = exports.TD = $tc.defineTestsFor(
  { id: 'test_folder_storage' }, null,
  [$th_main.TESTHELPER], ['app']);

var makeTestContext = $shared.makeTestContext;
var makeMockishSlice = $shared.makeMockishSlice;
var makeDummyHeaders = $shared.makeDummyHeaders;
var injectSomeMessages = $shared.injectSomeMessages;
var DateUTC = $shared.DateUTC;
const BIG2 = $shared.BIG2;
const BIG3 = $shared.BIG3;
const BIG5 = $shared.BIG5;
const TOOBIG = $shared.TOOBIG;


/**
 * Inject some messages into the folder storage, and then run the headercounter
 * script to determine the amount of unread messages
 */
TD.commonSimple('counting unread messages', function test_unread(eLazy) {
  gLazyLogger = eLazy;
  var ctx = makeTestContext(),
      dA = DateUTC(2010, 0, 4),
      uidA1 = 101, uidA2 = 102, uidA3 = 103,
      dB = DateUTC(2010, 0, 5),
      uidB1 = 111, uidB2 = 112, uidB3 = 113,
      dC = DateUTC(2010, 0, 6),
      uidC1 = 121, uidC2 = 122, uidC3 = 123,
      dFuture = DateUTC(2011, 0, 1);

  ctx.insertHeader(dA, uidA1, ['\\Seen']);
  ctx.insertHeader(dA, uidA2, []);
  ctx.insertHeader(dA, uidA3, ['\\Seen']);
  ctx.insertHeader(dB, uidB1, []);
  ctx.insertHeader(dB, uidB2, []);
  ctx.insertHeader(dB, uidB3, ['\\Seen']);
  ctx.insertHeader(dC, uidC1, []);
  ctx.insertHeader(dC, uidC2, []);
  ctx.insertHeader(dC, uidC3, ['\\Seen']);

  injectSomeMessages(ctx, 9, BIG3, []);

  gLazyLogger.expect_namedValue('Headers Inserted', 18);
  gLazyLogger.namedValue('Headers Inserted', ctx.headersInserted);

  var flushCount = 0;
  ctx.storage.flushExcessCachedBlocks = function() { flushCount++; };

  // Default batching constant
  gLazyLogger.expect_namedValue('Number of Flushes', 0);
  gLazyLogger.expect_namedValue('Default batch size', 14);
  $headerCounter.countHeaders(ctx.storage, function(header) {
    return header.flags &&
      header.flags.indexOf('\\Seen') === -1;
  }, function(result) {
    gLazyLogger.namedValue('Number of Flushes', flushCount);
    gLazyLogger.namedValue('Default batch size', result);
  });

  var flushCount2 = 0;
  ctx.storage.flushExcessCachedBlocks = function() { flushCount2++; };

  gLazyLogger.expect_namedValue('Number of Flushes', 5);
  gLazyLogger.expect_namedValue('Batch Size 3', 14);
  $headerCounter.countHeaders(ctx.storage, function(header) {
    return header.flags &&
      header.flags.indexOf('\\Seen') === -1;
  }, { fetchSize: 3 }, function(result) {
    gLazyLogger.namedValue('Number of Flushes', flushCount2);
    gLazyLogger.namedValue('Batch Size 3', result);
  });


});

}); // end define
