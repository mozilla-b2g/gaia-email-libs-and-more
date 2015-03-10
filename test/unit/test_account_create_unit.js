/**
 * Test the tryToCreateAccount ActiveSync and IMAP implementations in error
 * situations by stubbing everything out.  Success cases are tested by any of
 * the cases where we talk to a server whether it's fake or real.
 *
 * These tests don't need to be particularly complex.  The key things are to
 * make sure that we propagate errors through to callers and that in the case
 * of IMAP+SMTP we handle either of the two generating failures.
 */

define(function(require) {

var $accountcommon = require('accountcommon');
var $imapprobe = require('imap/probe');
var $pop3probe = require('pop3/probe');
var $smtpprobe = require('smtp/probe');
var $asproto = require('activesync/protocol');
var LegacyGelamTest = require('./resources/legacy_gelamtest');

////////////////////////////////////////////////////////////////////////////////
// Stubs!

var gNextIncomingProbeResult = null,
    gDelayIncomingProbeResult = false,
    gNextSmtpProbeResult = null,
    gNextActivesyncResult = null,
    gFakeIncomingConn = null;

$smtpprobe.probeAccount = function() {
  return new Promise(function(resolve, reject) {
    var err = gNextSmtpProbeResult;
    gNextSmtpProbeResult = null;
    if (err) {
      reject(err);
    } else {
      resolve({
        conn: null,
        timezoneOffset: 0
      });
    }
  });
};

$imapprobe.probeAccount =
$pop3probe.probeAccount = function() {
  return new Promise(function(resolve, reject) {
    var err = gNextIncomingProbeResult;
    var conn = gFakeIncomingConn;
    gNextIncomingProbeResult = null;
    gFakeIncomingConn = null;
    var go = function() {
      if (err) {
        reject(err);
      } else {
        resolve({
          conn: conn,
          timezoneOffset: 0
        });
      }
    };
    if (gDelayIncomingProbeResult) {
      window.setTimeout(go, 0);
    } else {
      go();
    }
  });
};

$asproto.Connection = function() {
  this.timeout = null;
};
$asproto.Connection.prototype = {
  open: function() {},
  connect: function(callback) {
    var self = this;
    window.setZeroTimeout(function() {
      callback(gNextActivesyncResult);
      gNextActivesyncResult = null;
    });
  },
};

var FakeUniverse = {
};

// All of these details shouldn't be used, so use null values so stub failures
// are obvious.
var FakeUserDetails = {
  displayName: null,
  emailAddress: null,
  password: null
};

var FakeIncomingDomainInfo = {
  type: null, // populated below
  incoming: {
    hostname: 'mail.example.com',
    port: null,
    socketType: null
  },
  outgoing: {
    hostname: 'smtp.example.com',
    port: null,
    socketType: null
  },
};

var FakeActivesyncDomainInfo = {
  type: 'activesync',
  incoming: {
    server: 'https://m.example.com/',
  },
};


////////////////////////////////////////////////////////////////////////////////

var testCases = [];

['imap', 'pop3'].forEach(function (type) {
  FakeIncomingDomainInfo.type = type + '+smtp';
  testCases.push(new LegacyGelamTest(type.toUpperCase() + ' tryToCreateAccount',
                                     function(T, RT) {
    var eCheck = T.lazyLogger('check');
    var errorMixtures = [
      { name: type + ' error only',
        incoming: 'unresponsive-server', smtp: null,
        reportAs: 'unresponsive-server',
        server: FakeIncomingDomainInfo.incoming.hostname },
      { name: 'smtp error only',
        incoming: null, smtp: 'unresponsive-server',
        reportAs: 'unresponsive-server',
        server: FakeIncomingDomainInfo.outgoing.hostname },
      { name: type + ' and smtp errors prioritize ' + type,
        incoming: 'server-problem', smtp: 'unresponsive-server',
        reportAs: 'server-problem',
        server: FakeIncomingDomainInfo.incoming.hostname },
      // same as above, but let SMTP resolve first to make sure we still
      // favor the correct error message
      { name: 'delayed ' + type + ' and smtp errors prioritize ' + type,
        incoming: 'server-problem', smtp: 'unresponsive-server',
        reportAs: 'server-problem',
        delayIncoming: true,
        server: FakeIncomingDomainInfo.incoming.hostname }
    ];

    errorMixtures.forEach(function(mix) {
      T.action(eCheck, mix.name, function() {
        gNextIncomingProbeResult = mix.incoming;
        gNextSmtpProbeResult = mix.smtp;
        gDelayIncomingProbeResult = mix.delayIncoming || false;
        if (!mix.incoming) {
          eCheck.expect('incoming.close()');
          gFakeIncomingConn = {
            close: function() {
              eCheck.log('incoming.close()');
            },
          };
        }

        eCheck.expect('err',  mix.reportAs);
        eCheck.expect('errDetails',  { server: mix.server });
        eCheck.expect('account',  null);

        $accountcommon.tryToManuallyCreateAccount(
          FakeUniverse, FakeUserDetails, FakeIncomingDomainInfo,
          function (err, account, errDetails) {
            eCheck.log('err', err);
            eCheck.log('errDetails', errDetails);
            eCheck.log('account', null);
          });
      });
    });
  }));
});

testCases.push(new LegacyGelamTest('ActiveSync tryToCreateAccount',
                                   function(T, RT) {
  var eCheck = T.lazyLogger('check');
  var errorMixtures = [
    { name: '401',
      err: new $asproto.HttpError('401zies', 401),
      reportAs: 'bad-user-or-pass',  server: 'https://m.example.com/' },
    { name: '403',
      err: new $asproto.HttpError('403zies', 403),
      reportAs: 'not-authorized',  server: 'https://m.example.com/' },
    { name: '500',
      err: new $asproto.HttpError('500zies', 500),
      reportAs: 'server-problem',  server: 'https://m.example.com/' },
    // XXX Timeout is disabled because it currently cascades into a certificate
    // check and other badness. See https://bugzil.la/1049135 and generally fix
    // it, please.
    /*
    { name: 'timeout',
      err: new Error('The server did not want to talk to us!'),
      reportAs: 'unresponsive-server',  server: 'https://m.example.com/' },
     */
  ];

  errorMixtures.forEach(function(mix) {
    T.action(eCheck, mix.name, function() {
      gNextActivesyncResult = mix.err;

      eCheck.expect('err',  mix.reportAs);
      eCheck.expect('account',  null);

      $accountcommon.tryToManuallyCreateAccount(
        FakeUniverse, FakeUserDetails, FakeActivesyncDomainInfo,
        function (err, account, errDetails) {
          eCheck.log('err', err);
          eCheck.log('account', null);
        });
    });
  });

}));

return testCases;

}); // end define
