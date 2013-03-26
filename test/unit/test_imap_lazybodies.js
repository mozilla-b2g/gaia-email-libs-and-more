load('resources/loggest_test_framework.js');

var TD = $tc.defineTestsFor(
  { id: 'test_imap_lazybodies' },
  null,
  [$th_imap.TESTHELPER],
  ['app']
);

/**
 * This case is to verify the ordering and content of the initial sync messages.
 * This does _not_ cover database persistence (which is handled in other test
 * cases).
 */
TD.commonCase('sync headers then download body', function(T, RT) {
  var testUniverse = T.actor('testUniverse', 'U', { realDate: true }),
      testAccount = T.actor('testAccount', 'A',
                            { universe: testUniverse,
                              realAccountNeeded: true });

  var eLazy = T.lazyLogger('misc');
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
      closeActor.expect_event('slice died');
      slice.ondead = function() {
        testAccount._unusedConnections++;
        closeActor.event('slice died');
      };

      slice.die();
    });
  }

  // reused across many actions
  var slice;

  T.action('initial sync', eLazy, function() {
    slice = openSlice();

    var bodyLog = T.lazyLogger('body logs');
    RT.reportActiveActorThisStep(bodyLog);

    // expect the additions
    testFolder.serverMessages.forEach(function(msg) {
      var guid = msg.headerInfo.guid;

      eLazy.expect_namedValue(
        'add header', { guid: guid, snippet: null }
      );

      bodyLog.expect_namedValue('body', {
        guid: guid,
        bodyReps: [{
          hasSize: true,
          type: msg.bodyInfo.bodyReps[0].type,
          part: String(msg.bodyInfo.bodyReps[0].content[0]),
          amountDownloaded: 0,
          isDownloaded: false
        }]
      });
    });

    eLazy.expect_event('sync complete');

    slice.onadd = function(added) {
      var guid = added.guid;

      eLazy.namedValue('add header', {
        guid: guid,
        snippet: added.snippet
      });

      added.getBody(function(bodyInfo) {
        var rep = bodyInfo.bodyReps[0];
        bodyLog.namedValue('body', {
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
      eLazy.event('sync complete');
    };
  });

  T.action('fetch body after sync', eLazy, function() {
    var header = slice.items[0];
    // headers are now available
    eLazy.expect_namedValue('sends body', header.id);

    header.getBody({ downloadBodyReps: true }, function(body) {
      eLazy.expect_namedValue('update bodyRep', {
        id: header.id,
        content:
          testFolder.serverMessageContent(header.guid),
        isDownloaded: true,
        indexesChanged: [0], // first body rep
        updatesAll: true,
        amountGreaterEqToEstimate: true
      });

      eLazy.namedValue('sends body', header.id);

      // the theory is onchange the contents change based on the new wireRep
      // data but we also want some idea of what changed so we don't blow up
      // everything
      body.onchange = function(details) {
        if (details.changeType === 'bodyReps') {
          var bodyRep = body.bodyReps[details.indexes[0]];
          // details should be the index and new representation

          eLazy.namedValue('update bodyRep', {
            id: header.id,
            indexesChanged: details.indexes,
            content: bodyRep.content,
            isDownloaded: bodyRep.isDownloaded,
            updatesAll: body.bodyReps.length === details.indexes.length,
            amountGreaterEqToEstimate:
              bodyRep.amountDownloaded >= bodyRep.sizeEstimate
          });
        }
      };
    });
  });

  T.action('attempt to fetch body for deleted message', eLazy, function() {
    var header = slice.items[1];

    eLazy.expect_event('header removed');
    header.onremove = function() {
      eLazy.event('header removed');
    };

    header.getBody({ downloadBodyReps: true }, function(bodyInfo) {
      // after we got body emulate deletion
      testAccount.fakeServerMessageDeletion(header);

      bodyInfo.onchange = function() {
        eLazy.event('change event fired!');
      };
    });
  });

  closeSlice();

});

function run_test() {
  runMyTests(5);
}
