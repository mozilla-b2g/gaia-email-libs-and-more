/**
 * Test the SMTP prober in isolation.
 *
 * Right now we cover:
 * - Timeout trying to talk to the server.
 * - SSL error trying to talk to the server.
 * - Auth failure.
 */

define(['rdcommon/testcontext', './resources/th_main',
        './resources/fault_injecting_socket', 'smtp/probe',
        'smtp/client', 'syncbase',
        'exports'],
       function($tc, $th_imap, $fawlty, $smtpprobe, $smtpclient,
                syncbase, exports) {
var FawltySocketFactory = $fawlty.FawltySocketFactory;

var TD = exports.TD = $tc.defineTestsFor(
  { id: 'test_smtp_prober' }, null, [$th_imap.TESTHELPER], ['app']);

function thunkSmtpTimeouts(lazyLogger) {
  var timeouts = [];
  $smtpclient.setTimeoutFunctions(
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
      emailAddress: 'username@domain',
      hostname: HOST,
      port: PORT,
      crypto: true,
    },
  };
}

TD.commonCase('timeout failure', function(T, RT) {
  $th_imap.thunkConsoleForNonTestUniverse();
  var eCheck = T.lazyLogger('check');
  var fireTimeout = thunkSmtpTimeouts(eCheck);
  var cci = makeCredsAndConnInfo();

  T.action(eCheck, 'create prober', function() {
    FawltySocketFactory.precommand(HOST, PORT, 'unresponsive-server');
    eCheck.expect_namedValue('smtp:setTimeout', syncbase.CONNECT_TIMEOUT_MS);
    $smtpprobe.probeAccount(cci.credentials, cci.connInfo).catch(function(err) {
      eCheck.namedValue('probe result', err);
    });
  });
  T.action(eCheck, 'trigger timeout', function() {
    eCheck.expect_event('smtp:clearTimeout');
    eCheck.expect_namedValue('probe result', 'unresponsive-server');
    fireTimeout(0);
  });
});

TD.commonCase('SSL failure', function(T, RT) {
  $th_imap.thunkConsoleForNonTestUniverse();
  var eCheck = T.lazyLogger('check');

  var fireTimeout = thunkSmtpTimeouts(eCheck);
  var cci = makeCredsAndConnInfo();

  T.action(eCheck, 'create prober, see SSL error', function() {
    FawltySocketFactory.precommand(HOST, PORT, 'bad-security');
    eCheck.expect_namedValue('smtp:setTimeout', syncbase.CONNECT_TIMEOUT_MS);
    $smtpprobe.probeAccount(cci.credentials, cci.connInfo).catch(function(err) {
      eCheck.namedValue('probe result', err);
    });
    eCheck.expect_event('smtp:clearTimeout');
    eCheck.expect_namedValue('probe result', 'bad-security');
  });
});

var SMTP_GREETING = '220 localhost ESMTP Fake\r\n';
var SMTP_EHLO_RESPONSE = '250 AUTH PLAIN\r\n';

TD.commonCase('STARTTLS unsupported', function(T, RT) {
  $th_imap.thunkConsoleForNonTestUniverse();
  var eCheck = T.lazyLogger('check');

  var fireTimeout = thunkSmtpTimeouts(eCheck);
  var cci = makeCredsAndConnInfo();

  cci.connInfo.port = 25;
  cci.connInfo.crypto = 'starttls';

  T.action(eCheck, 'create prober, see STARTTLS error', function() {
  FawltySocketFactory.precommand(
      HOST, cci.connInfo.port,
      {
        cmd: 'fake',
        data: SMTP_GREETING,
      },
      [
        {
          match: true,
          actions: [
            {
              cmd: 'fake-receive',
              data: SMTP_EHLO_RESPONSE
            },
          ],
        },
        {
          match: true,
          actions: [
            {
              cmd: 'fake-receive',
              data: '500 STARTTLS unsupported\r\n',
            }
          ],
        },
      ]);
      eCheck.expect_namedValue('smtp:setTimeout', syncbase.CONNECT_TIMEOUT_MS);
    $smtpprobe.probeAccount(cci.credentials, cci.connInfo).catch(function(err) {
      eCheck.namedValue('probe result', err);
    });
    eCheck.expect_event('smtp:clearTimeout');
    eCheck.expect_namedValue('probe result', 'bad-security');
  });
});

/**
 * Make sure that we fail if a server only supports HELO in a context where we
 * want to perform a startTLS upgrade.
 */
TD.commonCase('EHLO unsupported does not bypass startTLS', function(T, RT) {
  $th_imap.thunkConsoleForNonTestUniverse();
  var eCheck = T.lazyLogger('check');

  var fireTimeout = thunkSmtpTimeouts(eCheck);
  var cci = makeCredsAndConnInfo();

  cci.connInfo.port = 25;
  cci.connInfo.crypto = 'starttls';

  T.action(eCheck, 'create prober, see STARTTLS error', function() {
  FawltySocketFactory.precommand(
      HOST, cci.connInfo.port,
      {
        cmd: 'fake',
        data: SMTP_GREETING,
      },
      [
        {
          match: true,
          actions: [
            {
              cmd: 'fake-receive',
              data: '500 I hate EHLO\r\n',
            },
          ],
        },
      ]);
      eCheck.expect_namedValue('smtp:setTimeout', syncbase.CONNECT_TIMEOUT_MS);
    $smtpprobe.probeAccount(cci.credentials, cci.connInfo).catch(function(err) {
      eCheck.namedValue('probe result', err);
    });
    eCheck.expect_event('smtp:clearTimeout');
    eCheck.expect_namedValue('probe result', 'bad-security');
  });
});


function cannedLoginTest(T, RT, opts) {
  $th_imap.thunkConsoleForNonTestUniverse();
  var eCheck = T.lazyLogger('check');

  var fireTimeout = thunkSmtpTimeouts(eCheck),
      cci = makeCredsAndConnInfo();

  T.action('connect, get error, return', eCheck, function() {
    eCheck.expect_namedValue('smtp:setTimeout', syncbase.CONNECT_TIMEOUT_MS);
    eCheck.expect_event('smtp:clearTimeout');
    eCheck.expect_namedValue('probe result', opts.expectResult);
    var precommands = [
      {
        match: true,
        actions: [
          {
            cmd: 'fake-receive',
            data: opts.ehloResponse || SMTP_EHLO_RESPONSE
          },
        ],
      },
      {
        match: true,
        actions: [
          {
            cmd: 'fake-receive',
            data: opts.loginErrorString
          }
        ],
      },
    ];
    if (opts.precommands) {
      precommands = precommands.concat(opts.precommands);
    }
    FawltySocketFactory.precommand(
      HOST, PORT,
      {
        cmd: 'fake',
        data: SMTP_GREETING,
      }, precommands);
    $smtpprobe.probeAccount(cci.credentials, cci.connInfo)
      .then(function(result) {
        eCheck.namedValue('probe result', null);
      }).catch(function(err) {
        eCheck.namedValue('probe result', err);
      });
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

TD.commonCase('bad address', function(T, RT) {
  cannedLoginTest(T, RT, {
    loginErrorString: '200 Keep up the good work\r\n',
    precommands: [
      {
        match: /MAIL FROM:<username@domain>/ig,
        actions: [
          {
            cmd: 'fake-receive',
            data: '200 Continue\r\n',
          }
        ]
      },
      {
        match: /RCPT TO:<username@domain>/ig,
        actions: [
          {
            cmd: 'fake-receive',
            data: '554 Sender Address Rejected\r\n',
          }
        ]
      }
    ],
    expectResult: 'bad-address',
  });
});

TD.commonCase('good address', function(T, RT) {
  cannedLoginTest(T, RT, {
    loginErrorString: '200 Keep up the good work\r\n',
    precommands: [
      {
        match: /MAIL FROM:<username@domain>/ig,
        actions: [
          {
            cmd: 'fake-receive',
            data: '200 Continue\r\n',
          }
        ]
      },
      {
        match: /RCPT TO:<username@domain>/ig,
        actions: [
          {
            cmd: 'fake-receive',
            data: '200 rock on little buddy\r\n',
          }
        ]
      },
      {
        match: /DATA/ig,
        actions: [
          {
            cmd: 'fake-receive',
            data: '354 go ahead\r\n',
          }
        ]
      },
    ],
    expectResult: null,
  });
});


}); // end define
