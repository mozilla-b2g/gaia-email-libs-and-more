define(function(require) {

var LegacyGelamTest = require('./resources/legacy_gelamtest');

/**
 * This case is to verify the ordering and content of the initial sync messages.
 * This does _not_ cover database persistence (which is handled in other test
 * cases).
 */
return new LegacyGelamTest('sync headers then download body', function(T, RT) {
  var testUniverse = T.actor('TestUniverse', 'U', { realDate: true }),
      testAccount = T.actor('TestAccount', 'A',
                            { universe: testUniverse,
                              realAccountNeeded: true });

  var eLazy = T.lazyLogger('misc');
  var bodyLog = T.lazyLogger('body logs');

  var folderName = 'test_header_sync_only';
  var messageCount = 2;

  var testFolder = testAccount.do_createTestFolder(
    folderName,
    { count: messageCount, age: { days: 1 } }
  );

  /**
   * We use a customized openSlice method to test the interactions prior to the
   * slice firing its .oncomplete event. The idea is to test if & when the
   * events are fired.
   */
  function openSlice() {
    testAccount._expect_storage_mutexed(testFolder, 'sync', {
      syncedToDawnOfTime: 'ignore'
    });

    // allocate a connection
    testAccount._unusedConnections--;

    return self.MailAPI.viewFolderMessages(
      testFolder.mailFolder
    );
  }

  /**
   * Small counterpart to closeSlice to verify the slice is not already dead,
   * etc..
   */
  function closeSlice() {
    var closeActor = T.lazyLogger('slice closer');
    T.action('close slice', closeActor, function() {
      closeActor.expect('slice died');
      slice.ondead = function() {
        testAccount._unusedConnections++;
        closeActor.log('slice died');
      };

      slice.die();
    });
  }

  // reused across many actions
  var slice;

  T.action('initial sync', eLazy, bodyLog, function() {
    slice = openSlice();

    // expect the additions
    testFolder.serverMessages.forEach(function(msg) {
      var guid = msg.messageId;

      eLazy.expect(
        'add header', { guid: guid, snippet: null
       });

      bodyLog.expect('body', {
        guid: guid,
        bodyReps: [{
          hasSize: true,
          type: msg.bodyPart._contentType === 'text/html' ? 'html' : 'plain',
          part: '1',
          amountDownloaded: 0,
          isDownloaded: false
        }]
      });
    });

    eLazy.expect('sync complete');

    slice.onadd = function(added) {
      var guid = added.guid;

      eLazy.log('add header', {
        guid: guid,
        snippet: added.snippet
      });

      added.getBody(function(bodyInfo) {
        var rep = bodyInfo.bodyReps[0];
        bodyLog.log('body', {
          guid: guid,
          // in the test environment we know what to expect.
          bodyReps: [{
            hasSize: !!rep.sizeEstimate,
            type: rep.type,
            part: String(rep.part),
            amountDownloaded: rep.amountDownloaded,
            isDownloaded: false
          }]
        });
      });
    };

    slice.oncomplete = function() {
      eLazy.log('sync complete');
    };
  });

  var eAsync = T.lazyLogger();

  T.action(testAccount, 'fetch body after sync', eLazy, function() {
    var header = slice.items[0];
    // headers are now available
    eLazy.expect('sends body',  header.id);
    testAccount.expect_runOp(
      'downloadBodyReps',
      { local: false, server: true, save:'server' });
    eAsync.expect('asyncReady');

    header.getBody({ downloadBodyReps: true }, function(body) {
      eLazy.expect('update bodyRep', {
        id: header.id,
        content: testFolder.serverMessageContent(header.guid),
        isDownloaded: true,
        indexesChanged: [0], // first body rep
        updatesAll: true,
        amountGreaterEqToEstimate: true
      });
      eAsync.log('asyncReady');

      eLazy.log('sends body', header.id);

      // the theory is onchange the contents change based on the new wireRep
      // data but we also want some idea of what changed so we don't blow up
      // everything
      body.onchange = function(details) {
        if (details.changeDetails.bodyReps) {
          var bodyRep = body.bodyReps[details.changeDetails.bodyReps[0]];
          // details should be the index and new representation

          eLazy.log('update bodyRep', {
            id: header.id,
            indexesChanged: details.changeDetails.bodyReps,
            content: bodyRep.content,
            isDownloaded: bodyRep.isDownloaded,
            updatesAll: body.bodyReps.length ===
              details.changeDetails.bodyReps.length,
            amountGreaterEqToEstimate:
              bodyRep.amountDownloaded >= bodyRep.sizeEstimate
          });
        }
      };
    });
  });


  T.action(testAccount, 'partial fetching of body reps', eLazy, function() {
    var header = slice.items[1];
    var body;
    var content = testFolder.serverMessageContent(header.guid);

    // ASCII 4 bytes assumed
    var snippet = content[1].slice(0, 4);

    // With batching, this order has to come first
    eLazy.expect('body', {
      isDownloaded: false,
      amountDownloaded: 4
    });
    eLazy.expect('snippet',  snippet);

    eLazy.expect('body full', {
      isDownloaded: true,
      content: content
    });

    // body without bodyReps
    header.getBody(function(_body) {
      body = _body;

      // initiate the request for partial content
      slice.maybeRequestBodies(1, 2, { maximumBytesToFetch: 4 });

      var gotSnippet = false;
      header.onchange = function() {
        // We now fire onchange even if we don't have a snippet yet;
        // check to make sure it exists before fulfilling the
        // namedValue.
        if (header.snippet != null && !gotSnippet) {
          gotSnippet = true;
          eLazy.log('snippet', header.snippet);
        }
      };

      body.onchange = function() {
        eLazy.log('body', {
          isDownloaded: body.bodyReps[0].isDownloaded,
          amountDownloaded: body.bodyReps[0].amountDownloaded
        });

        body.onchange = function() {
          eLazy.log('body full', {
            isDownloaded: body.bodyReps[0].isDownloaded,
            content: body.bodyReps[0].content
          });
        };
        header.getBody({ downloadBodyReps: true }, function() {});
      };
    });

  });


  closeSlice();

});

}); // end define
