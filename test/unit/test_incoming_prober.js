/**
 * Test the IMAP and POP3 probers in isolation.
 *
 * None of these test actually establish a network connection.  They all use
 * FawltySocketFactory to generate canned failures.  We test timeouts by mocking
 * out the setTimeout/clearTimeout used by imap.js so we can log when timers
 * are set/cleared and we can control exactly when the timers fire.
 */

define(['rdcommon/testcontext', './resources/th_main',
        './resources/incoming_prober_shared',
        './resources/fault_injecting_socket', 'imap/probe',
        'syncbase', 'slog',
        'pop3/probe', 'pop3/pop3', 'smtp/probe',
        'imap/client', 'exports'],
function($tc, $th_main, proberShared, $fawlty, $imapProbe,
         syncbase, slog, $pop3Probe, $pop3, $smtpProbe, imapclient, exports) {
var FawltySocketFactory = $fawlty.FawltySocketFactory;

var TD = exports.TD = $tc.defineTestsFor(
  { id: 'test_incoming_prober' }, null, [$th_main.TESTHELPER], ['app']);

var {
  thunkTimeouts, thrower, proberTimeout, constructProber, openResponse,
  badStarttlsResponse, capabilityResponse, makeCredsAndConnInfo,
  HOST, PORT, KEEP_ALIVE_TIMEOUT_MS,
  cannedLoginTest
} = proberShared;

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


    eCheck.expect_value('done');
    function done() {
      eCheck.value('done');
    }

    $smtpProbe.probeAccount(cci.credentials, cci.connInfo)
      .then(done, done);
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

    eCheck.expect_value('done');
    function done() {
      eCheck.value('done');
    }

    $smtpProbe.probeAccount(cci.credentials, cci.connInfo)
      .then(done, done);
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

  T.action(eCheck, 'create prober, STARTTLS fails', function() {
    var precommands = [];
    // IMAP currently does a CAPABILITY check even though it really is a waste
    // of effort.  Tracked on
    // https://github.com/whiteout-io/browserbox/issues/35
    if (RT.envOptions.type === 'imap') {
      precommands.push({
        match: /CAPABILITY/,
        actions: [
          {
            cmd: 'fake-receive',
            data: capabilityResponse(RT),
          },
        ],
      });
    }
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
  // Just IMAP from here on out
  if (RT.envOptions.type === 'pop3') {
    return;
  }
  T.action(eCheck, 'create prober, CAPABILITY claims no STARTTLS', function() {
    var precommands = [];
    // send a lie about
    precommands.push({
      match: /CAPABILITY/,
      actions: [
        {
          cmd: 'fake-receive',
          data: capabilityResponse(RT).replace('STARTTLS', 'BORT'),
        },
      ],
    });
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

TD.commonCase('gmail user disabled error', function(T, RT) {
  cannedLoginTest(T, RT, {
    loginErrorString: (RT.envOptions.type === 'imap' ?
                       'NO [ALERT] Your account is not enabled for IMAP use.' :
                       '-ERR [SYS/PERM] Your account is not enabled for POP'),
    expectResult:
    (RT.envOptions.type === 'imap' ? 'imap-disabled' : 'pop3-disabled'),
  });
});

TD.commonCase('gmail domain disabled error', function(T, RT) {
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
      // We now try to login and only produce the error after failing to login
      loginErrorString: 'NO I said disabled, dude',
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

}); // end define
