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
    'mailapi/worker-support/net-main',
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
    // Should we increase the buffer by the amount sent?
    claimBuffered: false,
    bufferedAmount: 0,

    send: function(data, offset, length) {
      if (this.claimBuffered) {
        this.bufferedAmount += length;
        if (typeof(this.claimBuffered) === 'number') {
          this.claimBuffered--;
        }
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
      eSock.eventD('xhr released', { status: statusCode, datA: data });
      req.response = req.responseText = data;
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

  T.group('blob flow control');
  // XXX either do 0=>READ so 1 write, or move drain case.  steady state is
  // inductive state, so maybe wait for drain already.
  T.action(eSock, 'write blob, 2 reads, 1 write then wait for drain',
           function() {
    // 4 and a half blocks.
    var blobArr = makeU8Array16Multiples(1, 2, 3, 4, 5, 6, 7, 8, 9);
    var firstChunk = makeU8Array16Multiples(1, 2),
        secondChunk = makeU8Array16Multiples(3, 4);

    // The code always wants 1 chunk buffered; so we will see the read which we
    // will queue up so it immediately responds to the XHR, then we see the
    // immediate write.  We will then see a second XHR read which we will also
    // service, but there will be no write until we issue the drain.  And we
    // don't do that until the next step.
    expectXHR_fetch();
    expectXHR_release();
    eSock.expect_namedValue('write', [firstChunk, 0, firstChunk.length]);
    expectXHR_fetch();
    expectXHR_release();

    var blob = new Blob([blobArr]);

    // cause us to wait for the drain event to fire
    fakeSocket.bufferedAmount = READ_SIZE;
    // let the XHRs respond as they are issued (although still in a subsequent
    // turn of the event loop.
    releaseXHR(0, firstChunk);
    releaseXHR(0, secondChunk);
    netMain.process(sockUid, 'write', [blob]);
  });
  T.action(eSock, 'send drain, see write, see read', function() {
    var secondChunk = makeU8Array16Multiples(3, 4),
        thirdChunk = makeU8Array16Multiples(5, 6);

    // after we issue the release we expect to see the write immediately
    // followed by a fetch of the next chunk
    eSock.expect_namedValue('write', [secondChunk, 0, secondChunk.length]);
    fakeSocket.ondrain();
  });
  // we are supposed to send as soon as we get the load rather than waiting for
  // the
  T.action(eSock, 'already drained, send immediately', function() {
  });
  T.action(eSock, 'drain, write, done', function() {
    var thirdWrite = makeU8Array16Multiples(5);
    eSock.expect_namedValue('write', [thirdWrite, 0, thirdWrite.length]);
  });

  T.group('multiple blobs');

  // interleaved strings between blobs should still go in the right order
  T.group('blob and string interleaving');

  T.group('cleanup');
});

}); // end define
