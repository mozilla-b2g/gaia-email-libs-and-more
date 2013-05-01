/**
 * Test the tryToCreateAccount ActiveSync and IMAP implementations in error
 * situations by stubbing everything out.  Success cases are tested by any of
 * the cases where we talk to a server whether it's fake or real.
 *
 * These tests don't need to be particularly complex.  The key things are to
 * make sure that we propagate errors through to callers and that in the case
 * of IMAP+SMTP we handle either of the two generating failures.
 */

define(['rdcommon/testcontext', './resources/th_main',
        'mailapi/accountcommon',
        'mailapi/imap/probe', 'mailapi/smtp/probe', 'activesync/protocol',
        'exports'],
       function($tc, $th_imap,
                $accountcommon, $imapprobe, $smtpprobe, $asproto, exports) {

var TD = exports.TD = $tc.defineTestsFor(
  { id: 'test_account_create_unit' }, null, [$th_imap.TESTHELPER], ['app']);

////////////////////////////////////////////////////////////////////////////////
// Stubs!

var gNextImapProbeResult = null,
    gNextSmtpProbeResult = null,
    gNextActivesyncResult = null,
    gFakeImapConn = null;

$imapprobe.ImapProber = function() {
  var self = this;
  this.onresult = null;
  window.setZeroTimeout(function() {
    self.onresult(gNextImapProbeResult, gFakeImapConn,
                  gNextImapProbeResult && { server: 'imap.example.com' });
    gNextImapProbeResult = null;
    gFakeImapConn = null;
  });
};

$smtpprobe.SmtpProber = function() {
  var self = this;
  this.onresult = null;
  window.setZeroTimeout(function() {
    self.onresult(gNextSmtpProbeResult,
                  gNextSmtpProbeResult && { server: 'smtp.example.com' });
    gNextSmtpProbeResult = null;
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

var FakeImapDomainInfo = {
  type: 'imap+smtp',
  incoming: {
    hostname: null,
    port: null,
    socketType: null
  },
  outgoing: {
    hostname: null,
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

TD.commonCase('IMAP tryToCreateAccount', function(T, RT) {
  var eCheck = T.lazyLogger('check');
  var errorMixtures = [
    { name: 'imap error only',
      imap: 'unresponsive-server', smtp: null,
      reportAs: 'unresponsive-server',  server: 'imap.example.com' },
    { name: 'smtp error only',
      imap: null, smtp: 'unresponsive-server',
      reportAs: 'unresponsive-server', server: 'smtp.example.com' },
    { name: 'imap and smtp errors prioritize imap',
      imap: 'server-problem', smtp: 'unresponsive-server',
      reportAs: 'server-problem', server: 'imap.example.com' },
  ];

  errorMixtures.forEach(function(mix) {
    T.action(eCheck, mix.name, function() {
      gNextImapProbeResult = mix.imap;
      gNextSmtpProbeResult = mix.smtp;
      if (!mix.imap) {
        eCheck.expect_event('imap.die()');
        gFakeImapConn = {
          die: function() {
            eCheck.event('imap.die()');
          },
        };
      }

      eCheck.expect_namedValue('err', mix.reportAs);
      eCheck.expect_namedValue('account', null);
      eCheck.expect_namedValue('errServer', mix.server);

      $accountcommon.tryToManuallyCreateAccount(
        FakeUniverse, FakeUserDetails, FakeImapDomainInfo,
        function (err, account, errDetails) {
          eCheck.namedValue('err', err);
          eCheck.namedValue('account', null);
          eCheck.namedValue('errServer', errDetails && errDetails.server);
        });
    });
  });
});

TD.commonCase('ActiveSync tryToCreateAccount', function(T, RT) {
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
    { name: 'timeout',
      err: new Error('The server did not want to talk to us!'),
      reportAs: 'unresponsive-server',  server: 'https://m.example.com/' },
  ];

  errorMixtures.forEach(function(mix) {
    T.action(eCheck, mix.name, function() {
      gNextActivesyncResult = mix.err;

      eCheck.expect_namedValue('err', mix.reportAs);
      eCheck.expect_namedValue('account', null);
      eCheck.expect_namedValue('errServer', mix.server);

      $accountcommon.tryToManuallyCreateAccount(
        FakeUniverse, FakeUserDetails, FakeActivesyncDomainInfo,
        function (err, account, errDetails) {
          eCheck.namedValue('err', err);
          eCheck.namedValue('account', null);
          eCheck.namedValue('errServer', errDetails && errDetails.server);
        });
    });
  });

});

}); // end define
