/**
 * Test the IMAP and POP3 probers in isolation.
 *
 * None of these test actually establish a network connection.  They all use
 * FawltySocketFactory to generate canned failures.  We test timeouts by mocking
 * out the setTimeout/clearTimeout used by imap.js so we can log when timers
 * are set/cleared and we can control exactly when the timers fire.
 */

define(function(require) {

var LegacyGelamTest = require('./resources/legacy_gelamtest');
var logic = require('logic');
var proberShared = require('./resources/incoming_prober_shared');
var $fawlty = require('./resources/fault_injecting_socket');
var $th_main = require('./resources/th_main');
var $pop3Probe = require('pop3/probe');
var $imapProbe = require('imap/probe');
var imapclient = require('imap/client');
var $pop3 = require('pop3/pop3');
var $smtpProbe = require('smtp/probe');
var FawltySocketFactory = $fawlty.FawltySocketFactory;

var {
  thunkTimeouts, thrower, proberTimeout, constructProber, openResponse,
  badStarttlsResponse, capabilityResponse, makeCredsAndConnInfo,
  HOST, PORT, KEEP_ALIVE_TIMEOUT_MS,
  cannedLoginTest
} = proberShared;

return [

new LegacyGelamTest('timeout failure', function(T, RT) {
  $th_main.thunkConsoleForNonTestUniverse();
  var eCheck = T.lazyLogger('check'),
      prober = null;

  var fireTimeout = thunkTimeouts(eCheck);
  var cci = makeCredsAndConnInfo();

  T.action(eCheck, 'create prober', function() {
    FawltySocketFactory.precommand(HOST, PORT, 'unresponsive-server');
    eCheck.expect('incoming:setTimeout',  proberTimeout(RT));
    constructProber(RT, cci).catch(function(err) {
      eCheck.log('probe result', err);
    });
  });
  T.action(eCheck, 'trigger timeout', function() {
    eCheck.expect('incoming:clearTimeout');
    eCheck.expect('probe result',  'unresponsive-server');
    fireTimeout(0);
  });
}),

new LegacyGelamTest('SSL failure', function(T, RT) {
  $th_main.thunkConsoleForNonTestUniverse();
  var eCheck = T.lazyLogger('check'),
      prober = null;

  var fireTimeout = thunkTimeouts(eCheck);
  var cci = makeCredsAndConnInfo();

  T.action(eCheck, 'create prober, see SSL error', function() {
    FawltySocketFactory.precommand(HOST, PORT, 'bad-security');
    eCheck.expect('incoming:setTimeout',  proberTimeout(RT));
    constructProber(RT, cci).catch(function(err) {
      eCheck.log('probe result', err);
    });
    eCheck.expect('incoming:clearTimeout');
    eCheck.expect('probe result',  'bad-security');
  });
}),

new LegacyGelamTest('Proper SMTP credentials get passed through', (T, RT) => {
  $th_main.thunkConsoleForNonTestUniverse();
  var eCheck = T.lazyLogger('check'),
      prober = null;

  var fireTimeout = thunkTimeouts(eCheck);
  var cci = makeCredsAndConnInfo();

  T.action(eCheck, 'with custom SMTP creds', function() {
    cci.credentials.outgoingUsername = 'user1';
    cci.credentials.outgoingPassword = 'pass1';

    T.actor('SmtpClient').expect('connect', function (data) {
      return (data._auth.user === 'user1' &&
              data._auth.pass === 'pass1');
    });


    eCheck.expect('done');
    function done() {
      eCheck.log('done');
    }

    $smtpProbe.probeAccount(cci.credentials, cci.connInfo)
      .then(done, done);
  });

  T.action(eCheck, 'with matching incoming/outgoing creds', function() {
    cci.credentials.username = 'user1';
    cci.credentials.password = 'pass1';
    cci.credentials.outgoingUsername = undefined;
    cci.credentials.outgoingPassword = undefined;

    T.actor('SmtpClient').expect('connect', function (data) {
      return (data._auth.user === 'user1' &&
              data._auth.pass === 'pass1');
    });

    eCheck.expect('done');
    function done() {
      eCheck.log('done');
    }

    $smtpProbe.probeAccount(cci.credentials, cci.connInfo)
      .then(done, done);
  });
}),

new LegacyGelamTest('STARTTLS unsupported', function(T, RT) {
  $th_main.thunkConsoleForNonTestUniverse();
  var eCheck = T.lazyLogger('check'),
      prober = null;

  var fireTimeout = thunkTimeouts(eCheck);
  var cci = makeCredsAndConnInfo();

  cci.connInfo.port = PORT;
  cci.connInfo.crypto = 'starttls';

  T.action(eCheck, 'create prober, STARTTLS fails', function() {
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
    eCheck.expect('incoming:setTimeout',  proberTimeout(RT));
    constructProber(RT, cci).catch(function(err) {
      eCheck.log('probe result', err);
    });
    eCheck.expect('incoming:clearTimeout');
    eCheck.expect('probe result',  'bad-security');
  });
}),

new LegacyGelamTest('gmail user disabled error', function(T, RT) {
  cannedLoginTest(T, RT, {
    loginErrorString: (RT.envOptions.type === 'imap' ?
                       'NO [ALERT] Your account is not enabled for IMAP use.' :
                       '-ERR [SYS/PERM] Your account is not enabled for POP'),
    expectResult:
    (RT.envOptions.type === 'imap' ? 'imap-disabled' : 'pop3-disabled'),
  });
}),

new LegacyGelamTest('gmail domain disabled error', function(T, RT) {
  cannedLoginTest(T, RT, {
    loginErrorString:
    (RT.envOptions.type === 'imap' ?
     'NO [ALERT] IMAP access is disabled for your domain.' :
     '-ERR [SYS/PERM] POP access is disabled for your domain.'),
    expectResult:
    (RT.envOptions.type === 'imap' ? 'imap-disabled' : 'pop3-disabled'),
  });
}),

new LegacyGelamTest('server maintenance', function(T, RT) {
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
})

];

}); // end define
