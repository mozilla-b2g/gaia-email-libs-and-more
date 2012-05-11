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

function SmtpProber(connInfo, callback) {
  console.log("PROBE:SMTP attempting to connect to", connInfo.hostname);
  this._conn = $simplesmtp(
    connInfo.port, connInfo.hostname,
    {
      secureConnection: connInfo.crypto === 'ssl',
      ignoreTLS: connInfo.crypto === false,
      auth: { user: connInfo.username, pass: connInfo.password },
      debug: true,
    });
  this._conn.on('idle', this.onIdle.bind(this));
  this._conn.on('error', this.onBadness.bind(this));
  this._conn.on('end', this.onBadness.bind(this));

  this.callback = callback;
}
exports.SmtpProber = SmtpProber;
SmtpProber.prototype = {
  /**
   * onIdle happens after successful login, and so is what our probing uses.
   */
  onIdle: function() {
    if (this.callback) {
      console.log("PROBE:SMTP happy");
      this.callback(true);
      this.callback = null;
    }
    this.close();
  },

  onBadness: function() {
    if (this.callbac) {
      console.warn("PROBE:SMTP sad");
      this.callback(false);
      this.callback = null;
    }
  },
};

}); // end define
