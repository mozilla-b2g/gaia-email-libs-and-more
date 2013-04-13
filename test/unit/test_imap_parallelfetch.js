define(['rdcommon/testcontext', 'mailapi/testhelper',
        './resources/messageGenerator', './resources/fault_injecting_socket',
        'exports'],
       function($tc, $th_imap, $msggen, $fawlty, exports) {

var FawltySocketFactory = $fawlty.FawltySocketFactory;

var TD = exports.TD = $tc.defineTestsFor(
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
  var messageCount = 22;

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

  // events of the raw fetch data
  var fetches = [];

  T.group('recieving data');

  T.action('recieve fetches in random order', eLazy, function() {
    // we don't care about order only correctness
    eLazy.expectUseSetMatching();

    folderView.slice.items.forEach(function(header) {
      var serverContent = testFolder.serverMessageContent(header.guid);
      var snippet = serverContent[1].slice(0, 20);

      eLazy.expect_namedValue('snippet', JSON.stringify({
        id: header.id,
        // snippets are usually trimmed
        approxSnippet: snippet.trim()
      }));

      header.onchange = function() {
        eLazy.namedValue('snippet', JSON.stringify({
          id: header.id,
          approxSnippet: header.snippet.slice(0, 20).trim()
        }));
      };
    });

    folderView.slice.maybeRequestSnippets(0, messageCount + 1);

  });

  // reorder the fetches and expect the right results...
});

}); // end define
