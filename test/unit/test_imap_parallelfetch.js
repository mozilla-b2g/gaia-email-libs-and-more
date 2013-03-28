load('resources/loggest_test_framework.js');
// Use the faulty socket implementation.
load('resources/fault_injecting_socket.js');

var TD = $tc.defineTestsFor(
  { id: 'test_imap_parallelfetch' },
  null,
  [$th_imap.TESTHELPER],
  ['app']
);

/**
 * This case is to verify the ordering and content of the initial sync messages.
 * This does _not_ cover database persistence (which is handled in other test
 * cases).
 */
TD.commonCase('fetch 3 bodies at once', function(T, RT) {
  var testUniverse = T.actor('testUniverse', 'U', { realDate: true }),
      testAccount = T.actor('testAccount', 'A',
                            { universe: testUniverse,
                              realAccountNeeded: true });

  var eLazy = T.lazyLogger('misc');
  var folderName = 'test_imap_parallel_fetch';
  var messageCount = 3;

  var testFolder = testAccount.do_createTestFolder(
    folderName,
    { count: messageCount, age: { days: 3 } }
  );

  var folderView = testAccount.do_openFolderView(
    folderName, testFolder,
    null,
    { top: true, bottom: true, grow: false },
    { syncedToDawnOfTime: 'ignore' });


  var imapSocket;

  T.group('setup');

  T.action('find socket', eLazy, function() {
    eLazy.expect_namedValueD('imap socket', true);

    imapSocket = FawltySocketFactory.findImapSocket();
    eLazy.namedValueD('imap socket', !!imapSocket);
  });

  T.action('issue fetches', eLazy, function() {
    eLazy.expect_event('fetches issued', 3);

    // expect them to be sent in parallel.
    var pending = 3;
    var fetches = [];

    function next() {
      if (!--pending) {
        eLazy.event('fetches issued');
      }
    }

    folderView.slice.items.forEach(function(item) {
      item.getBody({ downloadBodyReps: true }, function() {});
    });

    imapSocket.consumeEventHandler('data', function(event) {
      var content = event.data;
      var len = Math.min(10, content.length);
      var string = '';

      // get first line ending
      for (var i = 0; i < len; i++) {
        string += String.fromCharCode(content[i]);
      }

      // capture fetch requests
      if (string.indexOf('FETCH') !== -1) {
        fetches.push(event);
        next();
        return true;
      }
    });
  });

});

function run_test() {
  runMyTests(2);
}

