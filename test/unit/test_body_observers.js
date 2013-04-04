define(['rdcommon/testcontext', 'mailapi/testhelper',
        'activesync/codepages', 'exports'],
       function($tc, $th_imap, $ascp, exports) {
var FilterType = $ascp.AirSync.Enums.FilterType;

var TD = exports.TD = $tc.defineTestsFor(
  { id: 'test_body_observers' },
  null,
  [$th_imap.TESTHELPER],
  ['app']
);

TD.commonCase('body update events', function(T, RT) {
  var testUniverse = T.actor('testUniverse', 'U', { realDate: true }),
      testAccount = T.actor('testAccount', 'A',
                            { universe: testUniverse,
                              realAccountNeeded: false });

  var eLazy = T.lazyLogger('misc');
  var folderName = 'test_body_observers';

  var testFolder = testAccount.do_createTestFolder(
    folderName,
    { count: 1, age: { days: 1 } }
  );

  var view = testAccount.do_openFolderView(
    folderName, testFolder,
    { count: 1, full: 1, flags: 0, deleted: 0,
      filterType: FilterType.NoFilter },
    { top: true, bottom: true, grow: false },
    { syncedToDawnOfTime: 'ignore' });


  function triggerUpdate(header, detail, body) {
    MailBridge.notifyBodyModified(
      header.id, detail, body
    );
  }

  // Global header target for the tests..
  var header;

  T.action('listen and cleanup', eLazy, function() {
    header = view.slice.items[0];

    // given that the bridge likely will live in the worker
    // this may fail in the future...
    var expectedDetail = {
      xfoo: true
    };

    var expectedBody = { sentMe: true };

    eLazy.expect_namedValue('update body', {
      detail: expectedDetail,
      body: expectedBody
    });

    header.getBody(function(body) {
      triggerUpdate(header, expectedDetail, expectedBody);

      body.onchange = function(detail, updateBody) {
        eLazy.expect_event('dead');

        // we should never hear about this event as body listeners
        // should close when we call die...
        triggerUpdate(header, { hax: true }, expectedBody);

        eLazy.namedValue('update body', {
          detail: detail,
          body: updateBody
        });

        body.die();

        body.ondead = function() {
          eLazy.expect_namedValue('free backend handle', false);

          eLazy.event('dead');
          eLazy.namedValue(
            'free backend handle',
            MailBridge.bodyHasObservers(header.id)
          );
        };
      };
    });
  });

});

}); // end define
