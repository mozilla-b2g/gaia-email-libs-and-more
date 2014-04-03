/**
 *
 **/

define(
  [
    'rdcommon/log',
    'module',
    'require',
    'exports'
  ],
  function(
    $log,
    $module,
    require,
    exports
  ) {

/**
 * Debug flag for use by unit tests to tell us to turn on debug logging of
 * sending SMTP messages.  The output is unstructured and goes to console.log
 * mainly with some weird unicode chars, but it's better than nothing.
 */
exports.ENABLE_SMTP_LOGGING = false;

function SmtpAccount(universe, compositeAccount, accountId, credentials,
                     connInfo, _parentLog) {
  this.universe = universe;
  this.compositeAccount = compositeAccount;
  this.accountId = accountId;
  this.credentials = credentials;
  this.connInfo = connInfo;

  this._LOG = LOGFAB.SmtpAccount(this, _parentLog, accountId);

  this._activeConnections = [];
}
exports.Account = exports.SmtpAccount = SmtpAccount;
SmtpAccount.prototype = {
  type: 'smtp',
  toString: function() {
    return '[SmtpAccount: ' + this.id + ']';
  },

  get numActiveConns() {
    return this._activeConnections.length;
  },

  shutdown: function(callback) {
    // (there should be no live connections during a unit-test initiated
    // shutdown.)
    this._LOG.__die();
  },

  accountDeleted: function() {
    this.shutdown();
  },

  /**
   * Asynchronously send an e-mail message.  Does not provide retries, offline
   * remembering of the command, or any follow-on logic like appending the
   * message to the sent folder.
   *
   * @args[
   *   @param[composedMessage MailComposer]{
   *     A mailcomposer instance that has already generated its message payload
   *     to its _outputBuffer field.  We previously used streaming generation,
   *     but have abandoned this for now for IMAP Sent folder saving purposes.
   *     Namely, our IMAP implementation doesn't support taking a stream for
   *     APPEND right now, and there's no benefit to doing double the work and
   *     generating extra garbage.
   *   }
   *   @param[callback @func[
   *     @args[
   *       @param[error @oneof[
   *         @case[null]{
   *           No error, message sent successfully.
   *         }
   *         @case['bad-user-or-pass']{
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
  sendMessage: function(composer, callback) {
    this.establishConnection({
      /**
       * Send the envelope.
       * @param conn
       * @param {function()} bail Abort the connection. Used for when
       * we must gracefully cancel without sending a message.
       */
      sendEnvelope: function(conn, bail) {
        // - Optimistic case
        // Send the envelope once the connection is ready (fires again after
        // ready too.)
        console.log('smtp: idle reached, sending envelope');
        conn.useEnvelope(composer.getEnvelope());
      },
      /**
       * Send the message body.
       */
      sendMessage: function(conn) {
        // Then send the actual message if everything was cool
        console.log('smtp: message reached, building message blob');
        composer.withMessageBlob({ includeBcc: false }, function(blob) {
          console.log('smtp: blob composed, writing blob');
          // simplesmtp's SMTPClient does not understand Blobs, so we issue
          // the write directly.  All that it cares about is knowing whether
          // our data payload included a trailing \r\n.  Our long term plan
          // to avoid this silliness is to switch to using firemail's fork of
          // simplesmtp or something equally less hacky; see bug 885110.
          conn.socket.write(blob);
          // SMTPClient tracks the last bytes it has written in _lastDataBytes
          // to this end and writes the \r\n if they aren't the last bytes
          // written.  Since we know that mailcomposer always ends the buffer
          // with \r\n we just set that state directly ourselves.
          conn._lastDataBytes[0] = 0x0d;
          conn._lastDataBytes[1] = 0x0a;
          // put some data in the console.log if in debug mode too
          if (conn.options.debug) {
            console.log('CLIENT (DATA) blob of size:', blob.size);
          }
          // this does not actually terminate the connection; just tells the
          // client to flush stuff, etc.
          conn.end();
        });
      },
      /**
       * The send succeeded.
       */
      onSendComplete: function(conn) {
        console.log('smtp: send completed, closing connection');
        callback(null);
      },
      /**
       * The send failed.
       */
      onError: function(err, badAddresses) {
        callback(err, badAddresses);
      }
    });
  },

  /**
   * Check the account credentials by connecting to the server. Calls
   * back with an error if we had a problem (see sendMessage for
   * details), or no arguments if we succeeded.
   *
   * @param {function(err)} callback
   */
  checkAccount: function(callback) {
    this.establishConnection({
      sendEnvelope: function(conn, bail) {
        // If we get here, we've successfully connected. Sorry, SMTP
        // server friend, we aren't actually going to send a message
        // now. Psych!
        bail(); // bail so that we don't receive onError too
        callback();
      },
      sendMessage: function(conn) {
        // We're not sending a message, so this won't be called.
      },
      onSendComplete: function(conn) {
        // Ibid.
      },
      onError: function(err, badAddresses) {
        // Aha, here we have an error -- we might have bad credentials
        // or something else. This error is normalized per the
        // documentation for sendMessage, so we can just pass it along.

        // We only report auth errors. When checking the account,
        // transient server connection errors don't matter; and we're
        // not trying to send a message.
        if (err === 'bad-user-or-pass') {
          this.universe.__reportAccountProblem(
            this.compositeAccount, err, 'outgoing');
        }
        callback(err);
      }.bind(this)
    });
  },

  /**
   * Abstract out connection management so that we can do different
   * things with the connection (i.e. just test login credentials, or
   * actually send a message).
   *
   * Callbacks is an object with the following functions, all required:
   *
   * sendEnvelope(conn) -- you should send the envelope
   * sendMessage(conn) -- you should send the message body
   * onSendComplete(conn) -- the message was successfully sent
   * onError(err, badAddresses) -- send failed (or connection error)
   */
  establishConnection: function(callbacks) {
    console.log('smtp: requiring code');
    require(['simplesmtp/lib/client'], function ($simplesmtp) {
      var conn, bailed = false, sendingMessage = false;
      console.log('smtp: code loaded');

      conn = $simplesmtp(
        this.connInfo.port, this.connInfo.hostname,
        {
          crypto: this.connInfo.crypto,
          auth: {
            // Someday, `null` might be a valid value, so be careful here
            user: (this.credentials.outgoingUsername !== undefined ?
                   this.credentials.outgoingUsername :
                   this.credentials.username),
            pass: (this.credentials.outgoingPassword !== undefined ?
                   this.credentials.outgoingPassword :
                   this.credentials.password),
          },
          debug: exports.ENABLE_SMTP_LOGGING,
        });

      this._activeConnections.push(conn);

      function bail() {
        bailed = true;
        conn.close();
      }

      conn.once('idle', function() {
        callbacks.sendEnvelope(conn, bail);
      });
      conn.on('message', function() {
        if (bailed) {
          return;
        }
        sendingMessage = true;
        callbacks.sendMessage(conn);
      });
      // And close the connection and be done once it has been sent
      conn.on('ready', function() {
        bailed = true;
        conn.close();
        callbacks.onSendComplete(conn);
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
          console.warn('smtp: nonzero bad recipients');
          bailed = true;
          // simplesmtp doesn't view this as fatal, so we have to close it
          conn.close();
          callbacks.onError('bad-recipient', addresses);
        }
      });
      conn.on('error', function(err) {
        if (bailed) // (paranoia, this shouldn't happen.)
          return;
        var reportAs = null;
        console.error('smtp: error:', err.name);
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
            reportAs = 'bad-user-or-pass';
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
        callbacks.onError(reportAs, null);
        // the connection gets automatically closed.
      });
      conn.on('end', function() {
        console.log('smtp: connection ended');
        var idx = this._activeConnections.indexOf(conn);
        if (idx !== -1)
          this._activeConnections.splice(idx, 1);
        else
          console.error('Dead unknown connection?');
        if (bailed)
          return;
        callbacks.onError('connection-lost', null);
        bailed = true;
        // (the connection is already closed if we are here)
      }.bind(this));
    }.bind(this));
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
