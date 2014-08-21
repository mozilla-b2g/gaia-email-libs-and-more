/**
 * Compose/drafts tests as it relates to generating Blobs for streaming,
 * especially large attachments (simulated via constant-manipulation
 * so we keep our tests fast.)
 **/

define(['rdcommon/testcontext', './resources/th_main',
        './resources/th_devicestorage', './resources/messageGenerator',
        'util', 'exports'],
       function($tc, $th_imap, $th_devicestorage, $msggen,
                $util, exports) {

var TD = exports.TD = $tc.defineTestsFor(
  { id: 'test_compose_blobs' }, null,
  [$th_imap.TESTHELPER, $th_devicestorage.TESTHELPER], ['app']);

/**
 * Create a nondeterministic subject (in contrast to what TB's messageGenerator
 * does because unit tests usually like determinism.)  This is required because
 * we potentially use a real Inbox which may have test detritus from previous
 * runs.  In that case, we don't want to be tricked by a previous test run's
 * values.
 */
function makeRandomSubject() {
  return 'Composition: ' + Date.now() + ' ' +
    Math.floor(Math.random() * 100000);
}

/**
 * Create varying size attachments to produce multiple Blobs.
 *
 * We check:
 * - The expected number of Blobs are produced and that their sizes are as
 *   expected.  We do not check the contents, test_b64.js does that.
 * - That our Blob sending logic works at a high level by sending the message to
 *   ourselves, downloading the attachment, then verifying that we can read out
 *   the data okay.
 *
 * We do not check:
 * - That any of our logic actually correctly reduces our memory footprint,
 *   either the attaching logic or the network sending logic.  That would be
 *   slow and not screwing up our memory usage is something that the front-end
 *   will want to test on its own (someday) since there are many things the
 *   front-end could do to screw up the high level goal.
 */
TD.commonCase('large attachments', function(T, RT) {
  T.group('setup');
  var TEST_PARAMS = RT.envOptions;
  var testUniverse = T.actor('testUniverse', 'U', { realDate: true }),
      testAccount = T.actor('testAccount', 'A',
                            { universe: testUniverse }),
      testStorage = T.actor('testDeviceStorage', 'sdcard',
                            { storage: 'sdcard' }),
      eLazy = T.lazyLogger('check');

  // We need the inbox to see the received messages
  var inboxFolder = testAccount.do_useExistingFolderWithType('inbox', ''),
      inboxView = testAccount.do_openFolderView(
        'inbox', inboxFolder, null, null,
        { syncedToDawnOfTime: 'ignore' });
  // We need the local drafts folder to get at the header / body of the drafts.
  var localDraftsFolder = testAccount.do_useExistingFolderWithType(
        'localdrafts', ''),
      localDraftsView = testAccount.do_openFolderView(
        'localdrafts', localDraftsFolder, null, null,
        { nonet: true });

  var BLOB_CONVERT_SIZE = 2 * 57;
  var BLOB_TARGET_SIZE = 78 * 2;
  T.action('set blob size to 2 lines (57 bytes per)', function() {
    var jobDriver = testAccount.folderAccount._jobDriver;
    jobDriver.BLOB_BASE64_BATCH_CONVERT_SIZE = BLOB_CONVERT_SIZE;
  });

  function makeArrOfSize(n) {
    var arr = new Uint8Array(n);
    for (var i = 0; i < n; i++) {
      arr[i] = i % 256;
    }
    return arr;
  }
  function makeBlobOfSize(n, type) {
    var arr = makeArrOfSize(n);
    return new Blob([arr], { type: type });
  }

  function testWithNumBytes(label, numBytes, numBlobs) {
    var uniqueSubject = makeRandomSubject();

    T.group(label);
    var composer;
    // Create the draft,
    T.action(eLazy, 'create draft, draft not saved', function() {
      eLazy.expect_event('compose setup completed');

      composer = testUniverse.MailAPI.beginMessageComposition(
        null, inboxFolder, null,
        function() {
          composer.to.push(
            { name: 'Myself', address: TEST_PARAMS.emailAddress });
          composer.subject = uniqueSubject;
          composer.body.text = 'I like to type!';
          eLazy.event('compose setup completed');
        });
    });
    T.action(eLazy, 'attach blob, saveDraft compelled', function() {
      var attachmentName = 'bytes' + numBytes;
      var attachmentType = 'application/bytes' + numBytes;
      // Check that the generated attachment def matches what we expect
      eLazy.expect_namedValue('fake attachment', {
        name: attachmentName,
        blob: {
          size: numBytes,
          type: attachmentType
        }
      });
      // Because the draft wasn't already saved, the call will compel a save to
      // occur.
      testAccount.expect_runOp(
        'saveDraft',
        { local: true, server: false, save: 'local' });
      // Which will be followed by the actual attaching operation.
      testAccount.expect_runOp(
        'attachBlobToDraft',
        { local: true, server: false, flushBodyLocalSaves: numBlobs });
      eLazy.expect_namedValue('attach result', null);
      eLazy.expect_namedValue('composer passed in', composer);

      var fakeDef = composer.addAttachment(
        {
          name: attachmentName,
          blob: makeBlobOfSize(numBytes, attachmentType)
        },
        function(err, _composer) {
          eLazy.namedValue('attach result', err);
          eLazy.namedValue('composer passed in', _composer);
        }
      );
      eLazy.namedValue('fake attachment', fakeDef);
    });
    // - get the draft body so we can check the Blob list
    T.check(eLazy, 'blob count', function() {
      // The Blob sizes are the encoded size, not the source size.
      var expectedBlobSizes = [];
      for (var i = 0; i < numBlobs; i++) {
        var encodedCount = Math.ceil((numBytes - (i * 57 * 2))/3) * 4 +
                           Math.ceil((numBytes - (i * 57 * 2)) / 57) * 2;
        expectedBlobSizes.push(Math.min(BLOB_TARGET_SIZE, encodedCount));
      }
      eLazy.expect_namedValue('blob sizes', expectedBlobSizes);

      var draftHeader = localDraftsView.slice.items[0];
      draftHeader.getBody(function(body) {
        var blobSizes = body.attachments[0]._file.map(function(blob) {
          return blob.size;
        });
        eLazy.namedValue('blob sizes', blobSizes);
        body.die();
      });
    });
    T.action(testAccount, eLazy, 'send the message', function() {
      testAccount.expect_runOp(
        'saveDraft',
        { local: true, server: false, save: 'local' });
      testAccount.expect_sendMessageWithOutbox('success', 'conn');

      eLazy.expect_event('sent');

      composer.finishCompositionSendMessage();
      testUniverse.MailAPI.onbackgroundsendstatus = function(data) {
        if (data.state === 'success') {
          eLazy.event('sent');
        }
      };
    });
    var header = null, body = null;
    testAccount.do_waitForMessage(inboxView, uniqueSubject, {
      expect: function() {
        RT.reportActiveActorThisStep(eLazy);
        eLazy.expect_event('got body');
      },
      withMessage: function(_header) {
        header = _header;
        header.getBody(function(_body) {
          body = _body;
          eLazy.event('got body');
        });
      }
    });
    T.action(eLazy, 'download attachment', function() {
      eLazy.expect_namedValue(
        'attachment[0].size', numBytes);
      eLazy.expect_namedValue(
        'attachment[0].data', makeArrOfSize(numBytes));

      var attachments = [];
      body.attachments.forEach(function(att, iAtt) {
        att.download(function() {
          testStorage.get(
            att._file[1],
            function gotBlob(error, blob) {
              if (error) {
                console.error('blob fetch error:', error);
                return;
              }
              var reader = new FileReaderSync();
              try {
                var data = new Uint8Array(reader.readAsArrayBuffer(blob));
                console.log('got', data.length, 'bytes, readyState',
                            reader.readyState);
                eLazy.namedValue('attachment[' + iAtt + '].size',
                                 body.attachments[iAtt].sizeEstimateInBytes);
                eLazy.namedValue('attachment[' + iAtt + '].data', data);
              }
              catch(ex) {
                console.error('reader error', ex);
              }
            });
        });
      });
    });
    T.action('kill body', function() {
      body.die();
    });
  }

  testWithNumBytes('1 line, 1 blob', 57, 1);
  testWithNumBytes('2 lines, 1 blob', 57 * 2, 1);
  testWithNumBytes('2 lines+1, 2 blobs', 57 * 2 + 1, 2);
  testWithNumBytes('4 lines, 2 blobs', 57 * 4, 2);
});

}); // end define
