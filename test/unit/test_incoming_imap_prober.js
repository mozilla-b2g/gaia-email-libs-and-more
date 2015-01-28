/**
 * IMAP-specific prober tests that don't need a network connection.
 * test_incoming_prober contains the prober logic tests shared with POP3.
 * test_incoming_imap_tz_prober covers the timezone prober logic that needs
 * a realistic-seeming IMAP server.
 */

define(['rdcommon/testcontext', './resources/th_main',
        './resources/incoming_prober_shared',
        './resources/fault_injecting_socket', 'imap/probe',
        'syncbase', 'slog',
        'imap/client', 'exports'],
function($tc, $th_main, proberShared, $fawlty, $imapProbe,
         syncbase, slog, imapclient, exports) {
var FawltySocketFactory = $fawlty.FawltySocketFactory;

var TD = exports.TD = $tc.defineTestsFor(
  { id: 'test_incoming_imap_prober' }, null, [$th_main.TESTHELPER], ['app']);

var {
  thunkTimeouts, thrower, proberTimeout, constructProber, openResponse,
  badStarttlsResponse, capabilityResponse, makeCredsAndConnInfo,
  HOST, PORT, KEEP_ALIVE_TIMEOUT_MS,
  cannedLoginTest
} = proberShared;

/**
 * Test the case where we have an access token, but we already know
 * the access token is expired. We should discard our current access
 * token and fetch a new one. In this test, we successfully obtain a
 * new access token, but the server happens to be down for maintenance
 * (mainly because the test boilerplate here doesn't run with a
 * server, so it'd be a pain to try to mimic a full-on successful
 * login.)
 */
TD.commonCase('Gmail OAUTH: access_token expired by timestamp', function(T, RT) {
  var refreshToken = 'refresh';
  var accessToken = 'access';

  var tokenEndpoint = 'token-url';
  var clientId = 'client-id';
  var clientSecret = 'client-secret';

  cannedLoginTest(T, RT, {
    loginErrorString: 'NO [UNAVAILABLE] Server down for maintenance.',
    capabilityResponse: capabilityResponse(RT).replace('AUTH=PLAIN',
                                                       'AUTH=XOAUTH2'),
    mutateConnInfo: function(cci) {
      cci.credentials.oauth2 = {
        authEndpoint: 'auth-url',
        tokenEndpoint: tokenEndpoint,
        scope: 'the-scope',
        clientId: clientId,
        clientSecret: clientSecret,
        refreshToken: refreshToken,
        accessToken: 'expired access token',
        expireTimeMS: Date.now() - 1000 // before now
      };
    },
    expectFunc: function() {
      var eLazy = T.lazyLogger('lazy');
      RT.reportActiveActorThisStep(eLazy);

      var lc = new slog.LogChecker(T, RT, 'logs');
      // Mock out the XHR asking Google to give us a new access token.
      lc.interceptOnce('oauth:renew-xhr', function(xhr) {
        xhr = {
          open: function(method, url, async) {
            eLazy.namedValue('xhrUrl', url);
          },
          setRequestHeader: function() { },
          send: function(dataStr) {
            var formData = dataStr.split('&').reduce(
              function(m, kvstr) {
                var kv = kvstr.split('='); // ignoring parsing escapes
                m[kv[0]] = decodeURIComponent(kv[1]);
                return m;
              },
              {}
            );

            eLazy.namedValue('formData', formData);

            xhr.status = 200;
            xhr.responseText = JSON.stringify({
              expires_in: 3600,
              access_token: accessToken
            });

            setTimeout(function() {
              xhr.onload();
            });
          }
        };
        return xhr;
      });

      eLazy.expect_namedValue('xhrUrl', tokenEndpoint);
      eLazy.expect_namedValue(
        'formData',
        {
          client_id: clientId,
          client_secret: clientSecret,
          refresh_token: refreshToken,
          grant_type: 'refresh_token',
        });

      // We should properly update our credentials:
      lc.mustLog('oauth:got-access-token', {
        _accessToken: accessToken
      });
      lc.mustLog('oauth:credentials-changed');
      lc.mustLog('probe:imap:credentials-updated');
    },
    // But alas, the server still didn't let us in.
    expectResult: 'server-maintenance'
  });
});

/**
 * In this test, we have an access token that is allegedly valid, but
 * the server rejects it anyway. In this case, fetching a new access
 * token won't do any good; kick the user back through the OAUTH
 * process, because they have likely revoked our refresh token.
 */
TD.commonCase('Gmail OAUTH: server hates your access token', function(T, RT) {
  cannedLoginTest(T, RT, {
    loginErrorString: 'NO [ALERT] Invalid credentials (Failure).',
    capabilityResponse: capabilityResponse(RT).replace('AUTH=PLAIN',
                                                       'AUTH=XOAUTH2'),
    mutateConnInfo: function(cci) {
      cci.credentials.oauth2 = {
        authEndpoint: 'auth-url',
        tokenEndpoint: 'token-url',
        scope: 'the-scope',
        clientId: 'client-id',
        clientSecret: 'client-secret',
        refreshToken: 'refreshtoken',
        accessToken: 'accesstoken',
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
 * Test the case where we try to refresh our access token, but for
 * some reason the Gmail refresh-token-request refuses to respond;
 * i.e. network conditions are terrible.
 */
TD.commonCase('Gmail OAUTH: network prevents token refresh', function(T, RT) {
  var refreshToken = 'refresh';
  var accessToken = 'access';

  cannedLoginTest(T, RT, {
    willNotMakeConnection: true,
    mutateConnInfo: function(cci) {
      cci.credentials.oauth2 = {
        authEndpoint: 'auth-url',
        tokenEndpoint: 'token-url',
        scope: 'the-scope',
        clientId: 'client-id',
        clientSecret: 'client-secret',
        refreshToken: refreshToken,
        accessToken: 'expired access token',
        expireTimeMS:  Date.now() - 1000 // before now
      };
    },
    expectFunc: function() {
      var eLazy = T.lazyLogger('lazy');
      RT.reportActiveActorThisStep(eLazy);

      var lc = new slog.LogChecker(T, RT, 'logs');
      // Mock out the XHR asking Google to give us a new access token.
      lc.interceptOnce('oauth:renew-xhr', function(xhr) {
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
    // But alas, the server still didn't let us in.
    expectResult: 'unresponsive-server'
  });
});

}); // end define
