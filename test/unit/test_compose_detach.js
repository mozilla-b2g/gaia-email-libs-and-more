define(['rdcommon/testcontext', './resources/th_main',
        './resources/messageGenerator',
        'util', 'exports'],
       function($tc, $th_main, $msggen,
                $util, exports) {

var TD = exports.TD = $tc.defineTestsFor(
  { id: 'test_compose_detach' }, null,
  [$th_main.TESTHELPER], ['app']);

/**
 * Make sure removing/detaching an attachment works.  We verify by ensuring that
 * the attachment is no longer reported to the client.  (There's no need to
 * verify the back-end rep manually since that gets transmitted to the client
 * and a straight-forward mapping iteration is performed.)
 */
TD.commonCase('detach attachments', function(T, RT) {
  T.group('setup');
  var TEST_PARAMS = RT.envOptions;
  var testUniverse = T.actor('testUniverse', 'U', { realDate: true }),
      testAccount = T.actor('testAccount', 'A',
                            { universe: testUniverse }),
      eLazy = T.lazyLogger('check');

  var inboxFolder = testAccount.do_useExistingFolderWithType('inbox', '');

  // We need the local drafts folder to get at the header / body of the drafts.
  var localDraftsFolder = testAccount.do_useExistingFolderWithType(
        'localdrafts', ''),
      localDraftsView = testAccount.do_openFolderView(
        'localdrafts', localDraftsFolder, null, null,
        { nonet: true });

  var messageSubject = 'The amazing detachable attachment.';

  var attachmentName = 'clevery-truncated.quote';
  var attachmentType = 'application/x-quote';
  var daBlob = new Blob(['Brevity is the soul of'], { type: attachmentType });

  var composer;
  T.group('create draft');
  T.action(eLazy, 'create draft, draft not saved', function() {
    eLazy.expect_event('compose setup completed');

    composer = testUniverse.MailAPI.beginMessageComposition(
      null, inboxFolder, null,
      function() {
        composer.to.push(
          { name: 'Myself', address: TEST_PARAMS.emailAddress });
        composer.subject = messageSubject;
        composer.body.text = 'Typey typey typey!';
        eLazy.event('compose setup completed');
      });
  });

  T.group('attach blob');
  // NB: (This bit here is covered by other compose tests too.)
  function helpAttach() {
    T.action(eLazy, 'attach blob, saveDraft compelled', function() {
      // Check that the generated attachment def matches what we expect
      eLazy.expect_namedValue('num attachments after sync attach', 1);
      eLazy.expect_namedValue('fake attachment', {
        name: attachmentName,
        blob: {
          size: daBlob.size,
          type: attachmentType
        }
      });
      // this will trigger a save only in the initial case.
      if (!composer.hasDraft) {
        testAccount.expect_runOp(
          'saveDraft',
          { local: true, server: false, save: 'local' });
      }
      // Which will be followed by the actual attaching operation.
      testAccount.expect_runOp(
        'attachBlobToDraft',
        { local: true, server: false, flushBodyLocalSaves: 1 });
      eLazy.expect_namedValue('attach result', null);
      eLazy.expect_namedValue('composer passed in', composer);

      var fakeDef = composer.addAttachment(
        {
          name: attachmentName,
          blob: daBlob,
        },
        function(err, _composer) {
          eLazy.namedValue('attach result', err);
          eLazy.namedValue('composer passed in', _composer);
        }
      );
      eLazy.namedValue('num attachments after sync attach',
                       composer.attachments.length);
      eLazy.namedValue('fake attachment', fakeDef);
    });
  }
  helpAttach();

  T.group('detach blob in same composition step');
  function helpDetach() {
    T.action(eLazy, 'detach blob', function() {
      testAccount.expect_runOp(
        'detachAttachmentFromDraft',
        { local: true, server: false, flushBodyLocalSaves: 1 });

      eLazy.expect_namedValueD('num composer drafts after sync detach', 0);

      eLazy.expect_namedValue('detach result', null);
      eLazy.expect_namedValue('composer passed in', composer);

      composer.removeAttachment(
        composer.attachments[0],
        function(err, _composer) {
          eLazy.namedValue('detach result', err);
          eLazy.namedValue('composer passed in', _composer);
        });
      eLazy.namedValueD('num composer drafts after sync detach',
                        composer.attachments.length,
                        composer.attachments);
    });
  };
  helpDetach();

  T.group('verify detached');
  function helpVerifyDetach() {
    T.check(eLazy, 'blob detached', function() {
      eLazy.expect_namedValueD('num drafts', 0);

      var draftHeader = localDraftsView.slice.items[0];
      draftHeader.getBody(function(body) {
        eLazy.namedValueD('num drafts', body.attachments.length,
                          body.attachments);
        body.die();
      });
    });
  };
  helpVerifyDetach();

  T.group('re-attach blob');
  helpAttach();

  T.group('close composition context (saving)');
  function helpCloseComposition(save) {
    T.action(eLazy, 'close context', function() {
      eLazy.expect_event('pinged');

      testAccount.expect_runOp(
        'saveDraft',
        { local: true, server: false, save: 'local' });

      composer.saveDraft();
      composer.die();
      testAccount.MailAPI.ping(function() {
        eLazy.event('pinged');
      });
    });
  }
  helpCloseComposition();

  T.group('reopen draft');
  function helpReopenComposition(numDraftsExpected) {
    T.action(eLazy, 'reopen composition', function() {
      eLazy.expect_namedValueD('num drafts at callback', numDraftsExpected);
      var draftHeader = localDraftsView.slice.items[0];
      composer = draftHeader.editAsDraft(function() {
        eLazy.namedValueD('num drafts at callback',
                          composer.attachments.length,
                          composer.attachments);
      });
    });
  }
  helpReopenComposition(1);

  T.group('detach');
  var liveBody;
  T.action(eLazy, 'fetch body to watch BodyInfo update', function() {
    eLazy.expect_event('got body');
    var draftHeader = localDraftsView.slice.items[0];
    draftHeader.getBody(function(body) {
      liveBody = body;
      eLazy.event('got body');
    });
  });
  helpDetach();

  T.group('verify detached');
  helpVerifyDetach();
  T.check(eLazy, 'verify BodyInfo update nuked attachment', function() {
    eLazy.expect_namedValueD('body attachments count', 0);
    eLazy.namedValueD('body attachments count',
                      liveBody.attachments.length,
                      liveBody.attachments);
    liveBody.die();
    liveBody = null;
  });

  // (if we don't save, there's no point re-checking again.)
  T.group('close composition context (saving)');
  helpCloseComposition();

  T.group('verify still detached');
  helpVerifyDetach();

  T.group('cleanup');
});


}); // end define
