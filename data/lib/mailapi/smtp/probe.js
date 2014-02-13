/**
 * SMTP probe logic.
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

var setTimeoutFunc = window.setTimeout.bind(window),
    clearTimeoutFunc = window.clearTimeout.bind(window);

exports.TEST_useTimeoutFuncs = function(setFunc, clearFunc) {
  setTimeoutFunc = setFunc;
  clearTimeoutFunc = clearFunc;
};

exports.TEST_USE_DEBUG_MODE = false;

/**
 * How many milliseconds should we wait before giving up on the connection?
 *
 * I have a whole essay on the rationale for this in the IMAP prober.  Us, we
 * just want to use the same value as the IMAP prober.  This is a candidate for
 * centralization.
 */
exports.CONNECT_TIMEOUT_MS = 30000;

/**
 * Validate that we find an SMTP server using the connection info and that it
 * seems to like our credentials.
 *
 * Because the SMTP client has no connection timeout support, use our
 * own timer to decide when to give up on the SMTP connection. We use
 * the timer for the whole process, including even after the
 * connection is established and we probe for a valid address.
 *
 * The process here is in two steps: First, connect to the server and
 * make sure that we can authenticate properly. Then, if that
 * succeeds, we send a "MAIL FROM:<our address>" line to see if the
 * server will reject the e-mail address, followed by "RCPT TO" for
 * the same purpose. This could fail if the user uses manual setup and
 * gets everything right except for their e-mail address. We want to
 * catch this error before they complete account setup; if we don't,
 * they'll be left with an account that can't send e-mail, and we
 * currently don't allow them to change their address after setup.
 */
function SmtpProber(credentials, connInfo) {
  console.log("PROBE:SMTP attempting to connect to", connInfo.hostname);
  this._conn = $simplesmtp(
    connInfo.port, connInfo.hostname,
    {
      crypto: connInfo.crypto,
      auth: { user: credentials.username, pass: credentials.password },
      debug: exports.TEST_USE_DEBUG_MODE,
    });

  // For the first step (connection/authentication), handle callbacks
  // in this.onConnectionResult.
  this.setConnectionListenerCallback(this.onConnectionResult);

  this.timeoutId = setTimeoutFunc(function() {
    // Emit a fake error from the connection so that we can send the
    // error to the proper callback handler depending on what state
    // the connection is in.
    this._conn.emit('error', 'unresponsive-server');
  }.bind(this), exports.CONNECT_TIMEOUT_MS);

  this.emailAddress = connInfo.emailAddress;
  this.onresult = null;
  this.error = null;
  this.errorDetails = { server: connInfo.hostname };
}
exports.SmtpProber = SmtpProber;
SmtpProber.prototype = {

  /**
   * Unsubscribe any existing listeners, and resubscribe to all
   * relevant events for the given fn handler.
   */
  setConnectionListenerCallback: function(fn) {
    this._conn.removeAllListeners();
    // onIdle happens after successful login, and so is what our probing uses.
    this._conn.on('idle', fn.bind(this, null));
    this._conn.on('error', fn.bind(this));
    this._conn.on('end', fn.bind(this, 'unknown'));
  },

  /**
   * Callback for initial connection, before we check for address
   * validity. Connection and security errors will happen here.
   */
  onConnectionResult: function(err) {
    if (!this.onresult)
      return; // We already handled the result.

    // XXX just map all security errors as indicated by name
    if (err && typeof(err) === 'object') {
      if (err.name && /^Security/.test(err.name)) {
        err = 'bad-security';
      } else {
        switch (err.name) {
        case 'AuthError':
          err = 'bad-user-or-pass';
          break;
        case 'UnknownAuthError':
        default:
          err = 'server-problem';
          break;
        }
      }
    }

    if (err) {
      this.cleanup(err);
    } else {
      console.log('PROBE:SMTP connected, checking address validity');
      // For clarity, send callbacks to onAddressValidityResult.
      this.setConnectionListenerCallback(this.onAddressValidityResult);
      this._conn.useEnvelope({
        from: this.emailAddress,
        to: [this.emailAddress]
      });
      this._conn.on('message', function() {
        // Success! Our recipient was valid.
        this.onAddressValidityResult(null);
      }.bind(this));
    }
  },

  /**
   * The server will respond to a "MAIL FROM" probe, indicating
   * whether or not the e-mail address is invalid. We try to succeed
   * unless we're positive that the server actually rejected the
   * address (in other words, any error other than "SenderError" is
   * ignored).
   */
  onAddressValidityResult: function(err) {
    if (!this.onresult)
      return; // We already handled the result.

    if (err && (err.name === 'SenderError' ||
                err.name === 'RecipientError')) {
      err = 'bad-address';
    } else if (err && err.name) {
      // This error wasn't normalized (so it's not
      // "unresponsive-server"); we don't expect any auth or
      // connection failures here, so treat it as an unknown error.
      err = 'server-problem';
    }
    this.cleanup(err);
  },

  /**
   * Send the final probe result (with error or not) and close the
   * SMTP connection.
   */
  cleanup: function(err) {
    clearTimeoutFunc(this.timeoutId);

    if (err) {
      console.warn('PROBE:SMTP sad. error: | ' + (err && err.name || err) +
                   ' | '  + (err && err.message || '') + ' |');
    } else {
      console.log('PROBE:SMTP happy');
    }

    this.error = err;
    this.onresult(this.error, this.errorDetails);
    this.onresult = null;

    this._conn.close();
  }
};

}); // end define
