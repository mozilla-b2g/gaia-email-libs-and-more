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

TD.commonCase('POP3 UIDL unsupported', function(T, RT) {
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

TD.commonCase('account in use (pop3)', function(T, RT) {
  if (RT.envOptions.type === "pop3") {
    cannedLoginTest(T, RT, {
      loginErrorString: "-ERR [IN-USE] Your account is in use, try later.\r\n",
      expectResult: 'server-maintenance',
    });
  }
});

}); // end define
