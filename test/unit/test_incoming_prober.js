/**
 * Test the IMAP and POP3 probers in isolation.
 *
 * None of these test actually establish a network connection.  They all use
 * FawltySocketFactory to generate canned failures.  We test timeouts by mocking
 * out the setTimeout/clearTimeout used by imap.js so we can log when timers
 * are set/cleared and we can control exactly when the timers fire.
 */

define(['rdcommon/testcontext', './resources/th_main',
  './resources/fault_injecting_socket', 'imap/probe',
        'syncbase', 'slog',
  'pop3/probe', 'pop3/pop3', 'smtp/probe',
        'imap/client', 'exports'],
function($tc, $th_main, $fawlty, $imapProbe,
         syncbase, slog, $pop3Probe, $pop3, $smtpProbe, imapclient, exports) {
var FawltySocketFactory = $fawlty.FawltySocketFactory;

var TD = exports.TD = $tc.defineTestsFor(
  { id: 'test_incoming_prober' }, null, [$th_main.TESTHELPER], ['app']);

function thunkTimeouts(lazyLogger) {
  var timeouts = [];
  function thunkedSetTimeout(func, delay) {
    lazyLogger.namedValue('incoming:setTimeout', delay);
    return timeouts.push(func);
  }
  function thunkedClearTimeout() {
    lazyLogger.event('incoming:clearTimeout');
  }

  imapclient.setTimeoutFunctions(thunkedSetTimeout, thunkedClearTimeout);
  $pop3.setTimeoutFunctions(thunkedSetTimeout, thunkedClearTimeout);

  return function fireThunkedTimeout(index) {
    timeouts[index]();
    timeouts[index] = null;
  };
}

// Utility function for properly raising errors in promises.
function thrower(err) {
  console.error(err);
  throw err;
}

function proberTimeout(RT) {
  return syncbase.CONNECT_TIMEOUT_MS;
}
function constructProber(RT, cci) {
  var probeAccount = (RT.envOptions.type === "imap") ?
        $imapProbe.probeAccount : $pop3Probe.probeAccount;
  return probeAccount(cci.credentials, cci.connInfo);
}

function openResponse(RT) {
  if (RT.envOptions.type === "imap") {
    return '* OK IMAP rules, POP3 drools\r\n';
  } else if (RT.envOptions.type === "pop3") {
    return '+OK POP3 READY\r\n';
  }
}

function badStarttlsResponse(RT) {
  if (RT.envOptions.type === "imap") {
    return 'W1 BAD STARTTLS Unsupported\r\n';
  } else if (RT.envOptions.type === "pop3") {
    return '-ERR no starttls\r\n';
  }
}

function capabilityResponse(RT) {
  if (RT.envOptions.type === "imap") {
    return [
      '* CAPABILITY IMAP4rev1 LITERAL+ SASL-IR LOGIN-REFERRALS ID ENABLE IDLE' +
        ' STARTTLS AUTH=PLAIN',
      'W1 OK Pre-login capabilities listed, post-login capabilities have more.',
    ].join('\r\n') + '\r\n';
  } else if (RT.envOptions.type === "pop3") {
    return '+OK\r\n.\r\n';
  }
}

// Currently all the tests in here are completely fake; we never connect.
const HOST = 'localhost', PORT = 65535;

function makeCredsAndConnInfo() {
  return {
    credentials: {
      username: 'USERNAME',
      password: 'PASSWORD',
      outgoingPassword: 'SMTP-PASSWORD',
    },
    connInfo: {
      hostname: HOST,
      port: PORT,
      crypto: true,
    },
  };
}

TD.commonCase('timeout failure', function(T, RT) {
  $th_main.thunkConsoleForNonTestUniverse();
  var eCheck = T.lazyLogger('check'),
      prober = null;

  var fireTimeout = thunkTimeouts(eCheck);
  var cci = makeCredsAndConnInfo();

  T.action(eCheck, 'create prober', function() {
    FawltySocketFactory.precommand(HOST, PORT, 'unresponsive-server');
    eCheck.expect_namedValue('incoming:setTimeout', proberTimeout(RT));
    constructProber(RT, cci).catch(function(err) {
      eCheck.namedValue('probe result', err);
    });
  });
  T.action(eCheck, 'trigger timeout', function() {
    eCheck.expect_event('incoming:clearTimeout');
    eCheck.expect_namedValue('probe result', 'unresponsive-server');
    fireTimeout(0);
  });
});

TD.commonCase('SSL failure', function(T, RT) {
  $th_main.thunkConsoleForNonTestUniverse();
  var eCheck = T.lazyLogger('check'),
      prober = null;

  var fireTimeout = thunkTimeouts(eCheck);
  var cci = makeCredsAndConnInfo();

  T.action(eCheck, 'create prober, see SSL error', function() {
    FawltySocketFactory.precommand(HOST, PORT, 'bad-security');
    eCheck.expect_namedValue('incoming:setTimeout', proberTimeout(RT));
    constructProber(RT, cci).catch(function(err) {
      eCheck.namedValue('probe result', err);
    });
    eCheck.expect_event('incoming:clearTimeout');
    eCheck.expect_namedValue('probe result', 'bad-security');
  });
});

TD.commonCase('Proper SMTP credentials get passed through', function(T, RT) {
  $th_main.thunkConsoleForNonTestUniverse();
  var eCheck = T.lazyLogger('check'),
      prober = null;

  var fireTimeout = thunkTimeouts(eCheck);
  var cci = makeCredsAndConnInfo();

  var log = new slog.LogChecker(T, RT);

  T.action(eCheck, 'with custom SMTP creds', function() {
    cci.credentials.outgoingUsername = 'user1';
    cci.credentials.outgoingPassword = 'pass1';

    log.mustLog('smtp:connect', function (data) {
      return (data._auth.user === 'user1' &&
              data._auth.pass === 'pass1');
    });

    $smtpProbe.probeAccount(cci.credentials, cci.connInfo);
  });

  T.action(eCheck, 'with matching incoming/outgoing creds', function() {
    cci.credentials.username = 'user1';
    cci.credentials.password = 'pass1';
    cci.credentials.outgoingUsername = undefined;
    cci.credentials.outgoingPassword = undefined;

    log.mustLog('smtp:connect', function (data) {
      return (data._auth.user === 'user1' &&
              data._auth.pass === 'pass1');
    });

    $smtpProbe.probeAccount(cci.credentials, cci.connInfo);
  });
});

TD.commonCase('STARTTLS unsupported', function(T, RT) {
  $th_main.thunkConsoleForNonTestUniverse();
  var eCheck = T.lazyLogger('check'),
      prober = null;

  var fireTimeout = thunkTimeouts(eCheck);
  var cci = makeCredsAndConnInfo();

  cci.connInfo.port = PORT;
  cci.connInfo.crypto = 'starttls';

  T.action(eCheck, 'create prober, no STARTTLS response', function() {
    var precommands = [];
    precommands.push({
      match: /TLS/,
      actions: [
        {
          cmd: 'fake-receive',
          data: badStarttlsResponse(RT),
        }
      ],
    });
    FawltySocketFactory.precommand(
      HOST, cci.connInfo.port,
      {
        cmd: 'fake',
        data: openResponse(RT)
      },
      precommands);
    eCheck.expect_namedValue('incoming:setTimeout', proberTimeout(RT));
    constructProber(RT, cci).catch(function(err) {
      eCheck.namedValue('probe result', err);
    });
    eCheck.expect_event('incoming:clearTimeout');
    eCheck.expect_namedValue('probe result', 'bad-security');
  });
});

TD.commonCase('POP3 UIDL unsupported', function(T, RT) {
  if (RT.envOptions.type !== 'pop3') { return; }

  $th_main.thunkConsoleForNonTestUniverse();
  var eCheck = T.lazyLogger('check'),
      prober = null;

  var fireTimeout = thunkTimeouts(eCheck);
  var cci = makeCredsAndConnInfo();

  cci.connInfo.port = PORT;

  T.action(eCheck, 'respond to initial probes with nope', function() {
    var precommands = [];
    precommands.push({
      match: /AUTH/,
      actions: [
        {
          cmd: 'fake-receive',
          data: '+OK nope\r\n',
        },
      ],
    });
    precommands.push({
      match: /UIDL/,
      actions: [
        {
          cmd: 'fake-receive',
          data: '-ERR nope\r\n',
        },
      ],
    });
    precommands.push({
      match: /UIDL/,
      actions: [
        {
          cmd: 'fake-receive',
          data: '-ERR nope\r\n',
        },
      ],
    });
    FawltySocketFactory.precommand(
      HOST, PORT,
      {
        cmd: 'fake',
        data: '+OK hey\r\n',
      },
      precommands);
    eCheck.expect_namedValue('incoming:setTimeout', proberTimeout(RT));
    constructProber(RT, cci).catch(function(err) {
      eCheck.namedValue('probe result', err);
    });
    eCheck.expect_event('incoming:clearTimeout');
    eCheck.expect_namedValue('probe result', 'pop-server-not-great');
  });
});

TD.commonCase('POP3 TOP unsupported', function(T, RT) {
  if (RT.envOptions.type !== 'pop3') { return; }

  $th_main.thunkConsoleForNonTestUniverse();
  var eCheck = T.lazyLogger('check'),
      prober = null;

  var fireTimeout = thunkTimeouts(eCheck);
  var cci = makeCredsAndConnInfo();

  cci.connInfo.port = PORT;

  T.action(eCheck, 'respond to initial probes with nope', function() {
    var precommands = [];
    precommands.push({
      match: /AUTH/,
      actions: [
        {
          cmd: 'fake-receive',
          data: '+OK nope\r\n',
        },
      ],
    });
    precommands.push({
      match: /UIDL 1/,
      actions: [
        {
          cmd: 'fake-receive',
          data: '+OK\r\n',
        },
      ],
    });
    precommands.push({
      match: /TOP/,
      actions: [
        {
          cmd: 'fake-receive',
          data: '-ERR nope\r\n',
        },
      ],
    });
    FawltySocketFactory.precommand(
      HOST, PORT,
      {
        cmd: 'fake',
        data: '+OK hey\r\n',
      },
      precommands);
    eCheck.expect_namedValue('incoming:setTimeout', proberTimeout(RT));
    constructProber(RT, cci).catch(function(err) {
      eCheck.namedValue('probe result', err);
    });
    eCheck.expect_event('incoming:clearTimeout');
    eCheck.expect_namedValue('probe result', 'pop-server-not-great');
  });
});


/**
 * Attempt to connect with SASL AUTH first, skipping APOP because
 * there was no greeting timestamp. Successfully auth with USER/PASS
 * and make sure we report that's the one that worked.
 */
TD.commonCase('POP3 selects preferredAuthMethod', function(T, RT) {
  if (RT.envOptions.type !== 'pop3') { return; }

  $th_main.thunkConsoleForNonTestUniverse();
  var eCheck = T.lazyLogger('check'),
      prober = null;

  var fireTimeout = thunkTimeouts(eCheck);
  var cci = makeCredsAndConnInfo();

  cci.connInfo.port = PORT;

  T.action(eCheck, 'works with USER-PASS auth', function() {
    var precommands = [];
    precommands.push({
      match: /AUTH/,
      actions: [
        {
          cmd: 'fake-receive',
          data: '-ERR\r\n',
        },
      ],
    });
    precommands.push({
      match: /USER/,
      actions: [
        {
          cmd: 'fake-receive',
          data: '+OK\r\n',
        },
      ],
    });
    precommands.push({
      match: /PASS/,
      actions: [
        {
          cmd: 'fake-receive',
          data: '+OK\r\n',
        },
      ],
    });
    precommands.push({
      match: /UIDL 1/,
      actions: [
        {
          cmd: 'fake-receive',
          data: '+OK\r\n',
        },
      ],
    });
    precommands.push({
      match: /TOP 1/,
      actions: [
        {
          cmd: 'fake-receive',
          data: '+OK\r\n.\r\n',
        },
      ],
    });
    FawltySocketFactory.precommand(
      HOST, PORT,
      {
        cmd: 'fake',
        data: '+OK hey\r\n',
      },
      precommands);
    eCheck.expect_namedValue('incoming:setTimeout', proberTimeout(RT));
    constructProber(RT, cci).then(function(info) {
      eCheck.namedValue('authMethod', info.conn.authMethod);
    }, thrower);
    eCheck.expect_event('incoming:clearTimeout');
    eCheck.expect_namedValue('authMethod', 'user-pass');
  });
});


/**
 * Ensure that APOP authentication works properly.
 */
TD.commonCase('POP3 APOP', function(T, RT) {
  if (RT.envOptions.type !== 'pop3') { return; }

  $th_main.thunkConsoleForNonTestUniverse();
  var eCheck = T.lazyLogger('check'),
      prober = null;

  var fireTimeout = thunkTimeouts(eCheck);
  var cci = makeCredsAndConnInfo();

  cci.connInfo.port = PORT;

  T.action(eCheck, 'works with APOP', function() {
    var precommands = [];
    precommands.push({
      match: /APOP/,
      actions: [
        {
          cmd: 'fake-receive',
          data: '+OK\r\n',
        },
      ],
    });
    precommands.push({
      match: /UIDL 1/,
      actions: [
        {
          cmd: 'fake-receive',
          data: '+OK\r\n',
        },
      ],
    });
    precommands.push({
      match: /TOP 1/,
      actions: [
        {
          cmd: 'fake-receive',
          data: '+OK\r\n.\r\n',
        },
      ],
    });
    FawltySocketFactory.precommand(
      HOST, PORT,
      {
        cmd: 'fake',
        data: '+OK POP3 Ready <apop@apop>\r\n',
      },
      precommands);
    eCheck.expect_namedValue('incoming:setTimeout', proberTimeout(RT));
    constructProber(RT, cci).then(function(info) {
      eCheck.namedValue('authMethod', info.conn.authMethod);
    });
    eCheck.expect_event('incoming:clearTimeout');
    eCheck.expect_namedValue('authMethod', 'apop');
  });
});


/**
 * Some servers (ex: aol.com) will hang-up on us on an auth error with a bad
 * password.
 */
TD.commonCase('POP3 bad creds on server that hangs up', function(T, RT) {
  if (RT.envOptions.type !== 'pop3') { return; }

  $th_main.thunkConsoleForNonTestUniverse();
  var eCheck = T.lazyLogger('check'),
      prober = null;

  var fireTimeout = thunkTimeouts(eCheck);
  var cci = makeCredsAndConnInfo();

  cci.connInfo.port = PORT;

  T.action(eCheck, 'hangup gives bad-user-or-pass', function() {
    var precommands = [];
    precommands.push({
      match: /AUTH/,
      actions: [
        {
          cmd: 'fake-receive',
          data: '-ERR\r\n',
        },
        {
          cmd: 'instant-close',
        }
      ],
    });
    FawltySocketFactory.precommand(
      HOST, PORT,
      {
        cmd: 'fake',
        data: '+OK hey\r\n',
      },
      precommands);
    eCheck.expect_namedValue('incoming:setTimeout', proberTimeout(RT));
    constructProber(RT, cci).catch(function(err) {
      eCheck.namedValue('err', err);
    });
    eCheck.expect_event('incoming:clearTimeout');
    eCheck.expect_namedValue('err', 'bad-user-or-pass');
  });
});


var KEEP_ALIVE_TIMEOUT_MS = 10000;

function cannedLoginTest(T, RT, opts) {
  $th_main.thunkConsoleForNonTestUniverse();
  var eCheck = T.lazyLogger('check');

  var fireTimeout = thunkTimeouts(eCheck),
      cci = makeCredsAndConnInfo(),
      prober;

  T.action('connect, get error, return', eCheck, function() {
    eCheck.expect_namedValue('incoming:setTimeout', proberTimeout(RT));
    eCheck.expect_event('incoming:clearTimeout');
    eCheck.expect_namedValue('probe result', opts.expectResult);
    // Even though we will fail to login, from the IMAP connection's
    // perspective we won't want the connection to die.
    // ...And now I've restored the original event functionality.
    //eCheck.expect_namedValue('incoming:setTimeout', KEEP_ALIVE_TIMEOUT_MS);
    var precommands = [];

    if (RT.envOptions.type === 'pop3') {
      // If SASL AUTH fails, POP3 just tries USER blindly.
      // So push a failing SASL auth here, and then we'll respond to
      // the login error after USER.
      precommands.push({
          match: true,
          actions: [
            {
              cmd: 'fake-receive',
              data: '-ERR\r\n',
            },
          ],
      });
    } else { // IMAP
      precommands.push({
          match: /CAPABILITY/,
          actions: [
            {
              cmd: 'fake-receive',
              data: opts.capabilityResponse || capabilityResponse(RT),
            },
          ],
      });
    }
    precommands.push({
      match: true,
      actions: [
        {
          cmd: 'fake-receive',
          data: (RT.envOptions.type === 'imap' ? 'W2 OK\r\nW3 ' : '-ERR ') +
            opts.loginErrorString + '\r\n',
        }
      ],
    });

    FawltySocketFactory.precommand(
      HOST, PORT,
      {
        cmd: 'fake',
        data: opts.openResponse || openResponse(RT),
      },
      precommands);
    constructProber(RT, cci).catch(function(err) {
      eCheck.namedValue('probe result', err);
    });
  });
};

TD.commonCase('gmail 2-factor auth error', function(T, RT) {
  cannedLoginTest(T, RT, {
    loginErrorString: (RT.envOptions.type === 'imap' ?
                       'NO [ALERT] Application-specific password required' :
                       '-ERR [AUTH] Application-specific password required'),
    expectResult: 'needs-app-pass',
  });
});

TD.commonCase('gmail IMAP user disabled error', function(T, RT) {
  cannedLoginTest(T, RT, {
    loginErrorString: (RT.envOptions.type === 'imap' ?
                       'NO [ALERT] Your account is not enabled for IMAP use.' :
                       '-ERR [SYS/PERM] Your account is not enabled for POP'),
    expectResult:
    (RT.envOptions.type === 'imap' ? 'imap-disabled' : 'pop3-disabled'),
  });
});

TD.commonCase('gmail IMAP domain disabled error', function(T, RT) {
  cannedLoginTest(T, RT, {
    loginErrorString:
    (RT.envOptions.type === 'imap' ?
     'NO [ALERT] IMAP access is disabled for your domain.' :
     '-ERR [SYS/PERM] POP access is disabled for your domain.'),
    expectResult:
    (RT.envOptions.type === 'imap' ? 'imap-disabled' : 'pop3-disabled'),
  });
});

TD.commonCase('server maintenance', function(T, RT) {
  if (RT.envOptions.type === "imap") {
    cannedLoginTest(T, RT, {
      openResponse: openResponse(RT).replace('AUTH=PLAIN', 'LOGINDISABLED'),
      capabilityResponse: capabilityResponse(RT).replace('AUTH=PLAIN',
                                                         'LOGINDISABLED'),
      // we won't get to the login string
      loginErrorString: null,
      expectResult: 'server-maintenance',
    });
  } else {
    cannedLoginTest(T, RT, {
      openResponse: "-ERR [SYS] System in use...\r\n",
      capabilityResponse: "-ERR [SYS] System in use...\r\n",
      // we won't get to the login string
      loginErrorString: null,
      expectResult: 'server-maintenance',
    });
  }
});

TD.commonCase('account in use (pop3)', function(T, RT) {
  if (RT.envOptions.type === "pop3") {
    cannedLoginTest(T, RT, {
      loginErrorString: "-ERR [IN-USE] Your account is in use, try later.\r\n",
      expectResult: 'server-maintenance',
    });
  }
});

/**
 * Test the timezone parsing logic from received headers that is used by the
 * timezone offset calculation logic.
 */
TD.commonCase('timezone extraction unit', function(T, RT) {
  if (RT.envOptions.type === "imap") {
    $th_main.thunkConsoleForNonTestUniverse();
    var eCheck = T.lazyLogger('check');
    var caseData = [
      {
        name: '2nd',
        value: 'from 127.0.0.1  (EHLO lists.mozilla.org) (63.245.216.66)\n' +
          '  by mta1310.mail.gq1.yahoo.com with SMTP; ' +
          'Wed, 09 Jan 2013 05:46:19 -0800',
        tzHours: -8
      }
    ];

    caseData.forEach(function(data) {
      T.check(data.name, eCheck, function() {
        eCheck.expect_namedValue('tzHours', data.tzHours);
        var tz = $imapProbe.extractTZFromString(data.value);
        eCheck.namedValue('tzHours', tz && tz / (60 * 60 * 1000));
      });
    });
  }
});

}); // end define
