/**
 * Test composition with various parameterized message structures.  The idea is
 * that if you fix something in compose related to message structure, you can
 * easily just add a case to this file rather than copying and pasting something
 * that looks a lot like this file.
 **/

define(function(require) {

var LegacyGelamTest = require('./resources/legacy_gelamtest');

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
 *
 */
return new LegacyGelamTest('varying compose structures', function(T, RT) {
  var textContentsStr = 'purple monkey dishwasher';
  var textContentsUint8 = new TextEncoder().encode(textContentsStr);
  var toCompose = [
    {
      name: 'text attachment',
      attachments: [
        {
          name: 'foo.txt',
          blob: new Blob([textContentsUint8], { type: 'text/plain' }),
          verifyContents: textContentsUint8
        }
      ],
    }
  ];


  T.group('setup');
  var TEST_PARAMS = RT.envOptions;
  var testUniverse = T.actor('TestUniverse', 'U', { realDate: true }),
      testAccount = T.actor('TestAccount', 'A',
                            { universe: testUniverse }),
      testStorage = T.actor('TestDeviceStorage', 'sdcard',
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

  function testComposeMessage(composeDef) {
    var uniqueSubject = makeRandomSubject();

    T.group(composeDef.name);
    var composer;
    // Create the draft,
    T.action(eLazy, 'create draft, draft not saved', function() {
      eLazy.expect('compose setup completed');

      composer = testUniverse.MailAPI.beginMessageComposition(
        null, inboxFolder, null,
        function() {
          composer.to.push(
            { name: 'Myself', address: TEST_PARAMS.emailAddress });
          composer.subject = uniqueSubject;
          composer.body.text = 'I like to type!';
          eLazy.log('compose setup completed');
        });
    });

    // Attach multiple attachments to ensure we properly attach them all.
    for (var i = 0; i < composeDef.attachments.length; i++) {
      var toAttach = composeDef.attachments[i];
      T.action(eLazy, 'attach: ' + toAttach.name, function(i) {
        // Check that the generated attachment def matches what we expect
        eLazy.expect('fake attachment', {
          name: toAttach.name,
          blob: {
            size: toAttach.blob.size,
            type: toAttach.blob.type
          }
        });
        // Because the draft wasn't already saved, the call will
        // compel a save to occur (but only for the first attachment):
        if (i === 0) {
          testAccount.expect_runOp(
            'saveDraft',
            { local: true, server: false, save: 'local' });
        }
        // Which will be followed by the actual attaching operation.
        testAccount.expect_runOp(
          'attachBlobToDraft',
          { local: true, server: false,
            flushBodyLocalSaves: toAttach.saveCount || 1 });
        eLazy.expect('attach result', null);
        eLazy.expect('composer passed in', composer);

        var fakeDef = composer.addAttachment(
          {
            name: toAttach.name,
            blob: toAttach.blob,
          },
          function(err, _composer) {
            eLazy.log('attach result', err);
            eLazy.log('composer passed in', _composer);
          }
        );
        eLazy.log('fake attachment', fakeDef);

      }.bind(null, i));
    }
    T.action(testAccount, eLazy, 'send the message', function() {
      testAccount.expect_runOp(
        'saveDraft',
        { local: true, server: false, save: 'local' });
      testAccount.expect_sendMessageWithOutbox('success', 'conn');

      eLazy.expect('sent');

      composer.finishCompositionSendMessage();
      testUniverse.MailAPI.onbackgroundsendstatus = function(data) {
        if (data.state === 'success') {
          eLazy.log('sent');
        }
      };
    });
    var header = null, body = null;
    testAccount.do_waitForMessage(inboxView, uniqueSubject, {
      expect: function() {
        RT.reportActiveActorThisStep(eLazy);
        eLazy.expect('got body with attachments',
                                 composeDef.attachments.length);
      },
      withMessage: function(_header) {
        header = _header;
        header.getBody(function(_body) {
          body = _body;
          eLazy.log('got body with attachments',
                            body.attachments.length,
                            body.attachments);
        });
      }
    });
    T.action(eLazy, 'download attachments', function() {
      var attachments = [];
      body.attachments.forEach(function(att, iAtt) {
        var toAttach = composeDef.attachments[iAtt];
        eLazy.expect(
          'attachment[' + iAtt + '].size', toAttach.blob.size);
        eLazy.expect(
          'attachment[' + iAtt + '].data', toAttach.verifyContents);

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
                eLazy.log('attachment[' + iAtt + '].size',
                                 body.attachments[iAtt].sizeEstimateInBytes);
                eLazy.log('attachment[' + iAtt + '].data', data);
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

  toCompose.forEach(testComposeMessage);
});

}); // end define
