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

  // events of the raw fetch data
  var fetches = [];

  T.group('setup');

  T.action('find socket', eLazy, function() {
    eLazy.expect_namedValueD('imap socket', true);

    imapSocket = FawltySocketFactory.findImapSocket();
    eLazy.namedValueD('imap socket', !!imapSocket);
  });


  T.action('issue fetches', eLazy, function() {
    eLazy.expect_event('fetches issued');

    // expect them to be sent in parallel.
    var pending = 3;

    function next() {
      if (!--pending) {
        window.setZeroTimeout(function() {
          eLazy.event('fetches issued');
        });
      }
    }

    // fetch everything
    folderView.slice.maybeRequestSnippets(0, 10);

    imapSocket.consumeEventHandler('data', function(event) {
      var content = event.data;
      var len = content.length;
      var string = '';

      // get first line ending
      for (var i = 0; i < len; i++) {
        string += String.fromCharCode(content[i]);
      }
      // capture fetch requests its very important to note that the FETCH
      // responses may be in the same packet. Even if there is only one data
      // event all three fetches may be contained within.

      // count the fetches
      var idx = 0;
      var capture = false;

      while ((idx = string.indexOf(' FETCH (UID', idx)) !== -1) {
        idx++;
        next();
        capture = true;
      }

      if (capture) {
        fetches.push(event);
      }

      return capture;

    });
  });

  T.group('recieving data');

  T.action('recieve fetches in random order', eLazy, function() {
    // we don't care about order only correctness
    eLazy.expectUseSetMatching();

    folderView.slice.items.forEach(function(header) {
      var serverContent = testFolder.serverMessageContent(header.guid);
      var snippet = serverContent[1].slice(0, 50);

      eLazy.expect_namedValue('snippet', JSON.stringify({
        id: header.id,
        // snippets are usually trimmed
        approxSnippet: snippet.trim()
      }));

      header.onchange = function() {
        eLazy.namedValue('snippet', JSON.stringify({
          id: header.id,
          approxSnippet: header.snippet.slice(0, 50).trim()
        }));
      };
    });

    // emit the fetches in reverse order

    // clear the catch handler
    imapSocket.clearConsumeEventsHandler('data');

    fetches.reverse().forEach(function(event) {
      imapSocket.ondata(event);
    });
  });

  // reorder the fetches and expect the right results...
});

function run_test() {
  runMyTests(10);
}

