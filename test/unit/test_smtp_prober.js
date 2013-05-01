/**
 * Test the SMTP prober in isolation.
 *
 * Right now we cover:
 * - Timeout trying to talk to the server.
 * - SSL error trying to talk to the server.
 * - Auth failure.
 */

define(['rdcommon/testcontext', './resources/th_main',
        './resources/fault_injecting_socket', 'mailapi/smtp/probe',
        'exports'],
       function($tc, $th_imap, $fawlty, $smtpprobe, exports) {
var FawltySocketFactory = $fawlty.FawltySocketFactory;

$smtpprobe.TEST_USE_DEBUG_MODE = true;

var TD = exports.TD = $tc.defineTestsFor(
  { id: 'test_smtp_prober' }, null, [$th_imap.TESTHELPER], ['app']);

function thunkSmtpTimeouts(lazyLogger) {
  var timeouts = [];
  $smtpprobe.TEST_useTimeoutFuncs(
    function thunkedSetTimeout(func, delay) {
      lazyLogger.namedValue('smtp:setTimeout', delay);
      return timeouts.push(func);
    },
    function thunkedClearTimeout() {
      lazyLogger.event('smtp:clearTimeout');
    });
  return function fireThunkedTimeout(index) {
    timeouts[index]();
    timeouts[index] = null;
  };
}

// Currently all the tests in here are completely fake; we never connect.
const HOST = 'localhost', PORT = 465;

function makeCredsAndConnInfo() {
  return {
    credentials: {
      username: 'USERNAME',
      password: 'PASSWORD',
    },
    connInfo: {
      hostname: HOST,
      port: PORT,
      crypto: true,
    },
  };
}

TD.commonCase('timeout failure', function(T, RT) {
  var eCheck = T.lazyLogger('check'),
      prober = null;

  var fireTimeout = thunkSmtpTimeouts(eCheck);
  var cci = makeCredsAndConnInfo();

  T.action(eCheck, 'create prober', function() {
    FawltySocketFactory.precommand(HOST, PORT, 'unresponsive-server');
    eCheck.expect_namedValue('smtp:setTimeout', $smtpprobe.CONNECT_TIMEOUT_MS);
    prober = new $smtpprobe.SmtpProber(cci.credentials, cci.connInfo);
    prober.onresult = function(err) {
      eCheck.namedValue('probe result', err);
    };
  });
  T.action(eCheck, 'trigger timeout', function() {
    eCheck.expect_event('smtp:clearTimeout');
    eCheck.expect_namedValue('probe result', 'unresponsive-server');
    fireTimeout(0);
  });
});

TD.commonCase('SSL failure', function(T, RT) {
  var eCheck = T.lazyLogger('check'),
      prober = null;

  var fireTimeout = thunkSmtpTimeouts(eCheck);
  var cci = makeCredsAndConnInfo();

  T.action(eCheck, 'create prober, see SSL error', function() {
    FawltySocketFactory.precommand(HOST, PORT, 'bad-security');
    eCheck.expect_namedValue('smtp:setTimeout', $smtpprobe.CONNECT_TIMEOUT_MS);
    prober = new $smtpprobe.SmtpProber(cci.credentials, cci.connInfo);
    prober.onresult = function(err) {
      eCheck.namedValue('probe result', err);
    };
    eCheck.expect_event('smtp:clearTimeout');
    eCheck.expect_namedValue('probe result', 'bad-security');
  });
});

const SMTP_GREETING = '220 localhsot ESMTP Fake\r\n';
const SMTP_EHLO_RESPONSE = '250 AUTH PLAIN\r\n';


function cannedLoginTest(T, RT, opts) {
  var eCheck = T.lazyLogger('check');

  var fireTimeout = thunkSmtpTimeouts(eCheck),
      cci = makeCredsAndConnInfo(),
      prober;

  T.action('connect, get error, return', eCheck, function() {
    eCheck.expect_namedValue('smtp:setTimeout', $smtpprobe.CONNECT_TIMEOUT_MS);
    eCheck.expect_event('smtp:clearTimeout');
    eCheck.expect_namedValue('probe result', opts.expectResult);
    FawltySocketFactory.precommand(
      HOST, PORT,
      {
        cmd: 'fake',
        data: SMTP_GREETING,
      },
      [
        opts.ehloResponse || SMTP_EHLO_RESPONSE,
        opts.loginErrorString
      ]);
    prober = new $smtpprobe.SmtpProber(cci.credentials, cci.connInfo);
    prober.onresult = function(err) {
      eCheck.namedValue('probe result', err);
    };
  });
};

TD.commonCase('bad username or password', function(T, RT) {
  cannedLoginTest(T, RT, {
    loginErrorString: '535 Authentication DENIED\r\n',
    expectResult: 'bad-user-or-pass',
  });
});

TD.commonCase('angry server', function(T, RT) {
  cannedLoginTest(T, RT, {
    ehloResponse: '500 go away!\r\n',
    // it will then say HELO, which we also hate, because we are angry.
    loginErrorString: '500 I said go away!\r\n',
    expectResult: 'server-problem',
  });
});

}); // end define
