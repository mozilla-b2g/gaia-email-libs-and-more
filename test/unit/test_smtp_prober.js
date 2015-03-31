/**
 * Test the SMTP prober in isolation.
 *
 * Right now we cover:
 * - Timeout trying to talk to the server.
 * - SSL error trying to talk to the server.
 * - Auth failure.
 */

define(function(require, exports) {

var LegacyGelamTest = require('./resources/legacy_gelamtest');
var logic = require('logic');
var $th_imap = require('./resources/th_main');
var $fawlty = require('./resources/fault_injecting_socket');
var $smtpprobe = require('smtp/probe');
var $smtpclient = require('smtp/client');
var syncbase = require('syncbase');
var FawltySocketFactory = $fawlty.FawltySocketFactory;

function thunkSmtpTimeouts(lazyLogger) {
  var timeouts = [];
  $smtpclient.setTimeoutFunctions(
    function thunkedSetTimeout(func, delay) {
      lazyLogger.log('smtp:setTimeout', delay);
      return timeouts.push(func);
    },
    function thunkedClearTimeout() {
      lazyLogger.log('smtp:clearTimeout');
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


var allTests = [];

function commonCase(name, fn) {
  allTests.push(new LegacyGelamTest(name, fn));
}

commonCase('timeout failure', function(T, RT) {
  $th_imap.thunkConsoleForNonTestUniverse();
  var eCheck = T.lazyLogger('check');
  var fireTimeout = thunkSmtpTimeouts(eCheck);
  var cci = makeCredsAndConnInfo();

  T.action(eCheck, 'create prober', function() {
    FawltySocketFactory.precommand(HOST, PORT, 'unresponsive-server');
    eCheck.expect('smtp:setTimeout',  syncbase.CONNECT_TIMEOUT_MS);
    $smtpprobe.probeAccount(cci.credentials, cci.connInfo).catch(function(err) {
      eCheck.log('probe result', err);
    });
  });
  T.action(eCheck, 'trigger timeout', function() {
    eCheck.expect('smtp:clearTimeout');
    eCheck.expect('probe result',  'unresponsive-server');
    fireTimeout(0);
  });
});

commonCase('SSL failure', function(T, RT) {
  $th_imap.thunkConsoleForNonTestUniverse();
  var eCheck = T.lazyLogger('check');

  var fireTimeout = thunkSmtpTimeouts(eCheck);
  var cci = makeCredsAndConnInfo();

  T.action(eCheck, 'create prober, see SSL error', function() {
    FawltySocketFactory.precommand(HOST, PORT, 'bad-security');
    eCheck.expect('smtp:setTimeout',  syncbase.CONNECT_TIMEOUT_MS);
    $smtpprobe.probeAccount(cci.credentials, cci.connInfo).catch(function(err) {
      eCheck.log('probe result', err);
    });
    eCheck.expect('smtp:clearTimeout');
    eCheck.expect('probe result',  'bad-security');
  });
});

var SMTP_GREETING = '220 localhost ESMTP Fake\r\n';
var SMTP_EHLO_RESPONSE = '250 AUTH PLAIN\r\n';

commonCase('STARTTLS unsupported', function(T, RT) {
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
      eCheck.expect('smtp:setTimeout',  syncbase.CONNECT_TIMEOUT_MS);
    $smtpprobe.probeAccount(cci.credentials, cci.connInfo).catch(function(err) {
      eCheck.log('probe result', err);
    });
    eCheck.expect('smtp:clearTimeout');
    eCheck.expect('probe result',  'bad-security');
  });
});

/**
 * Make sure that we fail if a server only supports HELO in a context where we
 * want to perform a startTLS upgrade.
 */
commonCase('EHLO unsupported does not bypass startTLS', function(T, RT) {
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
      eCheck.expect('smtp:setTimeout',  syncbase.CONNECT_TIMEOUT_MS);
    $smtpprobe.probeAccount(cci.credentials, cci.connInfo).catch(function(err) {
      eCheck.log('probe result', err);
    });
    eCheck.expect('smtp:clearTimeout');
    eCheck.expect('probe result',  'bad-security');
  });
});


function cannedLoginTest(T, RT, opts) {
  $th_imap.thunkConsoleForNonTestUniverse();
  var eCheck = T.lazyLogger('check');

  var fireTimeout = thunkSmtpTimeouts(eCheck),
      cci = makeCredsAndConnInfo();

  if (opts.mutateConnInfo) {
    opts.mutateConnInfo(cci);
  }

  T.action('connect, get error, return', eCheck, function() {
    if (opts.expectFunc) {
      opts.expectFunc();
    }
    if (!opts.willNotMakeConnection) {
      eCheck.expect('smtp:setTimeout',  syncbase.CONNECT_TIMEOUT_MS);
      eCheck.expect('smtp:clearTimeout');
    }
    eCheck.expect('probe result',  opts.expectResult);
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
    if (!opts.willNotMakeConnection) {
      FawltySocketFactory.precommand(
        HOST, PORT,
        {
          cmd: 'fake',
          data: SMTP_GREETING,
        }, precommands);
    }
    $smtpprobe.probeAccount(cci.credentials, cci.connInfo)
      .then(function(result) {
        eCheck.log('probe result', null);
      }).catch(function(err) {
        eCheck.log('probe result', err);
      });
  });
};

commonCase('bad username or password', function(T, RT) {
  cannedLoginTest(T, RT, {
    loginErrorString: '535 Authentication DENIED\r\n',
    expectResult: 'bad-user-or-pass',
  });
});

/**
 * We removed specific error code handling for this, but it ended up that
 * we returned "unknown", which is not what we wanted.  So now we make sure
 * that we at least return "bad-user-or-pass" based on the status code.
 * (As opposed to our previous regexp.)
 */
commonCase('gmail application-specific password', function(T, RT) {
  cannedLoginTest(T, RT, {
    loginErrorString: '534 5.7.9 Application-specific password needed!\r\n',
    expectResult: 'bad-user-or-pass',
  });
});

commonCase('angry server', function(T, RT) {
  cannedLoginTest(T, RT, {
    ehloResponse: '500 go away!\r\n',
    // it will then say HELO, which we also hate, because we are angry.
    loginErrorString: '500 I said go away!\r\n',
    expectResult: 'server-problem',
  });
});

/**
 * When our access token expires, we must make a [successful] request
 * to the Gmail OAUTH server, and update the credentials.
 */
commonCase('oauth, access token is expired, refresh succeeds', function(T, RT) {
  cannedLoginTest(T, RT, {
    loginErrorString: '200 Keep up the good work\r\n',
    mutateConnInfo: function(cci) {
      cci.credentials.oauth2 = {
        authEndpoint: 'auth-url',
        tokenEndpoint: 'token-url',
        scope: 'the-scope',
        clientId: 'client-id',
        clientSecret: 'client-secret',
        refreshToken: 'valid refresh token',
        accessToken: 'expired access token',
        expireTimeMS: Date.now() - 1000 // before now
      };
    },
    expectFunc: function() {
      logic.interceptOnce('oauth:renew-xhr', function(xhr) {
        var xhr = {
          open: function() { },
          setRequestHeader: function() { },
          send: function(dataStr) {
            xhr.status = 200;
            xhr.responseText = JSON.stringify({
              expires_in: 3600,
              access_token: 'valid access token'
            });

            setTimeout(function() {
              xhr.onload();
            });
          }
        };
        return xhr;
      });

      var eOauth = T.actor('Oauth');
      // We should properly update our credentials:
      eOauth.expect('got-access-token', {
        _accessToken: 'valid access token'
      });
      eOauth.expect('credentials-changed');
      T.actor('SmtpProber').expect('credentials-updated');
    },
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
    expectResult: null
  });
});

/**
 * Assume that everything works fine; we shouldn't log any updates to
 * credentials, as the access token remains unchanged.
 */
commonCase('oauth, access token is fine', function(T, RT) {
  cannedLoginTest(T, RT, {
    loginErrorString: '200 Keep up the good work\r\n',
    mutateConnInfo: function(cci) {
      cci.credentials.oauth2 = {
        authEndpoint: 'auth-url',
        tokenEndpoint: 'token-url',
        scope: 'the-scope',
        clientId: 'client-id',
        clientSecret: 'client-secret',
        refreshToken: 'valid refresh token',
        accessToken: 'valid access token',
        expireTimeMS:  Date.now() + 1000000
      };
    },
    expectFunc: function() {
      T.actor('Oauth').expectNot('credentials-changed');
    },
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
    expectResult: null
  });
});

/**
 * In this case, our credentials check out locally, but the server
 * still rejects us, likely because the user revoked the key. They
 * must go through the OAUTH setup process again.
 */
commonCase('oauth, access token is fine but server still hates us', function(T, RT) {
  cannedLoginTest(T, RT, {
    // The first part of the SASL response is a base64-encoded
    // challenge response that we don't care about; the SMTP server
    // then responds with a typical error for AUTH.
    loginErrorString: '334 XXXXXXX\r\n535 Invalid Credentials (Failure).\r\n',
    mutateConnInfo: function(cci) {
      cci.credentials.oauth2 = {
        authEndpoint: 'auth-url',
        tokenEndpoint: 'token-url',
        scope: 'the-scope',
        clientId: 'client-id',
        clientSecret: 'client-secret',
        refreshToken: 'valid refresh token',
        accessToken: 'valid access token',
        expireTimeMS:  Date.now() + 1000000,
        // the composite configurator does this too with the goal of not
        // immediately reacquiring an access token since it should already
        // be fresh.
        _transientLastRenew: Date.now()
      };
    },
    expectResult: 'needs-oauth-reauth'
  });
});

/**
 * If the server refuses to give us a new access token for some reason
 * (though the server remains reachable, so it's not a connectivity
 * problem), kick the user back through the OAUTH flow.
 */
commonCase('oauth, access token is expired, refresh fails', function(T, RT) {
  cannedLoginTest(T, RT, {
    willNotMakeConnection: true,
    mutateConnInfo: function(cci) {
      cci.credentials.oauth2 = {
        authEndpoint: 'auth-url',
        tokenEndpoint: 'token-url',
        scope: 'the-scope',
        clientId: 'client-id',
        clientSecret: 'client-secret',
        refreshToken: 'valid refresh token',
        accessToken: 'expired access token',
        expireTimeMS: Date.now() - 1000 // before now
      };
    },
    expectFunc: function() {
      logic.interceptOnce('oauth:renew-xhr', function(xhr) {
        var xhr = {
          open: function() { },
          setRequestHeader: function() { },
          send: function(dataStr) {
            xhr.status = 400;
            setTimeout(function() {
              xhr.onload();
            });
          }
        };
        return xhr;
      });
    },
    expectResult: 'needs-oauth-reauth'
  });
});

/**
 * If we just can't reach the OAUTH server, this really just indicates
 * a connectivity problem, as we might be able to "just deal" when the
 * connection comes back online. Bail with "unresponsive-server",
 * rather than needs-oauth-reauth.
 */
commonCase('oauth, access token is expired, refresh unreachable', function(T, RT) {
  cannedLoginTest(T, RT, {
    willNotMakeConnection: true,
    mutateConnInfo: function(cci) {
      cci.credentials.oauth2 = {
        authEndpoint: 'auth-url',
        tokenEndpoint: 'token-url',
        scope: 'the-scope',
        clientId: 'client-id',
        clientSecret: 'client-secret',
        refreshToken: 'valid refresh token',
        accessToken: 'expired access token',
        expireTimeMS: Date.now() - 1000 // before now
      };
    },
    expectFunc: function() {
      logic.interceptOnce('oauth:renew-xhr', function(xhr) {
        xhr = {
          open: function() { },
          setRequestHeader: function() { },
          send: function(dataStr) {
            xhr.status = 0;
            setTimeout(function() {
              xhr.onerror({ name: 'ConnectionRefusedError' });
            });
          }
        };
        return xhr;
      });
    },
    expectResult: 'unresponsive-server'
  });
});


commonCase('bad address', function(T, RT) {
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

commonCase('good address', function(T, RT) {
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

return allTests;

}); // end define
