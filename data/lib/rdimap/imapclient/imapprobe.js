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

/**
 * Right now our tests consist of:
 * - logging in to test the credentials
 *
 * If we succeed at that, we hand off the established connection to our caller
 * so they can reuse it.
 */
function ImapProber(credentials, connInfo, _LOG) {
  var opts = {
    hostname: connInfo.hostname,
    port: connInfo.port,
    crypto: connInfo.crypto,

    username: credentials.username,
    password: credentials.password,
  };
  if (_LOG)
    opts._logParent = _LOG;

  console.log("PROBE:IMAP attempting to connect to", connInfo.hostname);
  this._conn = new $imap.ImapConnection(opts);
  this._conn.connect(this.onConnect.bind(this));

  this.onresult = null;
  this.accountGood = null;
}
exports.ImapProber = ImapProber;
ImapProber.prototype = {
  onConnect: function ImapProber_onConnect(err) {
    if (err) {
      console.warn("PROBE:IMAP sad");
      this.accountGood = false;
      this._conn = null;
    }
    else {
      console.log("PROBE:IMAP happy");
      this.accountGood = true;
    }

    var conn = this._conn;
    this._conn = null;

    if (this.onresult)
      this.onresult(this.accountGood, conn);
  },
};

}); // end define
