/**
 *
 **/

define(
  [
    'simplesmtp/lib/client',
    'exports'
  ],
  function(
    $simplesmtp,
    exports
  ) {

function SmtpProber(credentials, connInfo) {
  console.log("PROBE:SMTP attempting to connect to", connInfo.hostname);
  this._conn = $simplesmtp(
    connInfo.port, connInfo.hostname,
    {
      secureConnection: connInfo.crypto === true,
      ignoreTLS: connInfo.crypto === false,
      auth: { user: credentials.username, pass: credentials.password },
      debug: false,
    });
  this._conn.on('idle', this.onIdle.bind(this));
  this._conn.on('error', this.onBadness.bind(this));
  this._conn.on('end', this.onBadness.bind(this));

  this.onresult = null;
}
exports.SmtpProber = SmtpProber;
SmtpProber.prototype = {
  /**
   * onIdle happens after successful login, and so is what our probing uses.
   */
  onIdle: function() {
    console.log('onIdle!');
    if (this.onresult) {
      console.log("PROBE:SMTP happy");
      this.onresult(true);
      this.onresult = null;
    }
    this._conn.close();
  },

  onBadness: function() {
    if (this.onresult) {
      console.warn("PROBE:SMTP sad");
      this.onresult(false);
      this.onresult = null;
    }
  },
};

}); // end define
