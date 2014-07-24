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

define(['rdcommon/testcontext', './resources/th_main',
        'mailapi/date', 'mailapi/mailslice', 'mailapi/syncbase',
        'mailapi/slice_bridge_proxy', 'mailapi/headerCounter', 'exports'],
       function($tc, $th_main, $date, $mailslice, $syncbase,
                $sliceBridgeProxy, $headerCounter, exports) {

var TD = exports.TD = $tc.defineTestsFor(
  { id: 'test_folder_storage' }, null,
  [$th_main.TESTHELPER], ['app']);

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

function MockBridge() {
}
MockBridge.prototype = {
  __sendMesage: function() {
  },
};


var gLazyLogger = null;

// really poor shims now that we aren't in xpcshell; these should ideally
// be converted to use a lazy logger, probably in a hacky fashion.
function do_check_eq(expected, actual) {
  gLazyLogger.expect_value(expected);
  gLazyLogger.value(actual);
}
function do_check_neq(left, right) {
  gLazyLogger.expect_namedValueD('neq', left, right);
  gLazyLogger.namedValueD('neq', left, right);
  if (left == right)
    throw new Error(left + ' == ' + right);
}
var do_check_true = do_check_eq.bind(null, true);
var do_check_false = do_check_eq.bind(null, false);
function do_throw(msg) {
  throw new Error(msg);
}

/**
 * Create the FolderStorage instance for a test run plus the required mocks.
 */
function makeTestContext(account) {
  var db = new MockDB();

  // some tests interact with account features like the universe so generally we
  // are only testing FolderStorage but we also want to verify that
  // FolderStorage will interact correctly with the world.
  account = account || new MockAccount();

  var folderId = 'A/1';
  var storage = new $mailslice.FolderStorage(
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

    bodyFactory: function(date, size, overrides) {
      var body = {
        date: date,
        size: size,
        attachments: [],
        relatedParts: [],
        references: [],
        bodyReps: []
      };

      if (overrides) {
        for (var key in overrides) {
          body[key] = overrides[key];
        }
      }

      return body;
    },

    insertBody: function(date, uid, size, expectedBlockIndex) {
      var blockInfo = null;
      var bodyInfo = this.bodyFactory(date, size);
      storage._insertIntoBlockUsingDateAndUID(
        'body', date, uid, 'S' + uid, size, bodyInfo,
        function blockPicked(info, block) {
          // Make sure the insertion happens in the block location we were
          // expecting.
          do_check_eq(storage._bodyBlockInfos.indexOf(info),
                      expectedBlockIndex);
          blockInfo = info;

          // Make sure the insertion took.
          if (block.ids.indexOf(uid) === -1)
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
     * Create a new header; no expectations, this is just setup logic.
     */
    insertHeader: function(date, uid, flags) {
      var headerInfo = {
        date: date,
        id: uid,
        // have the server-id differ
        srvid: 'S' + uid,
        suid: folderId + '/' + uid,
        guid: uid,
        flags: flags
      };
      storage.addMessageHeader(headerInfo);
      return headerInfo;
    },

  };
}

/**
 * We were using Date.UTC, but it turns out those timestamps are hard to read,
 * so let's just encode things so that they make sense to us...
 */
function DateUTC(y, m, d) {
  return y * 100000 + m * 1000 + d * 10;
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
      date: DateUTC(2010, monthNum, dayNum++),
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

var EXPECTED_BLOCK_SIZE = 8;

/**
 * Byte size so that 2 fit in a block, but 3 will not.
 */
const BIG2 = (EXPECTED_BLOCK_SIZE / 2.6) * 1024;
/**
 * Byte size so that 3 fit in a block, but 4 will not.
 */
const BIG3 = Math.floor((EXPECTED_BLOCK_SIZE / 3.4) * 1024);
/**
 * Byte size so that 5 fit in a block, but 6 will not.
 */
const BIG5 = (EXPECTED_BLOCK_SIZE / 5) * 1024;

/**
 * Byte size that exceeds our target block size.
 */
const TOOBIG = Math.ceil(((EXPECTED_BLOCK_SIZE * 1.4) * 1024));


/**
 * Create messages distributed so that we have 5 headers per header block and
 * 3 bodies per body blocks.
 */
function injectSomeMessages(ctx, count, bodySize, flags) {
  var headers = makeDummyHeaders(count),
      BS = BIG3;

  // headers are ordered newest[0] to oldest[n-1]
  for (var i = 0; i < headers.length; i++) {
    var header = headers[i];
    header.flags = flags;
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

  $headerCounter.countHeaders(ctx.storage, function(header) {
    return header.flags &&
      header.flags.indexOf('\\Seen') === -1;
  }, function(result) {
    do_check_eq(result, 14);
  });


});

/**
 * Inject some messages into the folder storage, and then run the headercounter
 * script to determine the amount messages between dC and dFuture
 */
TD.commonSimple('count messages in time range', function test_range(eLazy) {
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

  $headerCounter.countHeaders(ctx.storage, function(header) {
    return header.date >= dC && header.date <= dFuture;
  }, function(result) {
    do_check_eq(result, 7);
  });


});

}); // end define
