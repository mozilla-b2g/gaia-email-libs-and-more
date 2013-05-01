define(['rdcommon/testcontext', './resources/th_main', 'exports'],
       function($tc, $th_imap, exports) {

var TD = exports.TD = $tc.defineTestsFor(
  { id: 'test_imap_partialbodyfetching' },
  null,
  [$th_imap.TESTHELPER], ['app']
);

TD.commonCase('fetch only snippets', function(T, RT) {
  var testUniverse = T.actor('testUniverse', 'U'),
      testAccount = T.actor('testAccount', 'A', { universe: testUniverse });

  var eLazy = T.lazyLogger('misc');
  var folderName = 'test_partialbodyfetch_only';
  var messageCount = 2;

  var initialFolder = testAccount.do_createTestFolder(
    folderName,
    { count: messageCount, age: { days: 5 } }
  );

  var createFolderView = function createFolderView(testFolder) {
    return testAccount.do_openFolderView(
      'syncs',
      testFolder,
      null,
      null,
      { syncedToDawnOfTime: 'ignore' }
    );
  };

  var folderView = createFolderView(initialFolder);

  var originalSnippets = {};

  T.action('fetch snippets', eLazy, function() {
    var slice = folderView.slice;

    slice.items.forEach(function(header) {
      eLazy.expect_namedValue('snippet', {
        id: header.id,
        hasSnippet: true
      });

      header.onchange = function() {
        originalSnippets[header.id] = header.snippet;
        eLazy.namedValue('snippet', {
          id: header.id,
          hasSnippet: !!header.snippet
        });
      };
    });

    eLazy.expect_namedValue('request complete', true);

    slice.maybeRequestBodies(0, 1, function() {
      eLazy.namedValue('request complete', true);
    });
  });

  testAccount.do_closeFolderView(folderView);
  testUniverse.do_shutdown();

  var testUniverse2 = T.actor('testUniverse', 'U');
  var testAccount2 = T.actor('testAccount', 'A', {
    universe: testUniverse2,
    restored: true
  });

  var reuseFolder = testAccount2.do_useExistingFolder(
    folderName, '#2', initialFolder
  );

  var recreateView = testAccount2.do_openFolderView('reuse', reuseFolder);

  T.action('verify snippets exist', eLazy, function() {
    for (var headerId in originalSnippets) {
      eLazy.expect_namedValue('header snippet', {
        id: headerId,
        snippet: originalSnippets[headerId]
      });
    }

    recreateView.slice.items.forEach(function(header) {
      eLazy.namedValue('header snippet', {
        id: header.id,
        snippet: header.snippet
      });
    });
  });

  T.check('requesting existing headers', eLazy, function() {
    eLazy.expect_namedValue('fires callback', false);
    recreateView.slice.maybeRequestBodies(0, 1, function() {
      // false means it does not queue
      eLazy.namedValue('fires callback', false);
    });
  });

  T.action('request full body after snippets', eLazy, function() {
    recreateView.slice.items.forEach(function(header) {
      var content =
        reuseFolder.serverMessageContent(header.guid);

      eLazy.expect_namedValue('body content', {
        id: header.id,
        isDownloaded: true,
        content: content,
        snippet: header.snippet
      });

      testAccount2.getMessageBodyWithReps(header, function(body) {
        var rep = body.bodyReps[0];
        eLazy.namedValue('body content', {
          id: header.id,
          isDownloaded: rep.isDownloaded,
          content: rep.content,
          snippet: header.snippet
        });
      });
    });
  });

});

}); // end define
