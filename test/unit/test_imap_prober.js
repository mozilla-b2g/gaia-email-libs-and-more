/**
 * Test the IMAP prober in isolation.
 *
 * None of these test actually establish a network connection.  They all use
 * FawltySocketFactory to generate canned failures.  We test timeouts by mocking
 * out the setTimeout/clearTimeout used by imap.js so we can log when timers
 * are set/cleared and we can control exactly when the timers fire.
 */

define(['rdcommon/testcontext', 'mailapi/testhelper',
        './resources/fault_injecting_socket', 'mailapi/imap/probe', 'imap',
        'exports'],
       function($tc, $th_imap, $fawlty, $probe, $imap, exports) {
var FawltySocketFactory = $fawlty.FawltySocketFactory;

var TD = exports.TD = $tc.defineTestsFor(
  { id: 'test_imap_prober' }, null, [$th_imap.TESTHELPER], ['app']);

function thunkImapTimeouts(lazyLogger) {
  var timeouts = [];
  $imap.TEST_useTimeoutFuncs(
    function thunkedSetTimeout(func, delay) {
      lazyLogger.namedValue('imap:setTimeout', delay);
      return timeouts.push(func);
    },
    function thunkedClearTimeout() {
      lazyLogger.event('imap:clearTimeout');
    });
  return function fireThunkedTimeout(index) {
    timeouts[index]();
    timeouts[index] = null;
  };
}

// Currently all the tests in here are completely fake; we never connect.
const HOST = 'localhost', PORT = 143;

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
  $th_imap.thunkConsoleForNonTestUniverse();
  var eCheck = T.lazyLogger('check'),
      prober = null;

  var fireTimeout = thunkImapTimeouts(eCheck);
  var cci = makeCredsAndConnInfo();

  T.action(eCheck, 'create prober', function() {
    FawltySocketFactory.precommand(HOST, PORT, 'unresponsive-server');
    eCheck.expect_namedValue('imap:setTimeout', $probe.CONNECT_TIMEOUT_MS);
    prober = new $probe.ImapProber(cci.credentials, cci.connInfo,
                                    eCheck._logger);
    prober.onresult = function(err) {
      eCheck.namedValue('probe result', err);
    };
  });
  T.action(eCheck, 'trigger timeout', function() {
    eCheck.expect_event('imap:clearTimeout');
    eCheck.expect_namedValue('probe result', 'unresponsive-server');
    fireTimeout(0);
  });
});

TD.commonCase('SSL failure', function(T, RT) {
  $th_imap.thunkConsoleForNonTestUniverse();
  var eCheck = T.lazyLogger('check'),
      prober = null;

  var fireTimeout = thunkImapTimeouts(eCheck);
  var cci = makeCredsAndConnInfo();

  T.action(eCheck, 'create prober, see SSL error', function() {
    FawltySocketFactory.precommand(HOST, PORT, 'bad-security');
    eCheck.expect_namedValue('imap:setTimeout', $probe.CONNECT_TIMEOUT_MS);
    prober = new $probe.ImapProber(cci.credentials, cci.connInfo,
                                    eCheck._logger);
    prober.onresult = function(err) {
      eCheck.namedValue('probe result', err);
    };
    eCheck.expect_event('imap:clearTimeout');
    eCheck.expect_namedValue('probe result', 'bad-security');
  });
});


const OPEN_RESPONSE =
  '* OK [CAPABILITY IMAP4rev1 LITERAL+ SASL-IR LOGIN-REFERRALS ID ENABLE IDLE STARTTLS AUTH=PLAIN] Dovecot ready.\r\n';
const CAPABILITY_RESPONSE = [
  '* CAPABILITY IMAP4rev1 LITERAL+ SASL-IR LOGIN-REFERRALS ID ENABLE IDLE STARTTLS AUTH=PLAIN',
  'A1 OK Pre-login capabilities listed, post-login capabilities have more.',
].join('\r\n') + '\r\n';

var KEEP_ALIVE_TIMEOUT_MS = 10000;

