define(
  [
    'module',
    'exports',
    './th_main',
    'mailslice',
    'syncbase',
    'slice_bridge_proxy'
  ],
  function(
    $module,
    exports,
    $th_main,
    $mailslice,
    $syncbase,
    $sliceBridgeProxy
  ) {


function MockDB() {
  this.fakeUnloadedBodyBlocks = {};
  this._pendingLoad = null;
}
MockDB.prototype = {
  loadBodyBlock: function(folderId, blockId, onLoaded) {
    this._pendingLoad = function() {
      onLoaded(this.fakeUnloadedBodyBlocks[blockId]);
    }.bind(this);
  },

  get hasPendingLoad() {
    return this._pendingLoad !== null;
  },

  releasePendingLoad: function() {
    var pendingLoad = this._pendingLoad;
    this._pendingLoad = null;
    pendingLoad();
  }
};

function MockAccount() {
}
MockAccount.prototype = {
  accountDef: {
    syncRange: 'auto',
  },
  scheduleMessagePurge: function() {
  },
};

function MockBridge() {
}
MockBridge.prototype = {
  __sendMesage: function() {
  },
};


function do_check_eq(expected, actual) {
  exports.gLazyLogger.expect('check_eq', expected);
  exports.gLazyLogger.log('check_eq', actual);
}
function do_check_neq(left, right) {
  if (left == right)
    throw new Error(left + ' == ' + right);
}
var do_check_true = do_check_eq.bind(null, true);
var do_check_false = do_check_eq.bind(null, false);
function do_throw(msg) {
  throw new Error(msg);
}

/**
 * Create a slice that won't actually ever do anything.  It's mainly suitable
 * for checking its state after causing things to happen to it.  For fancier
 * things you'll need to expand this or come up with something better.
 * Previously we got all of our slice coverage from higher-level synchronization
 * tests.
 */
exports.makeMockishSlice = function makeMockishSlice(storage) {
  var mockBridge = new MockBridge();
  var bridgeProxy = new $sliceBridgeProxy.SliceBridgeProxy(
                      mockBridge, 'fakeHeaders', 'fakeHandle');
  // Lie and say there's an update pending so it doesn't try and create any
  // timeouts.
  bridgeProxy.scheduledUpdate = true;
  // And let's never actually try and send anything.
  bridgeProxy.flushUpdates = function() {
  };

  var mailSlice = new $mailslice.MailSlice(bridgeProxy, storage);
  return mailSlice;
}

/**
 * Create the FolderStorage instance for a test run plus the required mocks.
 */
exports.makeTestContext = function makeTestContext(account) {
  $th_main.thunkConsoleForNonTestUniverse();
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
    headersInserted: 0,
    flushCount: 0,

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
      // snapshot the block info state prior to manipulation
      var preBlockStateString = JSON.stringify(storage._bodyBlockInfos);
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
      if (storage._imapDb.hasPendingLoad) {
        // Make sure that the block info state did not change yet!
        do_check_eq(JSON.stringify(storage._bodyBlockInfos),
                    preBlockStateString,
                    'insert with a load should not have changed the state');
        // inserts can only trigger one load at a time; so just this one release
        // is fine.
        storage._imapDb.releasePendingLoad();
      }
      return bodyInfo;
    },
    deleteBody: function(date, uid) {
      // snapshot the block info state prior to manipulation
      var preBlockStateString = JSON.stringify(storage._bodyBlockInfos);
      storage._deleteFromBlock('body', date, uid, function blockDeleted() {
      });
      if (storage._imapDb.hasPendingLoad) {
        // Make sure that the block info state did not change yet!
        do_check_eq(JSON.stringify(storage._bodyBlockInfos),
                    preBlockStateString,
                    'delete with a load should not have changed the state');
        storage._imapDb.releasePendingLoad();
      }
    },
    /**
     * Clear the list of dirty body blocks and transfer the blocks to be in a
     * mock unloaded state.
     */
    resetDirtyBlocks: function() {
      var fakeUnloadedBodyBlocks = storage._imapDb.fakeUnloadedBodyBlocks;
      var dirtyBlocks = storage._dirtyBodyBlocks;
      for (var blockId in dirtyBlocks) {
        var blockValue = dirtyBlocks[blockId];
        // Actually delete from the map so we get undefined and are otherwise
        // consistent with how the DB would handle this, etc.
        if (blockValue === null) {
          delete fakeUnloadedBodyBlocks[blockId];
        } else {
          fakeUnloadedBodyBlocks[blockId] = blockValue;
        }
        delete storage._bodyBlocks[blockId];
        var idx = storage._loadedBodyBlockInfos.findIndex(function(bi) {
          return bi.blockId === blockId;
        });
        storage._loadedBodyBlockInfos.splice(idx, 1);
      }
      storage._dirtyBodyBlocks = {};
    },
    /**
     * Assert that all of the given body blocks are marked dirty and that the
     * given blocks were marked as nuked.
     *
     * @param {Number[]} [bodyIndices]
     *   The *INDICES* of the blocks in their ordered list that we expect to
     *   be dirty.  This is different and has nothing to do with the block id!
     * @param {BlockInfo[]} [nukedInfos]
     *   The BlockInfos of nuked blocks.
     */
    checkDirtyBodyBlocks: function(bodyIndices, nukedInfos) {
      var i, blockInfo;
      var actualDirtyBlockIndices = [], actualNukedBlocks = [];

      if (bodyIndices == null)
        bodyIndices = [];
      if (nukedInfos == null)
        nukedInfos = [];

      // note: it's absolutely required that we snapshot the contents of the
      // list even if we weren't trying to do sorting things/etc.
      var sortedExpectedDirty = bodyIndices.concat();
      sortedExpectedDirty.sort();
      var sortedExpectedNuked = nukedInfos.map(
                                  function(x) { return x.blockId; });
      sortedExpectedNuked.sort();
      exports.gLazyLogger.expect(
        'dirtyBlockIndices', sortedExpectedDirty);
      exports.gLazyLogger.expect(
        'nukedBlockIds', sortedExpectedNuked);

      for (var key in storage._dirtyBodyBlocks) {
        var dirtyBlock = storage._dirtyBodyBlocks[key];
        if (dirtyBlock === null) {
          actualNukedBlocks.push(key);
          if (storage._bodyBlocks.hasOwnProperty(key)) {
            exports.gLazyLogger.error(
              'nuked block should no longer be present');
          }
        } else {
          // that dirty Block had better be the same reference as in our
          // canonical dictionary too!
          if (dirtyBlock !== storage._bodyBlocks[key]) {
            exports.gLazyLogger.error('dirty block identity mismatch!');
          }
          var dirtyBlockIndex = storage._bodyBlockInfos.findIndex(function(x) {
            return x.blockId === key;
          });
          actualDirtyBlockIndices.push(dirtyBlockIndex);
        }
      }
      actualDirtyBlockIndices.sort();
      actualNukedBlocks.sort();

      exports.gLazyLogger.log(
        'dirtyBlockIndices', actualDirtyBlockIndices);
      exports.gLazyLogger.log(
        'nukedBlockIds', actualNukedBlocks);
    },

    checkBodyBlockContents: function(bodyIndex, ids, bodies) {
      var blockInfo = storage._bodyBlockInfos[bodyIndex];
      var bodyBlock = storage._bodyBlocks[blockInfo.blockId];
      // Because of our hack where we fake write-outs/discarding, we need to
      // check the written-to-disk store when the current state isn't covered
      // by the body map or the dirty state map (which includes deletions)
      var blockId = blockInfo.blockId;
      if (!storage._bodyBlocks.hasOwnProperty(blockId) &&
          !storage._dirtyBodyBlocks.hasOwnProperty(blockId) &&
          storage._imapDb.fakeUnloadedBodyBlocks.hasOwnProperty(blockId)) {
        bodyBlock = storage._imapDb.fakeUnloadedBodyBlocks[blockId];
      }
      do_check_neq(bodyBlock, undefined);
      do_check_eq(ids.length, bodyBlock.ids.length);
      for (var i = 0; i < ids.length; i++){
        do_check_eq(ids[i], bodyBlock.ids[i]);
        do_check_eq(bodies[i], bodyBlock.bodies[ids[i]]);
      }
      for (var key in bodyBlock.bodies) {
        if (ids.indexOf(parseInt(key, 10)) === -1) {
          do_throw('Body block contains body it should not: ' + key);
        }
      };
    },

    /**
     * Create a new header; no expectations, this is just setup logic.
     */
    insertHeader: function(date, uid, flags) {
      this.headersInserted++;
      var headerInfo = {
        date: date,
        id: uid,
        // have the server-id differ
        srvid: 'S' + uid,
        suid: folderId + '/' + uid,
        guid: uid,
        flags: flags,
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
                     checkStart, checkEnd, $syncbase.OPEN_REFRESH_THRESH_MS);
      do_check_eq(expectedStart, result && result.startTS);
      do_check_eq(expectedEnd, result && result.endTS);
    },

    /**
     * Create a slice defined by the given headers and force it into the _slices
     * array to bypass all the affiliated synchronization logic.
     */
    makeSliceBoundByHeaders: function(endHeader, startHeader, headersInSlice,
                                      opts) {
      var slice = exports.makeMockishSlice(storage);
      if (endHeader && startHeader) {
        slice.endTS = endHeader.date;
        slice.endUID = endHeader.id;
        slice.startTS = startHeader.date;
        slice.startUID = startHeader.id;
      }
      slice.headers = headersInSlice;
      slice.desiredHeaders = slice.headers.length;
      if (opts && ('ignoreHeaders' in opts)) {
        slice.ignoreHeaders = opts.ignoreHeaders;
      }
      storage._slices.push(slice);
      return slice;
    },
  };
}

