/**
 * Test whether an account responds properly to an invalid password.
 *
 * ActiveSync does not use persistent connections, but it has a notion of being
 * 'connected' in terms of having established the right server endpoint to talk
 * to and having retrieved the OPTIONS.  Accordingly, we both test
 * authentication failure on initial connect (OPTIONS) stage, as well as when we
 * are already connected.
 **/

define(function(require) {

var LegacyGelamTest = require('./resources/legacy_gelamtest');

return new LegacyGelamTest('reports bad password', function(T, RT) {
  T.group('setup');
  var TEST_PARAMS = RT.envOptions;
  var testUniverse = T.actor('TestUniverse', 'U'),
      testAccount = T.actor('TestAccount', 'A',
                            { universe: testUniverse }),
      eCheck = T.lazyLogger('check');

  T.action('set up MailAPI.onbadlogin', function() {
    testUniverse.MailAPI.onbadlogin = function(acct) {
      eCheck.log('badlogin');
    };
  });

  // Go through all possible permutations of password logic. Incoming
  // could be wrong, outgoing could be wrong, either or both could be
  // right, server passwords could be the same for incoming and
  // outgoing or differ, etc. We'll run through every possible
  // combination as follows:
  var RIGHT = 'success';
  var WRONG = 'failure';

  var passwordPermutations = [
    { incoming: RIGHT, outgoing: RIGHT, drop: false, passwordsMatch: false },
    { incoming: RIGHT, outgoing: WRONG, drop: false, passwordsMatch: false },
    { incoming: WRONG, outgoing: RIGHT, drop: false, passwordsMatch: false },
    { incoming: WRONG, outgoing: WRONG, drop: false, passwordsMatch: false },
    { incoming: RIGHT, outgoing: RIGHT, drop: false, passwordsMatch: true },
    { incoming: RIGHT, outgoing: WRONG, drop: false, passwordsMatch: true },
    { incoming: WRONG, outgoing: RIGHT, drop: false, passwordsMatch: true },
    { incoming: WRONG, outgoing: WRONG, drop: false, passwordsMatch: true },
  ];

  if (testAccount.type === 'pop3') {
    // Let's also test POP3's password handling in the presence of a
    // server who drops the connection on auth failure. This runs all
    // the tests as above, both with dropOnAuthFailure and without.
    JSON.parse(JSON.stringify(passwordPermutations)).forEach(function(perm) {
      perm.drop = true;
      passwordPermutations.push(perm);
    });
  } else if (testAccount.type === 'activesync') {
    // ActiveSync has no concept of an outgoing password; so for
    // logic's sake, set outgoing to always be RIGHT.
    passwordPermutations.forEach(function(perm) {
      perm.outgoing = RIGHT;
    });
  }

  // For each permutation, set up the passwords as specified. Then,
  // correct the passwords by updating the client's logic to match
  // what the server expects. This should result in a successful
  // connection at the end, every time.
  passwordPermutations.forEach(function(permutation, idx) {
    // NOTE: drop means dropOnAuthFailure (POP3 only);
    // passwordsMatch means (incoming password === outgoing password)
    var { incoming, outgoing, passwordsMatch, drop } = permutation;

    // Set up the passwords as specified in the current permutation.
    var rightPasswords = {};
    if (passwordsMatch) {
      rightPasswords.incoming = rightPasswords.outgoing = 'password' + idx;
    } else {
      rightPasswords.incoming = 'incoming' + idx;
      rightPasswords.outgoing = 'outgoing' + idx;
    }
    var wrongPasswords = {
      incoming: 'wrong' + rightPasswords.incoming,
      outgoing: 'wrong' + rightPasswords.outgoing
    };
    var clientPasswords = {
      incoming: (incoming === RIGHT ? rightPasswords : wrongPasswords).incoming,
      outgoing: (outgoing === RIGHT ? rightPasswords : wrongPasswords).outgoing,
    };

    T.group(JSON.stringify(permutation));

    T.action('Server incoming => ' + rightPasswords.incoming, function() {
      // this executes synchronously; no expectations required
      testAccount.testServer.changeCredentials(
        { password: rightPasswords.incoming });
    });

    T.action('Server outgoing => ' + rightPasswords.outgoing, function() {
      // this executes synchronously; no expectations required
      testAccount.testServer.changeCredentials(
        { outgoingPassword: rightPasswords.outgoing });
    });

    // Change the client passwords to be right or wrong as specified
    // in the current test permutation.

    testAccount.do_modifyAccount(
      { password: clientPasswords.incoming });
    testAccount.do_modifyAccount(
      { outgoingPassword: clientPasswords.outgoing });

    if (testAccount.type === 'pop3') {
      T.action('Set dropOnAuthFailure => ' + drop, eCheck, function() {
        testAccount.testServer.setDropOnAuthFailure(drop);
      });
    }

    // Expect success or failure, as appropriate.
    confirmPasswordCausesSuccessOrFailure(incoming, outgoing);

    // Fix the client passwords to match what the server expects.
    testAccount.do_modifyAccount(
      { password: rightPasswords.incoming });
    testAccount.do_modifyAccount(
      { outgoingPassword: rightPasswords.outgoing });

    // After updating the client passwords to be correct, the account
    // should be fully operational.
    confirmPasswordCausesSuccessOrFailure(RIGHT, RIGHT, incoming, outgoing);
  });

  /**
   * Check the account; if incoming is RIGHT, then the incoming side
   * of the account should succeed without errors. If incoming is
   * WRONG, the incoming side of the account should fail. Etc.
   * previousIncoming and previousOutgoing are only provided if we
   * have previously tested a failing account and want to ensure that
   * the newly-succeeding account cleans up its connection
   * backoff/healing state.
   */
  function confirmPasswordCausesSuccessOrFailure(
    incoming, outgoing, previousIncoming, previousOutgoing) {
    var eitherWrong = (incoming === WRONG || outgoing === WRONG);
    T.action('Expect incoming ' + incoming + ', outgoing ' + outgoing,
             eCheck, outgoing, testAccount.eBackoff, function() {
      if (eitherWrong) {
        eCheck.expect('badlogin');
      }
      var expectedProblems = [];
      if (eitherWrong) {
        expectedProblems.push('bad-user-or-pass');
      }
      if (incoming === WRONG && testAccount.type !== 'activesync') {
        expectedProblems.push('connection');
      }

      eCheck.expect('account:problems', expectedProblems);
      eCheck.expect('account:enabled', !eitherWrong);

      if (incoming === WRONG && testAccount.type !== 'activesync') {
        // Only IMAP and POP3 accounts have eBackoff.
        testAccount.eBackoff.expect('connectFailure', { reachable: true });
        testAccount.eBackoff.expect('state', { state: 'broken' });
      } else if (testAccount.type === 'imap' && previousIncoming === WRONG) {
        // If IMAP was broken before, eBackoff should heal itself.
        testAccount.eBackoff.expect('state', { state: 'healthy' });
      }

      testUniverse.allAccountsSlice.items[0].clearProblems(function() {
        eCheck.log('account:problems',
                          (testAccount.compositeAccount ||
                           testAccount.folderAccount).problems);
        eCheck.log('account:enabled',
                          testAccount.folderAccount.enabled);
      });

    }).timeoutMS = 5000;

  }

  // ActiveSync only; as discussed in the file block comment, make sure that if
  // the connection is already 'established' (OPTIONS run) that we still error.
  // The initial fix did not detect this.)
  if (testAccount.type === 'activesync') {

    T.group('sync a folder with good password');

    var testFolder = testAccount.do_createTestFolder(
      'test_bad_password_sync', { count: 1 });

    var folderView = testAccount.do_openFolderView(
      'syncs', testFolder,
      { count: 1, full: 1, flags: 0, changed: 0, deleted: 0,
        filterType: 'none' },
      { top: true, bottom: true, grow: false },
      { syncedToDawnOfTime: true });

    T.group('resync folder with bad password');
    T.action('set bad password', function() {
      // this executes synchronously; no expectations required
      testAccount.testServer.changeCredentials(
        { password: 'something else' });
    });

    // Try and sync; we should fail and badlogin should be generated.
    // (onbadlogin is still set to generate badlogin events)
    testAccount.do_refreshFolderView(
      folderView,
      { count: 1, full: null, flags: null, changed: null, deleted: null },
      { changes: [], deletions: [] },
      { top: true, bottom: true, grow: false },
      {
        failure: true,
        expectFunc: function() {
          RT.reportActiveActorThisStep(eCheck);
          eCheck.expect('badlogin');
        }
      });
  }
  T.group('cleanup');
});

}); // end define
