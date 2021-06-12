/* eslint-disable no-prototype-builtins */
/**
 * Configurator for fake
 **/

import logic from 'logic';
import $acctmixins from '../../accountmixins';
import * as $imapacct from '../imap/account';
import * as $pop3acct from '../pop3/account';
import * as $smtpacct from '../smtp/account';
import allback from 'shared/allback';

var PIECE_ACCOUNT_TYPE_TO_CLASS = {
  'imap': $imapacct.ImapAccount,
  'pop3': $pop3acct.Pop3Account,
  'smtp': $smtpacct.SmtpAccount,
};

/**
 * Composite account type to expose account piece types with individual
 * implementations (ex: imap, smtp) together as a single account.  This is
 * intended to be a very thin layer that shields consuming code from the
 * fact that IMAP and SMTP are not actually bundled tightly together.
 */
export default function CompositeAccount(universe, accountDef, foldersTOC, dbConn,
                                         receiveProtoConn) {
  this.universe = universe;
  this.id = accountDef.id;
  this.accountDef = accountDef;
  logic.defineScope(this, 'Account', { accountId: this.id });

  // Currently we don't persist the disabled state of an account because it's
  // easier for the UI to be edge-triggered right now and ensure that the
  // triggering occurs once each session.
  this._enabled = true;
  this.problems = [];

  // For oauth2, hold on to a "last renew attempt" timestamp. However, since it
  // uses performance.now() that can be reset depending on clock time and
  // environment (shared worker always resets to 0 for instance), always reset
  // the value here to 0. It is just a transient timestamp that is useful
  // during the lifetime of the app.
  if (accountDef.credentials && accountDef.credentials.oauth2) {
    accountDef.credentials.oauth2._transientLastRenew = 0;
  }

  this.identities = accountDef.identities;

  if (!PIECE_ACCOUNT_TYPE_TO_CLASS.hasOwnProperty(accountDef.receiveType)) {
    logic(this, 'badAccountType', { type: accountDef.receiveType });
  }
  if (!PIECE_ACCOUNT_TYPE_TO_CLASS.hasOwnProperty(accountDef.sendType)) {
    logic(this, 'badAccountType', { type: accountDef.sendType });
  }

  this._receivePiece =
    new PIECE_ACCOUNT_TYPE_TO_CLASS[accountDef.receiveType](
      universe, this,
      accountDef.id, accountDef.credentials, accountDef.receiveConnInfo,
      foldersTOC, dbConn, receiveProtoConn);
  this._sendPiece =
    new PIECE_ACCOUNT_TYPE_TO_CLASS[accountDef.sendType](
      universe, this,
      accountDef.id, accountDef.credentials,
      accountDef.sendConnInfo, dbConn);

  // XXX this hiding and all that just ended up confusing.  FIX IT.
  // XXX and now I'm making this worse since both can't be true.
  this.imapAccount = this._receivePiece;
  this.popAccount = this._receivePiece;
  this.smtpAccount = this._sendPiece;

  // expose public lists that are always manipulated in place.
  this.folders = this._receivePiece.folders;
}
CompositeAccount.prototype = {
  toString: function() {
    return '[CompositeAccount: ' + this.id + ']';
  },
  get supportsServerFolders() {
    return this._receivePiece.supportsServerFolders;
  },
  toBridgeFolder: function() {
    return {
      id: this.accountDef.id,
      name: this.accountDef.name,
      path: this.accountDef.name,
      type: 'account',
    };
  },

  // TODO: evaluate whether the account actually wants to be a RefedResource
  // with some kind of reaping if all references die and no one re-acquires it
  // within some timeout horizon.
  __acquire: function() {
    return Promise.resolve(this);
  },
  __release: function() {
  },

  get enabled() {
    return this._enabled;
  },
  set enabled(val) {
    this._enabled = this._receivePiece.enabled = val;
  },

  get foldersTOC() {
    return this._receivePiece.foldersTOC;
  },

  get pimap() {
    return this._receivePiece.pimap;
  },

  saveAccountState: function(reuseTrans, callback, reason) {
    return this._receivePiece.saveAccountState(reuseTrans, callback, reason);
  },

  get _saveAccountIsImminent() {
    return this.__saveAccountIsImminent;
  },
  set _saveAccountIsImminent(val) {
    this.___saveAccountIsImminent =
    this._receivePiece._saveAccountIsImminent = val;
  },

  runAfterSaves: function(callback) {
    return this._receivePiece.runAfterSaves(callback);
  },

  allOperationsCompleted: function() {
    if (this._receivePiece.allOperationsCompleted) {
      this._receivePiece.allOperationsCompleted();
    }
  },

  /**
   * Check that the account is healthy in that we can login at all.
   * We'll check both the incoming server and the SMTP server; for
   * simplicity, the errors are returned as follows:
   *
   *   callback(incomingErr, outgoingErr);
   *
   * If you don't want to check both pieces, you should just call
   * checkAccount on the receivePiece or sendPiece as appropriate.
   */
  checkAccount: function(callback) {
    var latch = allback.latch();
    this._receivePiece.checkAccount(latch.defer('incoming'));
    this._sendPiece.checkAccount(latch.defer('outgoing'));
    latch.then(function(results) {
      callback(results.incoming[0], results.outgoing[0]);
    });
  },

  /**
   * Shutdown the account; see `MailUniverse.shutdown` for semantics.
   */
  shutdown: function(callback) {
    this._sendPiece.shutdown();
    this._receivePiece.shutdown(callback);
  },

  accountDeleted: function() {
    this._sendPiece.accountDeleted();
    this._receivePiece.accountDeleted();
  },

  deleteFolder: function(folderId, callback) {
    return this._receivePiece.deleteFolder(folderId, callback);
  },

  sliceFolderMessages: function(folderId, bridgeProxy) {
    return this._receivePiece.sliceFolderMessages(folderId, bridgeProxy);
  },

  searchFolderMessages: function(folderId, bridgeHandle, phrase, whatToSearch) {
    return this._receivePiece.searchFolderMessages(
      folderId, bridgeHandle, phrase, whatToSearch);
  },

  syncFolderList: function(callback) {
    return this._receivePiece.syncFolderList(callback);
  },

  sendMessage: function(composer, callback) {
    return this._sendPiece.sendMessage(
      composer,
      function(err, errDetails) {
        if (!err) {
          // The saving is done asynchronously as a best-effort.
          this._receivePiece.saveSentMessage(composer);
        }
        callback(err, errDetails, null);
      }.bind(this));
  },

  runOp: function(op, mode, callback) {
    return this._receivePiece.runOp(op, mode, callback);
  },

  /**
   * Kick off jobs to create required folders, both locally and on the
   * server. See imap/account.js and activesync/account.js for documentation.
   *
   * @param {function} callback
   *   Called when all jobs have run.
   */
  ensureEssentialOnlineFolders: function(callback) {
    return this._receivePiece.ensureEssentialOnlineFolders(callback);
  },

  ensureEssentialOfflineFolders: function(callback) {
    return this._receivePiece.ensureEssentialOfflineFolders(callback);
  },

  getFirstFolderWithType: $acctmixins.getFirstFolderWithType,

  getFolderById: $acctmixins.getFolderById,

  upgradeFolderStoragesIfNeeded: function() {
    for (var key in this._receivePiece._folderStorages) {
      var storage = this._receivePiece._folderStorages[key];
      storage.upgradeIfNeeded();
    }
  }
};
