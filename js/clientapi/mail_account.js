import evt from 'evt';
import MailSenderIdentity from './mail_sender_identity';

/**
 *
 */
export default function MailAccount(api, wireRep, overlays, matchInfo, acctsSlice) {
  evt.Emitter.call(this);

  this._api = api;
  this.id = wireRep.id;
  this.matchInfo = matchInfo;

  // Hold on to wireRep for caching
  this._wireRep = wireRep;

  // Hold on to acctsSlice for use in determining default account.
  this.acctsSlice = acctsSlice;

  this.type = wireRep.type;
  this.name = wireRep.name;
  this.syncRange = wireRep.syncRange;
  this.syncInterval = wireRep.syncInterval;
  this.notifyOnNew = wireRep.notifyOnNew;
  this.playSoundOnSend = wireRep.playSoundOnSend;

  /**
   * Is the account currently enabled, as in will we talk to the server?
   * Accounts will be automatically disabled in cases where it would be
   * counter-productive for us to keep trying to access the server.
   *
   * For example: the user's password being (apparently) bad, or gmail getting
   * upset about the amount of data transfer and locking the account out for the
   * rest of the day.
   */
  this.enabled = wireRep.enabled;
  /**
   * @listof[@oneof[
   *   @case['bad-user-or-pass']
   *   @case['bad-address']
   *   @case['needs-oauth-reauth']
   *   @case['imap-disabled']
   *   @case['pop-server-not-great']{
   *     The POP3 server doesn't support IDLE and TOP, so we can't use it.
   *   }
   *   @case['connection']{
   *     Generic connection problem; this problem can quite possibly be present
   *     in conjunction with more specific problems such as a bad username /
   *     password.
   *   }
   * ]]{
   *   A list of known problems with the account which explain why the account
   *   might not be `enabled`.  Once a problem is believed to have been
   *   addressed, `clearProblems` should be called.
   * }
   */
  this.problems = wireRep.problems;

  this.identities = [];
  for (var iIdent = 0; iIdent < wireRep.identities.length; iIdent++) {
    this.identities.push(new MailSenderIdentity(this._api,
                                                wireRep.identities[iIdent]));
  }

  this.username = wireRep.credentials.username;
  this.servers = wireRep.servers;

  this.authMechanism = wireRep.credentials.oauth2 ? 'oauth2' : 'password';

  this.folders = null;
  if (acctsSlice && acctsSlice._autoViewFolders) {
    this.folders = api.viewFolders('account', this.id);
  }

  this.__updateOverlays(overlays);
}
MailAccount.prototype = evt.mix({
  toString: function() {
    return '[MailAccount: ' + this.type + ' ' + this.id + ']';
  },
  toJSON: function() {
    return {
      type: 'MailAccount',
      accountType: this.type,
      id: this.id,
    };
  },

  __update: function(wireRep) {
    this._wireRep = wireRep;
    this.enabled = wireRep.enabled;
    this.problems = wireRep.problems;
    this.syncRange = wireRep.syncRange;
    this.syncInterval = wireRep.syncInterval;
    this.notifyOnNew = wireRep.notifyOnNew;
    this.playSoundOnSend = wireRep.playSoundOnSend;

    for (var i = 0; i < wireRep.identities.length; i++) {
      if (this.identities[i]) {
        this.identities[i].__update(wireRep.identities[i]);
      } else {
        this.identities.push(new MailSenderIdentity(this._api,
                                        wireRep.identities[i]));
      }
    }
  },

  __updateOverlays: function(overlays) {
    this.syncStatus = overlays.sync_refresh ? overlays.sync_refresh : null;
  },

  release: function() {
    // currently, nothing to clean up
  },

  /**
   * Tell the back-end to clear the list of problems with the account, re-enable
   * it, and try and connect.
   */
  clearProblems: function(callback) {
    this._api._clearAccountProblems(this, callback);
  },

  /**
   * @param {Object} mods
   *   Modify properties on the account.
   *
   *   In addition to regular account property settings,
   *   "setAsDefault": true can be passed to set this account as the
   *   default acccount.
   *
   *   # Username and Password Setting
   *
   *   If you want to modify the username or password of an account,
   *   keep in mind that IMAP/POP3 accounts might have two separate
   *   passwords, one for incoming mail and one for SMTP. You have a
   *   couple options:
   *
   *   - If you specify "username" and/or "password", we'll change the
   *     incoming side, and if the SMTP side had the same
   *     username/password, we'll change that too.
   *
   *   - If you specify incomingUsername, incomingPassword, etc., we
   *     will NOT do that magic inferring; we'll just change the side
   *     you specify.
   *
   *   Practically speaking, most accounts will likely share the same
   *   username and password. Additionally, if we guess that the
   *   passwords/usernames should match when they actually should
   *   differ, we'll safely recover becuase we'll then ask for a
   *   corrected SMTP password.
   * @param {String} [mods.password]
   * @param {String} [mods.incomingPassword]
   * @param {String} [mods.outgoingPassword]
   * @param {String} [mods.username]
   * @param {String} [mods.incomingUsername]
   * @param {String} [mods.outgoingUsername]
   * @param {Boolean} [mods.setAsDefault]
   *
   * @return {Promise}
   *   A promise that is resolved when the back-end has applied the changes to
   *   the account and propagated them.
   */
  modifyAccount: function(mods) {
    return this._api._modifyAccount(this, mods);
  },

  /**
   * Delete the account and then immediate re-create it as if we had performed
   * a lazy config migration.  This is intended mainly for debugging and
   * development scenarios where one wants to use the same account but start
   * from scratch without typing things all over again.
   */
  recreateAccount: function() {
    this._api._recreateAccount(this);
  },

  /**
   * Delete the account and all its associated data.  No privacy guarantees are
   * provided; we just delete the data from the database, so it's up to the
   * (IndexedDB) database's guarantees on that.
   */
  deleteAccount: function() {
    this._api._deleteAccount(this);
  },

  syncFolderList: function() {
    this._api.__bridgeSend({
      type: 'syncFolderList',
      accountId: this.id
    });
  },

  /**
   * Clear the new-tracking state for this account.  Also accessible as
   * `MailAPI.clearNewTrackingForAccount`.
   */
  clearNewTracking: function(opts) {
    this._api.clearNewTrackingForAccount({
      accountId: this.id,
      silent: opts && opts.silent || false
    });
  },

  /**
   * Returns true if this account is the default account, by looking at
   * all accounts in the acctsSlice.
   */
  get isDefault() {
    if (!this.acctsSlice) {
      throw new Error('No account slice available');
    }

    return this.acctsSlice.defaultAccount === this;
  },
});
