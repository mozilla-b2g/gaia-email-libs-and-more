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

new LegacyGelamTest('POP3 UIDL unsupported', function(T, RT) {
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
    eCheck.expect('incoming:setTimeout',  proberTimeout(RT));
    constructProber(RT, cci).catch(function(err) {
      eCheck.log('probe result', err);
    });
    eCheck.expect('incoming:clearTimeout');
    eCheck.expect('probe result',  'pop-server-not-great');
  });
}),

new LegacyGelamTest('POP3 TOP unsupported', function(T, RT) {
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
    eCheck.expect('incoming:setTimeout',  proberTimeout(RT));
    constructProber(RT, cci).catch(function(err) {
      eCheck.log('probe result', err);
    });
    eCheck.expect('incoming:clearTimeout');
    eCheck.expect('probe result',  'pop-server-not-great');
  });
}),


/**
 * Attempt to connect with SASL AUTH first, skipping APOP because
 * there was no greeting timestamp. Successfully auth with USER/PASS
 * and make sure we report that's the one that worked.
 */
new LegacyGelamTest('POP3 selects preferredAuthMethod', function(T, RT) {
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
    eCheck.expect('incoming:setTimeout',  proberTimeout(RT));
    constructProber(RT, cci).then(function(info) {
      eCheck.log('authMethod', info.conn.authMethod);
    }, thrower);
    eCheck.expect('incoming:clearTimeout');
    eCheck.expect('authMethod',  'user-pass');
  });
}),


/**
 * Ensure that APOP authentication works properly.
 */
new LegacyGelamTest('POP3 APOP', function(T, RT) {
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
    eCheck.expect('incoming:setTimeout',  proberTimeout(RT));
    constructProber(RT, cci).then(function(info) {
      eCheck.log('authMethod', info.conn.authMethod);
    });
    eCheck.expect('incoming:clearTimeout');
    eCheck.expect('authMethod',  'apop');
  });
}),


/**
 * Some servers (ex: aol.com) will hang-up on us on an auth error with a bad
 * password.
 */
new LegacyGelamTest('POP3 bad creds on server that hangs up', function(T, RT) {
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
    eCheck.expect('incoming:setTimeout',  proberTimeout(RT));
    constructProber(RT, cci).catch(function(err) {
      eCheck.log('err', err);
    });
    eCheck.expect('incoming:clearTimeout');
    eCheck.expect('err',  'bad-user-or-pass');
  });
}),

new LegacyGelamTest('account in use (pop3)', function(T, RT) {
  if (RT.envOptions.type === "pop3") {
    cannedLoginTest(T, RT, {
      loginErrorString: "-ERR [IN-USE] Your account is in use, try later.\r\n",
      expectResult: 'server-maintenance',
    });
  }
})

];

}); // end define
