define(['rdcommon/testcontext', './resources/th_main',
        'activesync/codepages', 'exports'],
       function($tc, $th_main, $ascp, exports) {
var FilterType = $ascp.AirSync.Enums.FilterType;

var TD = exports.TD = $tc.defineTestsFor(
  { id: 'test_body_observers' }, null,
  [$th_main.TESTHELPER], ['app']);

/**
 * Verify that when we have an active body listener (and body.die() has not been
 * called) that:
 * - the onchange event fires
 * - the 'detail' object passed to notifyBodyUpdate is passed in
 * - the onchange event passes in the same body instance `getBody` was called on
 *
 * This test does not cover that updates to the body representation are
 * correctly performed.  That is tested in the tests that make the manipulations
 * (download tests, body rep download tests, etc.)
 */
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


  function triggerUpdate(header, detail, bodyInfo) {
    MailBridge.notifyBodyModified(
      header.id, detail, bodyInfo
    );
  }

  // Global header target for the tests..
  var header;

  T.action('listen and cleanup', eLazy, function() {
    header = view.slice.items[0];

    var expectedDetail = {
      xfoo: true
    };

    // Do not generate the expectation on the body until we have the body.
    eLazy.asyncEventsAreComingDoNotResolve();

    header.getBody(function(body) {
      eLazy.expect_namedValue('update body', {
        detail: expectedDetail,
        body: body
      });
      eLazy.expect_event('dead');
      eLazy.expect_namedValue('free backend handle', false);
      eLazy.asyncEventsAllDoneDoResolve();

      // This will currently corrupt the body state since this expects a valid
      // BodyInfo structure, but we don't care.
      var gibberishBodyInfo = {};
      triggerUpdate(header, expectedDetail, gibberishBodyInfo);

      body.onchange = function(detail, updateBody) {
        // we should never hear about this event as body listeners
        // should close when we call die...
        triggerUpdate(header, { hax: true }, gibberishBodyInfo);

        eLazy.namedValue('update body', {
          detail: detail,
          body: updateBody
        });

        body.die();

        body.ondead = function() {
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
