/**
 * IMAP OAuth tests that aren't covered by test_incoming_prober.js /
 * test_smtp_prober.js.
 **/

define(function(require) {

var LegacyGelamTest = require('./resources/legacy_gelamtest');
var $date = require('date');

/**
 * Verify that in the situation where we think our access token is up-to-date
 * but it's not (due to clock issues or something) that we try and refresh the
 * token exactly once.  If the refresh succeeds we expect a needs-oauth-reauth
 * error, otherwise expect things to go through.
 *
 * The gameplan is this:
 * - (Be using standard fixed-time stuff, we just need to do a couple minor
 *    time jumps.)
 * - Create a normal account using oauth backed by a fake-server.  This works,
 *   everyone is happy.  We get an access token valid for ~60 minutes.
 * - Jump time forward by 45 minutes so that we think our access token should
 *   still be valid but we're past our 30 minute defensive checks.
 * - Invalidate our access token (with the IMAP server), set things up so the
 *   oauth token server will produce a new, valid access token (that the
 *   IMAP server will understand.)
 * - Drop all connections (otherwise invalidating the access token won't
 *   matter.)
 * - Trigger a sync.  Observe that we automatically renew our access token,
 *   that the oauth server gets asked about stuff exactly 1 time, and then
 *   the sync completes happily.
 * - Do not move time forward, invalidate our access token again (from the
 *   IMAP server's perspective).
 * - Trigger a sync.  Observe that we get a 'needs-oauth-reauth' error, the
 *   oauth server does not get another token request, and the refresh sync
 *   fails.
 * - Clear the account problems without triggering a checkAccount (not needed
 *   for our test), and advance the clock so we will attempt to get an access
 *   token.  Leave things so that the access token that we get back will still
 *   be invalid.
 * - Trigger a sync.  Observe that we get a 'needs-oauth'reauth' error and
 *   that the refresh sync fails but also that the oauth server gets exactly one
 *   token request.
 */
return new LegacyGelamTest('last-ditch access token renewal', function(T, RT) {
  T.group('setup');
  var testUniverse = T.actor('TestUniverse', 'U');
  var testAccount = T.actor(
    'TestAccount', 'A',
    {
      universe: testUniverse,
      imapExtensions: ['XOAUTH2'],
      smtpExtensions: ['XOAUTH2'],
      oauth: {
        initialTokens: {
          accessToken: 'valid0',
          refreshToken: 'refreshy' // I originally had a "refresh prince" joke
        },
        acceptTokens: ['valid0'],
        issueTokens: ['valid1', 'still-not-valid']
      }
    });
  var eSync = T.lazyLogger('sync');
  var eOauth = T.lazyLogger('Oauth');

  var testFolder = testAccount.do_createTestFolder(
    'test_oauth_renewal', { count: 1 } );

  var staticNow = testUniverse._useDate.valueOf();
  // have connections auto-close when not in use.
  testUniverse.do_adjustSyncValues({
    KILL_CONNECTIONS_WHEN_JOBLESS: true
  });
  testAccount.do_viewFolder(
    'initial sync', testFolder,
    { count: 1, full: 1, flags: 0, changed: 0, deleted: 0 },
    { top: true, bottom: true, grow: false, newCount: null },
    { syncedToDawnOfTime: true });

  T.group('+45mins, invalidate');
  staticNow += 45 * 60 * 1000;
  testUniverse.do_timewarpNow(staticNow, '+45 minutes');
  T.action('rotate valid token to be valid1', function() {
    testAccount.testServer.setValidOAuthAccessTokens(['valid1']);
  });

  T.group('trigger sync, token is sad, we ask for new (good) token');
  testAccount.do_viewFolder(
    'refresh sync', testFolder,
    { count: 1, full: 0, flags: 1, changed: 0, deleted: 0 },
    { top: true, bottom: true, grow: false, newCount: 0 },
    {
      syncedToDawnOfTime: true,
      expectFunc: function() {
        // we will think our credentials are okay...
        eOauth.expect('credentials-ok');
        // oops, but they weren't!
        eOauth.expect('renewing-access-token');
        // and so we should get that new token and change our creds
        eOauth.expect('got-access-token',
                           { _accessToken: 'valid1' });
        eOauth.expect('credentials-changed');
        // and then we'll think our credentials are okay again...
        eOauth.expect('credentials-ok');
      }
    });
  T.check(eSync, 'verify oauth server was asked for 1 token', function() {
    eSync.expect('tokens',  1);
    eSync.log('tokens',
                     testAccount.testServer.oauth_getNumAccessTokensProvided(
                       { reset : true }));
  });

  T.group('no timewarp, invalidate');
  T.action('rotate valid token to be valid2', function() {
    testAccount.testServer.setValidOAuthAccessTokens(['valid2']);
  });

  T.group('sync, but fail, get reauth error without trying to get new token');
  testAccount.do_viewFolder(
    'refresh sync', testFolder,
    { count: 1, full: 0, flags: 0, changed: 0, deleted: 0 },
    { top: true, bottom: true, grow: false, newCount: 0 },
    {
      failure: 'connect-error',
      expectFunc: function() {
        // we will think our credentials are okay...
        eOauth.expect('credentials-ok');
        T.lazyLogger('ImapClient').expect('connect-error',
                                          { error: 'needs-oauth-reauth' });

        RT.reportActiveActorThisStep(testUniverse.eUniverse);
        testUniverse.eUniverse.expect('reportProblem',
                                      { problem: 'needs-oauth-reauth' });
        testUniverse.eUniverse.expect('reportProblem',
                                      { problem: 'connection' });
      }
    });

  T.group('+45min, clear problems');
  staticNow += 45 * 60 * 1000;
  testUniverse.do_timewarpNow(staticNow, '+45 minutes');
  T.action('clear problems', function() {
    // this is synchronous, no one cares
    testUniverse.universe.clearAccountProblems(testAccount.account);
  });

  T.group('sync, get token but it is still invalid, fail to sync, give up');
  testAccount.do_viewFolder(
    'refresh sync', testFolder,
    { count: 1, full: 0, flags: 0, changed: 0, deleted: 0 },
    { top: true, bottom: true, grow: false, newCount: 0 },
    {
      failure: 'connect-error',
      expectFunc: function() {
        // we will think our credentials are okay...
        eOauth.expect('credentials-ok');
        // oops, but they weren't!
        eOauth.expect('renewing-access-token');
        // and so we should get that new token and change our creds
        eOauth.expect('got-access-token',
                      { _accessToken: 'still-not-valid' });
        eOauth.expect('credentials-changed');
        // and then we'll think our credentials are okay again...
        eOauth.expect('credentials-ok');

        // but they aren't!  whoops!
        RT.reportActiveActorThisStep(testUniverse.eUniverse);
        testUniverse.eUniverse.expect('reportProblem',
                                      { problem: 'needs-oauth-reauth' });
        // (note that calling clearAccountProblems didn't actually reset the
        // clever backoff logic's concept of connection state, so this won't
        // trigger 'connection' to get flagged again.)

        T.lazyLogger('ImapClient').expect('connect-error',
                                          { error: 'needs-oauth-reauth' });
      }
    });
  T.check(eSync, 'verify oauth server was asked for 1 token', function() {
    eSync.expect('tokens', 1);
    eSync.log('tokens',
              testAccount.testServer.oauth_getNumAccessTokensProvided(
                { reset: true }));
  });

  T.group('cleanup');
});

}); // end define
