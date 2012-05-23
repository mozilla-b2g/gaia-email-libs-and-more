/**
 *
 **/

define(
  [
    'rdcommon/log',
    'simplesmtp/lib/client',
    'module',
    'exports'
  ],
  function(
    $log,
    $simplesmtp,
    $module,
    exports
  ) {

function SmtpAccount(accountId, credentials, connInfo, _parentLog) {
  this.accountId = accountId;
  this.credentials = credentials;
  this.connInfo = connInfo;
}
exports.SmtpAccount = SmtpAccount;
SmtpAccount.prototype = {
  type: 'smtp',
  toString: function() {
    return '[SmtpAccount: ' + this.id + ']';
  },

  _makeConnection: function() {
    var conn = $simplesmtp(
      this.connInfo.port, this.connInfo.hostname,
      {
        secureConnection: this.connInfo.crypto === true,
        ignoreTLS: this.connInfo.crypto === false,
        auth: {
          user: this.credentials.username,
          pass: this.credentials.password
        },
        // XXX debug is on
        debug: true,
      });
    return conn;
  },

  /**
   * @args[
   *   @param[callback @func[
   *     @args[
   *       @param[error @oneof[
   *         @case[null]{
   *           No error, message sent successfully.
   *         }
   *         @case['auth']{
   *           Authentication problem.  This should probably be escalated to
   *           the user so they can fix their password.
   *         }
   *         @case['bad-sender']{
   *           We logged in, but it didn't like our sender e-mail.
   *         }
   *         @case['bad-recipient']{
   *           There were one or more bad recipients; they are listed in the
   *           next argument.
   *         }
   *         @case['bad-message']{
   *           It failed during the sending of the message.
   *         }
   *         @case['server-maybe-offline']{
   *           The server won't let us login, maybe because of a bizarre offline
   *           for service strategy?  (We've seen this with IMAP before...)
   *
   *           This should be considered a fatal problem during probing or if
   *           it happens consistently.
   *         }
   *         @case['insecure']{
   *           We couldn't establish a secure connection.
   *         }
   *         @case['connection-lost']{
   *           The connection went away, we don't know why.  Could be a
   *           transient thing, could be a jerky server, who knows.
   *         }
   *         @case['unknown']{
   *           Some other error.  Internal error reporting/support should
   *           ideally be logging this somehow.
   *         }
   *       ]]
   *       @param[badAddresses @listof[String]]
   *     ]
   *   ]
   * ]
   */
  sendMessage: function(composedMessage, callback) {
    var conn = this._makeConnection(), bailed = false, sendingMessage = false;

    // - Optimistic case
    // Send the envelope once the connection is ready (fires again after
    // ready too.)
    conn.once('idle', function() {
        conn.useEnvelope(composedMessage.getEnvelope());
      });
    // Then send the actual message if everything was cool
    conn.on('message', function() {
        if (bailed)
          return;
        sendingMessage = true;
        composedMessage.streamMessage();
        composedMessage.pipe(conn);
      });
    // And close the connection and be done once it has been sent
    conn.on('ready', function() {
        bailed = true;
        conn.close();
        callback(null);
      });

    // - Error cases
    // It's possible for the server to decide some, but not all, of the
    // recipients are gibberish.  Since we are a mail client and talking to
    // a smarthost and not the final destination (most of the time), this
    // is not super likely.
    //
    // We upgrade this to a full failure to send
    conn.on('rcptFailed', function(addresses) {
        // nb: this gets called all the time, even without any failures
        if (addresses.length) {
          bailed = true;
          // simplesmtp does't view this as fatal, so we have to close it ourself
          conn.close();
          callback('bad-recipient', addresses);
        }
      });
    conn.on('error', function(err) {
        if (bailed) // (paranoia, this shouldn't happen.)
          return;
        var reportAs = null;
        switch (err.name) {
          // no explicit error type is given for: a bad greeting, failure to
          // EHLO/HELO, bad login sequence, OR a data problem during send.
          // The first 3 suggest a broken server or one that just doesn't want
          // to talk to us right now.
          case 'Error':
            if (sendingMessage)
              reportAs = 'bad-message';
            else
              reportAs = 'server-maybe-offline';
            break;
          case 'AuthError':
            reportAs = 'auth';
            break;
          case 'UnknownAuthError':
            reportAs = 'server-maybe-offline';
            break;
          case 'TLSError':
            reportAs = 'insecure';
            break;

          case 'SenderError':
            reportAs = 'bad-sender';
            break;
          // no recipients (bad message on us) or they all got rejected
          case 'RecipientError':
            reportAs = 'bad-recipient';
            break;

          default:
            reportAs = 'unknown';
            break;
        }
        bailed = true;
        callback(reportAs, null);
        // the connection gets automatically closed.
      });
      conn.on('end', function() {
        if (bailed)
          return;
        callback('connection-lost', null);
        bailed = true;
        // (the connection is already closed if we are here)
      });
  },


};

var LOGFAB = exports.LOGFAB = $log.register($module, {
  SmtpAccount: {
    type: $log.ACCOUNT,
    events: {
    },
    TEST_ONLY_events: {
    },
    errors: {
      folderAlreadyHasConn: { folderId: false },
    },
  },
});

}); // end define