function cannedLoginTest(T, RT, opts) {
  $th_imap.thunkConsoleForNonTestUniverse();
  var eCheck = T.lazyLogger('check');

  var fireTimeout = thunkImapTimeouts(eCheck),
      cci = makeCredsAndConnInfo(),
      prober;

  T.action('connect, get error, return', eCheck, function() {
    eCheck.expect_namedValue('imap:setTimeout', $probe.CONNECT_TIMEOUT_MS);
    // the keep-alive timer keeps getting reset is what is up
    eCheck.expect_event('imap:clearTimeout');
    eCheck.expect_event('imap:clearTimeout');
    eCheck.expect_event('imap:clearTimeout');
    if (opts.loginErrorString) {
      eCheck.expect_event('imap:clearTimeout');
      eCheck.expect_event('imap:clearTimeout');
    }
    eCheck.expect_namedValue('probe result', opts.expectResult);
    // Even though we will fail to login, from the IMAP connection's
    // perspective we won't want the connection to die.
    // ...And now I've restored the original event functionality.
    //eCheck.expect_namedValue('imap:setTimeout', KEEP_ALIVE_TIMEOUT_MS);
    FawltySocketFactory.precommand(
      HOST, PORT,
      {
        cmd: 'fake',
        data: opts.openResponse || OPEN_RESPONSE,
      },
      [
        opts.capabilityResponse || CAPABILITY_RESPONSE,
        'A2 ' + opts.loginErrorString + '\r\n',
      ]);
    prober = new $probe.ImapProber(cci.credentials, cci.connInfo,
                                    eCheck._logger);
    prober.onresult = function(err) {
      eCheck.namedValue('probe result', err);
    };
  });
};

TD.commonCase('gmail 2-factor auth error', function(T, RT) {
  cannedLoginTest(T, RT, {
    loginErrorString: 'NO [ALERT] Application-specific password required',
    expectResult: 'needs-app-pass',
  });
});

TD.commonCase('gmail IMAP user disabled error', function(T, RT) {
  cannedLoginTest(T, RT, {
    loginErrorString: 'NO [ALERT] Your account is not enabled for IMAP use.',
    expectResult: 'imap-disabled',
  });
});

TD.commonCase('gmail IMAP domain disabled error', function(T, RT) {
  cannedLoginTest(T, RT, {
    loginErrorString: 'NO [ALERT] IMAP access is disabled for your domain.',
    expectResult: 'imap-disabled',
  });
});

TD.commonCase('server maintenance', function(T, RT) {
  cannedLoginTest(T, RT, {
    openResponse: OPEN_RESPONSE.replace('AUTH=PLAIN', 'LOGINDISABLED'),
    capabilityResponse: CAPABILITY_RESPONSE.replace('AUTH=PLAIN',
                                                    'LOGINDISABLED'),
    // we won't get to the login string
    loginErrorString: null,
    expectResult: 'server-maintenance',
  });
});

/**
 * Test the timezone parsing logic from received headers that is used by the
 * timezone offset calculation logic.
 */
TD.commonCase('timezone extraction unit', function(T, RT) {
  $th_imap.thunkConsoleForNonTestUniverse();
  var eCheck = T.lazyLogger('check');
  var caseData = [
    {
      name: '2nd',
      headers: [
        { key: 'received',
          value: 'from 127.0.0.1  (EHLO lists.mozilla.org) (63.245.216.66)\n' +
            '  by mta1310.mail.gq1.yahoo.com with SMTP; ' +
            'Wed, 09 Jan 2013 05:46:19 -0800' },
      ],
      tzHours: -8
    }
  ];

  caseData.forEach(function(data) {
    T.check(data.name, eCheck, function() {
      eCheck.expect_namedValue('tzHours', data.tzHours);
      var tz = $probe._extractTZFromHeaders(data.headers);
      eCheck.namedValue('tzHours', tz && tz / (60 * 60 * 1000));
    });
  });
});

}); // end define
