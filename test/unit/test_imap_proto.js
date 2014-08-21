/**
 * IMAP protocol implementation tests.  Also check out test_incoming_prober.js.
 */

define(['rdcommon/testcontext', './resources/th_main',
        './resources/fault_injecting_socket', 'browserbox', 'wo-utf7',
        'imap/imapchew', 'exports'],
function($tc, $th_main, $fawlty, BrowserBox, utf7, $imapchew, exports) {
var FawltySocketFactory = $fawlty.FawltySocketFactory;

var TD = exports.TD = $tc.defineTestsFor(
  { id: 'test_imap_proto' }, null, [$th_main.TESTHELPER], ['app']);

TD.commonSimple('decodeModifiedUtf7', function(lazy) {
  var decodeModifiedUtf7 = utf7.imap.decode;

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
    var parsedTS = $imapchew.parseImapDateTime(str);

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

// Currently all the tests in here are completely fake; we never connect.
const HOST = 'localhost', PORT = 65535;
var CONN_TIMEOUT = 10000;

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

  var prober;

  var imapConn = null;
  T.action('create IMAP proto, see connect req, no write', eCheck, function() {
    eCheck.expect_event('socket opened');

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
          if (str === "W1 ID NIL\r\n") {
            this.doNow({
              cmd: 'fake-receive',
              data: 'W1 OK\r\n'
            });
            return;
          }
          eCheck.namedValue('clientWrite', str);
        }
      });

    imapConn = new BrowserBox(HOST, PORT, {
      auth: {
        user: 'USERNAME',
        pass: 'PASSWORD'
      }
    });
    imapConn.connect();
  });

  var fakeSock;
  T.action('send connect notification, see no writes', eCheck, function() {
    fakeSock = FawltySocketFactory.getMostRecentLiveSocket();
    fakeSock._queueEvent('open');
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

  T.cleanup('kill IMAP conn', eCheck, function() {
    imapConn.close();
  });
}

var DOVECOT_CAPABILITY_GREETING =
  '* OK [CAPABILITY IMAP4rev1 LITERAL+ SASL-IR LOGIN-REFERRALS ID' +
    ' ENABLE IDLE STARTTLS AUTH=PLAIN] Dovecot ready.\r\n';
var DOVECOT_CAPABILITIES = [
  'IMAP4REV1', 'LITERAL+', 'SASL-IR', 'LOGIN-REFERRALS', 'ID',
  'ENABLE', 'IDLE', 'STARTTLS', 'AUTH=PLAIN'];
var LOGIN_REQUEST = 'W2 login "USERNAME" "PASSWORD"\r\n';

/**
 * Dovecot likes to send a CAPABILITY response in the greeting. We
 * should consume that and not bother.
 */
TD.commonCase('wait for server greeting, inline CAPABILITY', function(T,RT) {
  cannedConnectTest(T, RT, {
    greeting: DOVECOT_CAPABILITY_GREETING,
    firstRequest: LOGIN_REQUEST,
    capabilities: DOVECOT_CAPABILITIES
  });
});

}); // end define
