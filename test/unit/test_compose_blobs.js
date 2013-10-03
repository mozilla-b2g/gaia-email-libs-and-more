/**
 * Compose/drafts tests as it relates to generating Blobs for streaming,
 * especially large attachments (simulated via constant-manipulation
 * so we keep our tests fast.)
 **/

define(['rdcommon/testcontext', './resources/th_main',
        './resources/th_devicestorage', './resources/messageGenerator',
        'mailapi/util', 'mailapi/accountcommon', 'exports'],
       function($tc, $th_imap, $th_devicestorage, $msggen,
                $util, $accountcommon, exports) {

var TD = exports.TD = $tc.defineTestsFor(
  { id: 'test_compose_blobs' }, null,
  [$th_imap.TESTHELPER, $th_devicestorage.TESTHELPER], ['app']);

/**
 * Create a nondeterministic subject (in contrast to what TB's messageGenerator
 * does because unit tests usually like determinism.)
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

  T.action('set blob size to 2 lines (57 bytes per)', function() {
    var jobDriver = testAccount.folderAccount._jobDriver;
    jobDriver.BLOB_BASE64_BATCH_CONVERT_SIZE = 2 * 57;
  });

  function makeBlobOfSize(n, type) {
    var arr = new Uint8Array(n);
    for (var i = 0; i < n; i++) {
      arr[i] = i % 256;
    }
    return new Blob(arr, type);
  }

  function testWithNumBytes(label, numBytes, numBlobs) {
    var uniqueSubject = makeRandomSubject();

    T.group(label);
    var composer;
    // Create the draft,
    T.action(eLazy, 'create draft', function() {
      eLazy.expect_event('compose setup completed');
      composer = testUniverse.MailAPI.beginMessageComposition(
        null, inboxFolder, null,
        function() {
          composer.subject = uniqueSubject;
          eLazy.event('compose setup completed');
        });
    });
    T.action(eLazy, 'attach blob', function() {
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
      var expectedBlobSizes = [];
      for (var i = 0; i < numBlobs; i++) {
        expectedBlobSizes.push(Math.min(57, numBytes - (i * 57)));
      }
      eLazy.expect_namedValue('blobs', expectedBlobSizes);

      var draftHeader = localDraftsView.slice.items[0];
      draftHeader.getBody(function(body) {
        var blobSizes = body.attachments[0].
      });
    });
    T.action(eLazy, 'send the message', function() {
      eLazy.expect_namedValue('sent result', null);
      composer.finishCompositionSendMessage(function(err, badAddrs, debugInfo) {
        eLazy.namedValue('sent result', err);
      });
    });
    var header = null, body = null;
    testAccount.do_waitForMessage(inboxView, uniqueSubject, {
      expect: function() {
        RT.reportActiveActorThisStep(eLazy);
        eLazy.expect_event('got body');
      },
      withessage: function(_header) {
        header.getBody(function(_body) {
          body = _body;
          eLazy.event('got body');
        });
      }
    });
    T.action(eLazy, 'download attachment', function() {
      body
    });

  }

  testWithNumBytes('1 line, 1 blob', 57, 1);
  testWithNumBytes('2 lines, 1 blob', 57 * 2, 1);
  testWithNumBytes('2 lines+1, 2 blobs', 57 * 2 + 1, 2);
  testWithNumBytes('4 lines, 2 blobs', 57 * 4, 2);
});

/**
 * Attach an attachment, detach it, make sure it went away.  Do the same thing a
 * second time (same draft) but this time issue the detach before the attach has
 * completed.  This tests both the inductive case as well as making sure we
 * don't somehow freak out in that case.
 */
TD.commonCase('detach blobs', function() {
});

}); // end define