exports.makeDummyHeaders = function makeDummyHeaders(count, flags) {
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
      flags: flags, hasAttachments: null, subject: null, snippet: null,
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
const BIG2 = exports.BIG2 = (EXPECTED_BLOCK_SIZE / 2.6) * 1024;
/**
 * Byte size so that 3 fit in a block, but 4 will not.
 */
const BIG3 = exports.BIG3 = Math.floor((EXPECTED_BLOCK_SIZE / 3.4) * 1024);
/**
 * Byte size so that 5 fit in a block, but 6 will not.
 */
const BIG5 = exports.BIG5 = (EXPECTED_BLOCK_SIZE / 5) * 1024;

/**
 * Byte size that exceeds our target block size.
 */
const TOOBIG = exports.TOOBIG = Math.ceil(((EXPECTED_BLOCK_SIZE * 1.4) * 1024));


/**
 * Create messages distributed so that we have 5 headers per header block and
 * 3 bodies per body blocks.
 */
exports.injectSomeMessages =
  function injectSomeMessages(ctx, count, bodySize, flags) {
  var headers = exports.makeDummyHeaders(count, flags),
      BS = BIG3;

  // headers are ordered newest[0] to oldest[n-1]
  for (var i = 0; i < headers.length; i++) {
    var header = headers[i];
    ctx.headersInserted++;
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
 * We were using Date.UTC, but it turns out those timestamps are hard to read,
 * so let's just encode things so that they make sense to us...
 */
exports.DateUTC = function DateUTC(y, m, d) {
  return y * 100000 + m * 1000 + d * 10;
}



});
