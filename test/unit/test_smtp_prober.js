/**
 * Test the SMTP prober in isolation.
 *
 * Right now we cover:
 * - Timeout trying to talk to the server.
 * - SSL error trying to talk to the server.
 * - Auth failure.
 */

load('resources/loggest_test_framework.js');
// Use the faulty socket implementation.
load('resources/fault_injecting_socket.js');

var $_smtpprobe = require('mailapi/smtp/probe');

var TD = $tc.defineTestsFor(
  { id: 'test_smtp_prober' }, null, [$th_imap.TESTHELPER], ['app']);

function thunkConsole(T) {
  var lazyConsole = T.lazyLogger('console');

  gConsoleLogFunc = function(msg) {
    lazyConsole.value(msg);
  };
}

function thunkSmtpTimeouts(lazyLogger) {
  var timeouts = [];
  $_smtpprobe.TEST_useTimeoutFuncs(
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
  thunkConsole(T);
  var eCheck = T.lazyLogger('check'),
      prober = null;

  var fireTimeout = thunkSmtpTimeouts(eCheck);
  var cci = makeCredsAndConnInfo();

  T.action(eCheck, 'create prober', function() {
    FawltySocketFactory.precommand(HOST, PORT, 'unresponsive-server');
    eCheck.expect_namedValue('smtp:setTimeout', $_smtpprobe.CONNECT_TIMEOUT_MS);
    prober = new $_smtpprobe.SmtpProber(cci.credentials, cci.connInfo);
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
  thunkConsole(T);
  var eCheck = T.lazyLogger('check'),
      prober = null;

  var fireTimeout = thunkSmtpTimeouts(eCheck);
  var cci = makeCredsAndConnInfo();

  T.action(eCheck, 'create prober, see SSL error', function() {
    FawltySocketFactory.precommand(HOST, PORT, 'bad-security');
    eCheck.expect_namedValue('smtp:setTimeout', $_smtpprobe.CONNECT_TIMEOUT_MS);
    prober = new $_smtpprobe.SmtpProber(cci.credentials, cci.connInfo);
    prober.onresult = function(err) {
      eCheck.namedValue('probe result', err);
    };
    eCheck.expect_event('smtp:clearTimeout');
    eCheck.expect_namedValue('probe result', 'bad-security');
  });
});

const SMTP_GREETING = '220 localhsot ESMTP Fake';
const SMTP_EHLO_RESPONSE = '250 AUTH PLAIN';


function cannedLoginTest(T, RT, opts) {
  thunkConsole(T);
  var eCheck = T.lazyLogger('check');

  var fireTimeout = thunkSmtpTimeouts(eCheck),
      cci = makeCredsAndConnInfo(),
      prober;

  T.action('connect, get error, return', eCheck, function() {
    eCheck.expect_namedValue('smtp:setTimeout', $_smtpprobe.CONNECT_TIMEOUT_MS);
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
    prober = new $_smtpprobe.SmtpProber(cci.credentials, cci.connInfo);
    prober.onresult = function(err) {
      eCheck.namedValue('probe result', err);
    };
  });
};

TD.commonCase('bad username or password', function(T, RT) {
  cannedLoginTest(T, RT, {
    loginErrorString: '535 Authentication DENIED',
    expectResult: 'bad-user-or-pass',
  });
});

TD.commonCase('angry server', function(T, RT) {
  cannedLoginTest(T, RT, {
    ehloResponse: '500 go away!',
    // it will then say HELO, which we also hate, because we are angry.
    loginErrorString: '500 I said go away!',
    expectResult: 'server-problem',
  });
});


function run_test() {
  runMyTests(5);
}
