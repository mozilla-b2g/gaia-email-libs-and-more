define(function(require) {

var LegacyGelamTest = require('./resources/legacy_gelamtest');

return new LegacyGelamTest('fetch only snippets', function(T, RT) {
  var testUniverse = T.actor('TestUniverse', 'U'),
      testAccount = T.actor('TestAccount', 'A', { universe: testUniverse });

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
      eLazy.expect('snippet', {
        id: header.id,
        hasSnippet: true
      });

      header.onchange = function() {
        originalSnippets[header.id] = header.snippet;
        eLazy.log('snippet', {
          id: header.id,
          hasSnippet: !!header.snippet
        });
      };
    });

    eLazy.expect('request complete',  true);

    slice.maybeRequestBodies(0, 1, function() {
      eLazy.log('request complete', true);
    });
  });

  testAccount.do_closeFolderView(folderView);
  testUniverse.do_shutdown();

  var testUniverse2 = T.actor('TestUniverse', 'U');
  var testAccount2 = T.actor('TestAccount', 'A', {
    universe: testUniverse2,
    restored: true
  });

  var reuseFolder = testAccount2.do_useExistingFolder(
    folderName, '#2', initialFolder
  );

  var recreateView = testAccount2.do_openFolderView('reuse', reuseFolder);

  T.action('verify snippets exist', eLazy, function() {
    for (var headerId in originalSnippets) {
      eLazy.expect('header snippet', {
        id: headerId,
        snippet: originalSnippets[headerId]
      });
    }

    recreateView.slice.items.forEach(function(header) {
      eLazy.log('header snippet', {
        id: header.id,
        snippet: header.snippet
      });
    });
  });

  T.check('requesting existing headers', eLazy, function() {
    eLazy.expect('fires callback',  false);
    recreateView.slice.maybeRequestBodies(0, 1, function() {
      // false means it does not queue
      eLazy.log('fires callback', false);
    });
  });

  T.action('request full body after snippets', eLazy, function() {
    recreateView.slice.items.forEach(function(header) {
      var content =
        reuseFolder.serverMessageContent(header.guid);

      eLazy.expect('body content', {
        id: header.id,
        isDownloaded: true,
        content: content,
        snippet: header.snippet
      });

      header.getBody({ withBodyReps: true }, function(body) {
        var rep = body.bodyReps[0];
        eLazy.log('body content', {
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
