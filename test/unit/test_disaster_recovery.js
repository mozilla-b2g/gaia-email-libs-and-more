define(function(require) {

var GelamTest = require('./resources/gelamtest');
var AccountHelpers = require('./resources/account_helpers');
var { backend } = require('./resources/contexts');
var assert = require('./resources/assert');
var logic = require('logic');

// XXX: Helpers are gross; see thoughts in account_helpers.js.
var help;

return [
  new GelamTest('reportError fails test, does nothing in real life',
      function*(MailAPI) {

    assert(logic._currentTestRejectFunction, 'reject must be set');
    var rejected = false;
    logic._currentTestRejectFunction = function() {
      rejected = true;
    }

    // Running in test mode, we should see a rejection.
    MailAPI._processMessage({ type: 'fakeMessage' });
    assert(rejected === true, 'should have rejected during test');

    // Running in real life, we should not.
    rejected = false;
    logic.underTest = false;
    MailAPI._processMessage({ type: 'fakeMessage' });
    assert(rejected === false, 'should not have rejected when not underTest');
  }),

  new GelamTest('Releases mutex during botched sync', function*(MailAPI) {
    this.group('setup');

    help = new AccountHelpers(MailAPI);
    var account = yield help.createAccount(this.options);

    var folder = yield help.createFolder(
      'disaster_recovery',
      { count: 5, age: { days: 0 }, age_incr: { days: 1 } });

    yield backend('Tell socket.ondata to do horrible things', ($) => {
      var acct = $.universe.accounts[0]._receivePiece;
      var conn = acct._ownedConns[0].conn;
      conn.client.socket.ondata = function() {
        throw new Error('wtf');
      };
    });

    this.group('view folder and botch the sync');

    yield Promise.all([
      help.viewFolder(folder),
      logic
        .match('DisasterRecovery', 'exception', (d) => {
          return d.accountId === '0' && d.errorMessage === 'wtf';
        })
        .match('FolderStorage', 'mailslice:mutex-released')
        .failIfMatched('DisasterRecovery', 'finished-job')
    ]);
  }),

  new GelamTest('Releases both mutexes and job op during move', function*(MailAPI) {
    this.group('setup');

    var sourceFolder = yield help.createFolder(
      'test_move_source',
      { count: 5, age: { days: 1 }, age_incr: { days: 1 } });

    var targetFolder = yield help.createFolder('test_move_target');

    var sourceSlice = yield help.viewFolder(sourceFolder);
    var targetSlice = yield help.viewFolder(targetFolder);

    yield backend('Tell socket.ondata to do horrible things', ($) => {
      var acct = $.universe.accounts[0]._receivePiece;
      var conn = acct._ownedConns[0].conn;
      conn.client.socket.ondata = function() {
        throw new Error('wtf');
      };
    });

    this.group('try the move job op');

    var headers = sourceSlice.items;
    var headerToMove = headers[1];

    yield Promise.all([
      logic.async(this, 'move messages', (resolve, reject) => {
        MailAPI.moveMessages([headerToMove], targetFolder, resolve);
      }),

      logic
      // The local job will succeed and it will release its mutexes
      // without having experienced any errors.
        .match('FolderStorage', 'mailslice:mutex-released',
               { folderId: sourceFolder.id, err: null })
        .match('FolderStorage', 'mailslice:mutex-released',
               { folderId: targetFolder.id, err: null })
      // Then the jobDoneCallback gets invoked.  It will release the mutexes.
        .match('FolderStorage', 'mailslice:mutex-released',
               { folderId: sourceFolder.id, err: 'disastrous-error' })
        .match('FolderStorage', 'mailslice:mutex-released',
               { folderId: targetFolder.id, err: 'disastrous-error' }),

      logic
      // the local part will succeed
        .match('Account', 'runOp', { mode: 'local_do', type: 'move' })
      // the server part will fail
        .match('Account', 'runOp', { mode: 'do', type: 'move',
                                     error: 'disastrous-error' })
      // we'll run "check"
        .match('Account', 'runOp', { mode: 'check', type: 'move' }),

      logic
      // Make sure we capture an error with the proper details.
        .match('DisasterRecovery', 'exception', (d) => {
          return d.accountId === '0' && d.errorMessage === 'wtf';
        })
      // And we mark when the jobDoneCallback finishes running.
        .match('DisasterRecovery', 'finished-job'),
    ]);
  })

];

}); // end define
