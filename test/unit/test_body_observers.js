define(function(require) {

var LegacyGelamTest = require('./resources/legacy_gelamtest');
var $ascp = require('activesync/codepages');
var FilterType = $ascp.AirSync.Enums.FilterType;

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
return new LegacyGelamTest('body update events', function(T, RT) {
  var testUniverse = T.actor('TestUniverse', 'U', { realDate: true }),
      testAccount = T.actor('TestAccount', 'A',
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
    eLazy.expect('got body');

    header.getBody(function(body) {
      eLazy.log('got body');
      eLazy.expect('update body', {
        detail: expectedDetail,
        body: body
      });
      eLazy.expect('dead');
      eLazy.expect('free backend handle',  false);

      // This will currently corrupt the body state since this expects a valid
      // BodyInfo structure, but we don't care.
      var gibberishBodyInfo = {};
      triggerUpdate(header, expectedDetail, gibberishBodyInfo);

      body.onchange = function(detail, updateBody) {
        // we should never hear about this event as body listeners
        // should close when we call die...
        triggerUpdate(header, { hax: true }, gibberishBodyInfo);

        eLazy.log('update body', {
          detail: detail,
          body: updateBody
        });

        body.die();

        body.ondead = function() {
          eLazy.log('dead');
          eLazy.log(
            'free backend handle',
            MailBridge.bodyHasObservers(header.id)
          );
        };
      };
    });
  });

});

}); // end define
