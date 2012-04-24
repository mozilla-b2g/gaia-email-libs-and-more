/**
 *
 **/

define(
  [
    './a64',
    './imapdb',
    './imapslice',
    './imapprobe',
    'exports'
  ],
  function(
    $a64,
    $imapdb,
    $imapslice,
    $imapprobe,
    exports
  ) {

function MailUniverse() {
  this.accounts = [];

  this.config = null;

  this._db = new $imapdb.ImapDB();
  var self = this;
  this._db.getConfig(function(configObj, accountInfos) {
    if (configObj) {
      self.config = configObj;
    }
    else {
      self.config = {
        nextAccountNum: 0,
      };
    }
  });
}
MailUniverse.prototype = {
  /**
   * This
   */
  tryToCreateAccount: function(connInfo, callback) {
    var prober = new $imapprobe.ImapProber(connInfo);
    prober.onresult = function(accountGood) {

    };
  },

  _actuallyCreateAccount: function(connInfo) {
    var accountDef = {
      id: $a64.encodeInt(this.config.nextAccountNum++),
      connInfo: connInfo,
    };
  },
};

/**
 * Account object, root of all interaction with servers.
 *
 * Passwords are currently held in cleartext with the rest of the data.  Ideally
 * we would like them to be stored in a more privileged
 *
 * @typedef[AccountDef @dict[
 *   @key[id AccountId]
 *   @key[connInfo @dict[
 *     @key[host]
 *     @key[port]
 *     @key[crypto]
 *     @key[username]
 *     @key[password]
 *   ]]
 * ]]
 */
function ImapAccount(accountDef, folderInfos) {

}
ImapAccount.prototype = {
  type: 'imap',

  sliceFolderMessages: function() {
  },
};

/**
 * While gmail deserves major props for providing any IMAP interface, everyone
 * is much better off if we treat it specially.
 */
function GmailAccount() {
}
GmailAccount.prototype = {
  type: 'gmail-imap',

};

const ACCOUNT_TYPE_TO_CLASS = {
  'imap': ImapAccount,
  //'gmail-imap': GmailAccount,
};

}); // end define
