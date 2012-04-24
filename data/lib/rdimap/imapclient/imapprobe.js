/**
 * Validates connection information for an account and verifies the server on
 * the other end is something we are capable of sustaining an account with.
 * Before growing this logic further, first try reusing/adapting/porting the
 * Thunderbird autoconfiguration logic.
 **/

define(
  [
    'imap',
    'exports'
  ],
  function(
    $imap,
    exports
  ) {

function ImapProber(connInfo) {
  this._conn = new $imap.ImapConnection(connInfo);
  this._conn.connect(this.onConnect.bind(this));

  this.onresult = null;
  this.accountGood = null;
}
exports.ImapProber = ImapProber;
ImapProber.prototype = {
  onConnect: function(err) {
    if (err)
      this.accountGood = false;
    else
      this.accountGood = true;
    this._conn.close();

    if (this.onresult)
      this.onresult(this.accountGood);
  },
};

}); // end define
