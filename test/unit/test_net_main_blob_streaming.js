/**
 * Test the blob-streaming logic in net-main, primarily verifying that the flow
 * control mechanism works.  We minimally fake all globals required by the code.
 * Note that we run on a worker thread and so many of the globals are simply not
 * available in the first place.
 **/

define(
  [
    'rdcommon/testcontext',
    './resources/th_main',
    './resources/fake_xhr',
    'worker-support/net-main',
    'exports'
  ],
  function(
    $tc,
    $th_main,
    fakeXHR,
    netMain,
    exports
  ) {

var TD = exports.TD = $tc.defineTestsFor(
  { id: 'test_net_main_blob_streaing' }, null,
  [$th_main.TESTHELPER], ['app']);

TD.commonCase('blob flow control', function(T, RT) {
  $th_main.thunkConsoleForNonTestUniverse();
  T.group('setup');
  var eSock = T.lazyLogger('sock');
  var eMessage = T.lazyLogger('message');

  // 32k would be wasteful to log.  Also, who cares.
  var READ_SIZE = netMain.BLOB_BLOCK_READ_SIZE = 32;

  // (1) => [1 * 16], (1, 2) => [1 * 16, 2 * 16]
  function makeU8Array16Multiples() {
    var arr = new Uint8Array(arguments.length * 16);
    for (var i = 0; i < arguments.length; i++) {
      var val = arguments[i];
      for (var j = i*16; j < (i+1)*16; j++) {
        arr[j] = val;
      }
    }
    return arr;
  }

  var fakeSocket = {
    setBufferedAmountAfterNSendCalls: 0,
    bufferedAmount: 0,

    send: function(data, offset, length) {
      if (this.setBufferedAmountAfterNSendCalls) {
        if (--this.setBufferedAmountAfterNSendCalls === 0) {
          this.bufferedAmount = READ_SIZE;
        }
      }
      if (data instanceof ArrayBuffer) {
        // for expectation purposes this needs to be a Uint8Array
        data = new Uint8Array(data);
      }
      eSock.namedValue('write', [data, offset, length]);
    },

    close: function() {
      eSock.event('close');
    },

    doDrain: function() {
      eSock.event('drain');
    },
  };
  navigator.mozTCPSocket = {
    open: function() {
      return fakeSocket;
    }
  };


  var pendingReqs = [], pendingReleases = [];
  window.gFakeXHRListener = function(req, args) {
    eSock.eventD('xhr fetch issued', args);
    pendingReqs.push(req);
    if (pendingReleases.length) {
      var releaseData = pendingReleases.shift();
      releaseXHR(releaseData[0], releaseData[1]);
    }
  };
  function expectXHR_fetch() {
    eSock.expect_eventD('xhr fetch issued');
  }
  function expectXHR_release() {
    eSock.expect_eventD('xhr released');
  }
  function releaseXHR(statusCode, data) {
    if (!pendingReqs.length) {
      pendingReleases.push([statusCode, data]);
      return;
    }

    var req = pendingReqs.shift();
    window.setZeroTimeout(function() {
      eSock.eventD('xhr released', { status: statusCode, data: data });
      // XHR for 'arraybuffer' returns an ArrayBuffer, not an ArrayBufferView,
      // but we are throwing around Uint8Arrays in this test code.
      req.response = req.responseText = data.buffer;
      req.status = statusCode;
      req.onload();
    });
  }

  var sockUid = 'elsock';
  T.action('open fake socket', function() {
    netMain.sendMessage = function(uid, name, args, transferrable) {
      eMessage.namedValue(name, args);
    };

    netMain.process(sockUid, 'open', 'hostname', 'port', {});
  });

  // Writes should go directly through.
  T.action(eSock, 'sanity check u8 write', function() {
    var arr = makeU8Array16Multiples(1);
    eSock.expect_namedValue('write', [arr, 0, arr.length]);
    netMain.process(sockUid, 'write', [arr, 0, arr.length]);
  });

  /*
   * Make sure that we only perform reads so that we always have a single chunk
   * buffered ready for the next drain notification.
   */
  T.group('blob flow control');
  T.action(eSock, 'write blob, 1 read, buffer already full, wait for drain',
           function() {
    // 3 and a half blocks.
    var blobArr = makeU8Array16Multiples(1, 2, 3, 4, 5, 6, 7);
    var firstChunk = makeU8Array16Multiples(1, 2);

    // cause us to wait for the drain event to fire
    fakeSocket.bufferedAmount = READ_SIZE;

    // expect 1 read which we'll resolve immediately
    expectXHR_fetch();
    expectXHR_release();

    var blob = new Blob([blobArr]);

    // let the XHRs respond as they are issued (although still in a subsequent
    // turn of the event loop.
    releaseXHR(0, firstChunk);
    netMain.process(sockUid, 'write', [blob]);
  });
  T.action(eSock, 'send drain, see write, see read', function() {
    var firstChunk = makeU8Array16Multiples(1, 2);
    var secondChunk = makeU8Array16Multiples(3, 4);

    // There will be a write followed by a new fetch after the drain; we leave
    // the buffer claiming to be full so we don't issue a new write.
    fakeSocket.bufferedAmount = READ_SIZE;
    // the write triggered by the drain
    eSock.expect_namedValue('write', [firstChunk, 0, firstChunk.length]);
    // the read triggered by the write
    expectXHR_fetch();
    expectXHR_release();


    releaseXHR(0, secondChunk);
    fakeSocket.ondrain();
  });
  T.action(eSock, 'ondrain, write, stay drained, read sends immediately',
           'next read blocks', function() {
    var secondChunk = makeU8Array16Multiples(3, 4);
    var thirdChunk = makeU8Array16Multiples(5, 6);
    var lastChunk = makeU8Array16Multiples(7);

    // the write triggered by the drain
    eSock.expect_namedValue('write', [secondChunk, 0, secondChunk.length]);
    // the read triggered by that write
    expectXHR_fetch();
    expectXHR_release();
    // and we issue the write immediately because bufferedAmount === 0
    eSock.expect_namedValue('write', [thirdChunk, 0, thirdChunk.length]);
    // which results in another read...
    expectXHR_fetch();
    expectXHR_release();


    fakeSocket.bufferedAmount = 0;
    fakeSocket.setBufferedAmountAfterNSendCalls = 2;
    releaseXHR(0, thirdChunk);
    releaseXHR(0, lastChunk);
    fakeSocket.ondrain();
  });
  T.action(eSock, 'drain, write/done', function() {
    var lastChunk = makeU8Array16Multiples(7);
    eSock.expect_namedValue('write', [lastChunk, 0, lastChunk.length]);
    fakeSocket.ondrain();
  });

  /*
   * Ensure that if we issue a call to issue multiple Blob writes in succession
   * that we don't screw up the ordering.
   */
  T.group('multiple blobs');
  T.action(eSock, 'issue 2 blob writes, have buffering prevent all writes.',
           function() {
    var arr1 = makeU8Array16Multiples(10, 11, 12);
    var arr2 = makeU8Array16Multiples(13, 14);

    var blob1 = new Blob([arr1]);
    var blob2 = new Blob([arr2]);

    var b1Chunk1 = makeU8Array16Multiples(10, 11);

    expectXHR_fetch();
    expectXHR_release();

    fakeSocket.bufferedAmount = READ_SIZE;
    releaseXHR(0, b1Chunk1);
    netMain.process(sockUid, 'write', [blob1]);
    netMain.process(sockUid, 'write', [blob2]);
  });
  T.action(eSock, 'hide buffering, issue drain, see all writes', function() {
    var b1Chunk1 = makeU8Array16Multiples(10, 11);
    var b1Chunk2 = makeU8Array16Multiples(12);
    var b2Chunk1 = makeU8Array16Multiples(13, 14);

    // drain results in write
    eSock.expect_namedValue('write', [b1Chunk1, 0, b1Chunk1.length]);
    // write triggers read
    expectXHR_fetch();
    expectXHR_release();
    // read becomes write immediatele
    eSock.expect_namedValue('write', [b1Chunk2, 0, b1Chunk2.length]);
    // read next blob
    expectXHR_fetch();
    expectXHR_release();
    eSock.expect_namedValue('write', [b2Chunk1, 0, b2Chunk1.length]);

    fakeSocket.bufferedAmount = 0;
    releaseXHR(0, b1Chunk2);
    releaseXHR(0, b2Chunk1);
    fakeSocket.ondrain();
  });

  /*
   * Interleaved strings between blobs should still go in the right order.
   * Specifically, if we have a Blob in the queue that's not fully sent yet,
   * then the u8 array write array shouldn't happen prematurely.
   */
  T.group('blob and string interleaving');
  T.action(eSock, 'enqueue blob and u8arr', function() {
    var blobArr = makeU8Array16Multiples(20, 21);
    var u8arr = makeU8Array16Multiples(30, 31, 32);

    var blob = new Blob([blobArr]);

    expectXHR_fetch();
    expectXHR_release();

    fakeSocket.bufferedAmount = READ_SIZE;
    releaseXHR(0, blobArr);
    netMain.process(sockUid, 'write', [blob]);
    netMain.process(sockUid, 'write', [u8arr, 0, u8arr.length]);
  });
  T.action(eSock, 'issue drain, leave buffering on, see all writes',
           function() {
    var blobArr = makeU8Array16Multiples(20, 21);
    var u8arr = makeU8Array16Multiples(30, 31, 32);

    eSock.expect_namedValue('write', [blobArr, 0, blobArr.length]);
    eSock.expect_namedValue('write', [u8arr, 0, u8arr.length]);

    // We leave buffering on because only blob streaming cares about buffering;
    // the typed array is inherently already fully in memory, so there is
    // not a lot saved by slicing it, etc.
    fakeSocket.ondrain();
  });

  T.group('cleanup');
});

}); // end define
