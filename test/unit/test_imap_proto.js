/**
 * IMAP protocol implementation tests.  Also check out test_incoming_prober.js.
 */

define(['rdcommon/testcontext', './resources/th_main',
  './resources/fault_injecting_socket', 'imap', 'exports'],
function($tc, $th_main, $fawlty, $imap, exports) {
var FawltySocketFactory = $fawlty.FawltySocketFactory;

var TD = exports.TD = $tc.defineTestsFor(
  { id: 'test_imap_proto' }, null, [$th_main.TESTHELPER], ['app']);

TD.commonSimple('decodeModifiedUtf7', function(lazy) {
  var decodeModifiedUtf7 = $imap.decodeModifiedUtf7;

  function check(encoded, expected) {
    lazy.expect_namedValue(encoded, expected);
    lazy.namedValue(encoded, decodeModifiedUtf7(encoded));
  }

  check('&-', '&');
  check('&AO4-', '\u00ee');
  check('&AOk-', '\u00e9');
  check('foo &AO4- bar &AOk- baz', 'foo \u00ee bar \u00e9 baz');
  check('foo&AO4-bar&AOk-baz', 'foo\u00eebar\u00e9baz');
  // from RFC3501
  check('~peter/mail/&U,BTFw-/&ZeVnLIqe-',
        '~peter/mail/\u53f0\u5317/\u65e5\u672c\u8a9e');
});

TD.commonSimple('parseImapDateTime', function(lazy) {
  function check(str, expectedTimestamp) {
    var parsedTS = $imap.parseImapDateTime(str);

    lazy.expect_namedValue(str, expectedTimestamp);
    lazy.namedValue(str, parsedTS);
  }

  // remember! dates are zero-based!

  // handle "space digit" for day number
  check(' 4-Jun-2013 14:15:49 -0500',
        Date.UTC(2013, 5, 4, 19, 15, 49));
  // handle "digit" for day number (we may get trimmed)
  check('4-Jun-2013 14:15:49 -0500',
        Date.UTC(2013, 5, 4, 19, 15, 49));
  // handle digit digit
  check('04-Jun-2013 14:15:49 -0500',
        Date.UTC(2013, 5, 4, 19, 15, 49));
  check('14-Jun-2013 14:15:49 -0500',
        Date.UTC(2013, 5, 14, 19, 15, 49));
});

function thunkTimeouts(lazyLogger) {
  var timeouts = [];
  function thunkedSetTimeout(func, delay) {
    lazyLogger.namedValue('incoming:setTimeout', delay);
    return timeouts.push(func);
  }
  function thunkedClearTimeout() {
    lazyLogger.event('incoming:clearTimeout');
  }

  $imap.TEST_useTimeoutFuncs(thunkedSetTimeout, thunkedClearTimeout);
  return function fireThunkedTimeout(index) {
    timeouts[index]();
    timeouts[index] = null;
  };
}

// Currently all the tests in here are completely fake; we never connect.
const HOST = 'localhost', PORT = 65535;
var CONN_TIMEOUT = 10000;

function makeCredsAndConnInfo() {
  return {
    username: 'USERNAME',
    password: 'PASSWORD',
    hostname: HOST,
    port: PORT,
    crypto: false,

  };
}

/**
 * Connection test helper.  Cases basically go like this:
 * - setup connection, ensure no writes happen.
 * - generate connect notification, ensure no writes happen.
 * - send the server greeting (parameterized), expect a specific (parameterized)
 *   response from this.
 * - test over! we win! party at IMAP's house!
 *
 * @param opts.greeting
 * @param opts.firstRequest
 * @param opts.capabilities
 */
function cannedConnectTest(T, RT, opts) {
  $th_main.thunkConsoleForNonTestUniverse();
  var eCheck = T.lazyLogger('check');

  var fireTimeout = thunkTimeouts(eCheck),
      cci = makeCredsAndConnInfo(),
      prober;

  var imapConn = null;
  T.action('create IMAP proto, see connect req, no write', eCheck, function() {
    eCheck.expect_event('socket opened');
    eCheck.expect_namedValue('incoming:setTimeout', CONN_TIMEOUT);

    FawltySocketFactory.precommand(
      HOST, PORT,
      // make this a fake connection with no underlying real socket, but send
      // nothing on connect.
      {
        cmd: 'fake-no-connect',
        data: null
      },
      null,
      // log all writes from the client.
      {
        callOnOpen: function() {
          eCheck.event('socket opened');
        },
        callOnWrite: function(str) {
          eCheck.namedValue('clientWrite', str);
        }
      });

    imapConn = new $imap.ImapConnection(makeCredsAndConnInfo());
    imapConn.connect();
  });

  var fakeSock;
  T.action('send connect notification, see no writes', eCheck, function() {
    fakeSock = FawltySocketFactory.getMostRecentLiveSocket();
    // the connect notification should cancel the timeout, but that's it!
    eCheck.expect_event('incoming:clearTimeout');
    fakeSock._queueEvent('connect');
  });

  T.action('send greeting, see expected first write', eCheck, function() {
    eCheck.expect_namedValue('clientWrite', opts.firstRequest);

    fakeSock.doNow(
      [
        {
          cmd: 'fake-receive',
          data: opts.greeting
        }
      ]);
  });

  if (opts.capabilities) {
    T.check(eCheck, 'capabilities', function() {
      eCheck.expect_namedValue('capabilities', opts.capabilities);
      eCheck.namedValue('capabilities', imapConn.capabilities);
    });
  }

  T.cleanup('kill IMAP conn', eCheck, function() {
    imapConn.die();
  });
}

var NON_DOVECOT_GREETING = '* OK whatever\r\n';
var CAPABILITY_REQUEST = 'A1 CAPABILITY\r\n';

/**
 * In https://bugzil.la/977867 gmail would ignore anything we managed to send
 * prior to the greeting / in our TLS-finalization packet, so we need to make
 * sure that we do not send our CAPABILITY request until the server issues
 * a greeting.
 */
TD.commonCase('wait for server greeting, no inline CAPABILITY', function(T,RT) {
  cannedConnectTest(T, RT, {
    greeting: NON_DOVECOT_GREETING,
    firstRequest: CAPABILITY_REQUEST
  });
});

var DOVECOT_CAPABILITY_GREETING =
  '* OK [CAPABILITY IMAP4rev1 LITERAL+ SASL-IR LOGIN-REFERRALS ID' +
    ' ENABLE IDLE STARTTLS AUTH=PLAIN] Dovecot ready.\r\n';
var DOVECOT_CAPABILITIES = [
  'IMAP4REV1', 'LITERAL+', 'SASL-IR', 'LOGIN-REFERRALS', 'ID',
  'ENABLE', 'IDLE', 'STARTTLS', 'AUTH=PLAIN'];
var LOGIN_REQUEST = 'A1 LOGIN "USERNAME" "PASSWORD"\r\n';

/**
 * Same as the previous case but dovecot likes to send a CAPABILITY response
 * in the greeting.  We should consume that and not bother
 */
TD.commonCase('wait for server greeting, inline CAPABILITY', function(T,RT) {
  cannedConnectTest(T, RT, {
    greeting: DOVECOT_CAPABILITY_GREETING,
    firstRequest: LOGIN_REQUEST,
    capabilities: DOVECOT_CAPABILITIES
  });
});

}); // end define
