import logic from 'logic';
import * as client from './client';
import DisasterRecovery from '../../disaster-recovery';

function SmtpAccount(universe, compositeAccount, accountId, credentials,
                     connInfo) {
  this.universe = universe;
  logic.defineScope(this, 'Account', { accountId: accountId,
                                       accountType: 'smtp' });
  this.compositeAccount = compositeAccount;
  this.accountId = accountId;
  this.credentials = credentials;
  this.connInfo = connInfo;
  this._activeConnections = [];
}

SmtpAccount.prototype = {
  type: 'smtp',
  toString: function() {
    return '[SmtpAccount: ' + this.id + ']';
  },

  get numActiveConns() {
    return this._activeConnections.length;
  },

  shutdown: function() {
    // Nothing to do.
  },

  accountDeleted: function() {
    this.shutdown();
  },

  /**
   * Asynchronously send an e-mail message.  Does not provide retries, offline
   * remembering of the command, or any follow-on logic like appending the
   * message to the sent folder.
   *
   * The error codes are one of the following (not sure how to expose this in
   * JSDoc3 without creating a static object that exists only for
   * documentation and that ends up potentially far away):
   *
   * - null: No error, message sent successfully.
   * - bad-user-or-pass: Authentication problem.  This should probably be
   *   escalated to the user so they can fix their password.
   * - bad-sender: We logged in, but it didn't like our sender e-mail.
   * - bad-recipient: There were one or more bad recipients; they are listed in
   *   the `badAddresses` property.
   * - bad-message: It failed during the sending of the message.
   * - server-maybe-offline: The server won't let us login, maybe because of a
   *   bizarre "offline for service" strategy?  (We've seen this with IMAP
   *   before...)  This should be considered a fatal problem during probing or
   *   if it happens consistently.
   * - insecure: We couldn't establish a secure connection.
   * - connection-lost: The connection went away, we don't know why.  Could be a
   *   transient thing, could be a jerky server, who knows.
   * - unknown: Some other error.  Internal error reporting/support should
   *   ideally be logging this somehow.
   *
   * @param {MailComposer} composedMessage
   *   A mailcomposer instance that has already generated its message payload
   *   to its _outputBuffer field.  We previously used streaming generation,
   *   but have abandoned this for now for IMAP Sent folder saving purposes.
   *   Namely, our IMAP implementation doesn't support taking a stream for
   *   APPEND right now, and there's no benefit to doing double the work and
   *   generating extra garbage.
   * @return {Promise<({err, badAddresses}>}
   */
  sendMessage: function(composer) {
    return new Promise((resolve) => {
      this.establishConnection({
        /**
         * Send the envelope.
         * @param conn
         * @param {function()} bail Abort the connection. Used for when
         * we must gracefully cancel without sending a message.
         */
        sendEnvelope: (conn) => {
          var envelope = composer.getEnvelope();
          logic(this, 'sendEnvelope', { _envelope: envelope });
          conn.useEnvelope(envelope);
        },

        // establishConnection monekypatches/wraps the connection so that drain
        // notfications are converted into these progress notifications.
        onProgress: () => {
          // Keep the wake lock open as long as it looks like we're
          // still communicating with the server.
          composer.heartbeat('SMTP Progress');
        },
        /**
         * Send the message body.
         */
        sendMessage: (conn) => {
          var blob = composer.superBlob;

          // Then send the actual message if everything was cool
          logic(this, 'sending-blob', { size: blob.size });
          // simplesmtp's SMTPClient does not understand Blobs, so we
          // issue the write directly. All that it cares about is
          // knowing whether our data payload included a trailing
          // \r\n. We had hoped to avoid this silliness in bug 885110,
          // but SMTPClient still does not support blobs yet, so we
          // still need this.
          conn.socket.send(blob);
          // SMTPClient tracks the last bytes it has written in _lastDataBytes
          // to this end and writes the \r\n if they aren't the last bytes
          // written.  Since we know that mailcomposer always ends the buffer
          // with \r\n we just set that state directly ourselves.
          conn._lastDataBytes = '\r\n';

          // this does not actually terminate the connection; just tells the
          // client to flush stuff, etc.
          conn.end();
        },

        /**
         * The send succeeded.
         */
        onSendComplete: (/* conn */) => {
          logic(this, 'smtp:sent');
          resolve({ error: null });
        },
        /**
         * The send failed.
         */
        onError: (error, badAddresses) => {
          logic(this, 'smtp:error',
                {
                  error,
                  badAddresses
                });
          resolve({ error, badAddresses });
        }
      });
    });
  },

  /**
   * Check the account credentials by connecting to the server. Calls
   * back with an error if we had a problem (see sendMessage for
   * details), or no arguments if we succeeded.
   *
   * @return {Promise<ErrorString>}
   */
  checkAccount: function() {
    return new Promise((resolve) => {
      this.establishConnection({
        sendEnvelope: (conn, bail) => {
          // If we get here, we've successfully connected. Sorry, SMTP
          // server friend, we aren't actually going to send a message
          // now. Psych!
          resolve(null);
          bail();
        },
        sendMessage: (/* conn */) => {
          // We're not sending a message, so this won't be called.
        },
        onSendComplete: (/* conn */) => {
          // Ibid.
        },
        onError: (err /*, badAddresses */) => {
          // Aha, here we have an error -- we might have bad credentials
          // or something else. This error is normalized per the
          // documentation for sendMessage, so we can just pass it along.

          // We only report auth errors. When checking the account,
          // transient server connection errors don't matter; and we're
          // not trying to send a message.
          // XXX the consumer should handle error logging.
          if (err === 'bad-user-or-pass') {
            this.universe.__reportAccountProblem(
              this.compositeAccount, err, 'outgoing');
          }
          resolve(err);
        }
      });
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
    var conn;
    var sendingMessage = false;
    client.createSmtpConnection(
      this.credentials,
      this.connInfo,
      () => {
        return new Promise((resolve) => {
          // Note: Since we update the credentials object in-place,
          // there's no need to explicitly assign the changes here;
          // just save the account information.
          this.universe.saveAccountDef(
            this.compositeAccount.accountDef,
            /* folderInfo: */ null,
            /* callback: */ resolve);
        });
      }
    ).then((newConn) => {
      conn = newConn;
      DisasterRecovery.associateSocketWithAccount(conn.socket, this);
      this._activeConnections.push(conn);

      // Intercept the 'ondrain' event, which is as close as we can
      // get to knowing that we are still sending data to the
      // server. We use this to hold a wakelock open.
      var oldOnDrain = conn.socket.ondrain;
      conn.socket.ondrain = () => {
        oldOnDrain && oldOnDrain.call(conn.socket);
        callbacks.onProgress && callbacks.onProgress();
      };

      callbacks.sendEnvelope(conn, conn.close.bind(conn));

      // We sent the envelope; see if we can now send the message.
      conn.onready = (badRecipients) => {
        logic(this, 'onready');

        if (badRecipients.length) {
          conn.close();
          logic(this, 'bad-recipients', { badRecipients: badRecipients });
          callbacks.onError('bad-recipient', badRecipients);
        } else {
          sendingMessage = true;
          callbacks.sendMessage(conn);
        }
      };

      // Done sending the message, ideally successfully.
      conn.ondone = (success) => {
        conn.close();

        if (success) {
          logic(this, 'sent');
          callbacks.onSendComplete(conn);
        } else {
          logic(this, 'send-failed');
          // We don't have an error to reference here, but we stored
          // the most recent SMTP error, which should tell us why the
          // server rejected the message.
          var err = client.analyzeSmtpError(conn, null, sendingMessage);
          callbacks.onError(err, /* badAddresses: */ null);
        }
      };

      conn.onerror = (err) => {
        // Some sort of error occurred; analyze and report.
        conn.close();
        err = client.analyzeSmtpError(conn, err, sendingMessage);
        callbacks.onError(err, /* badAddresses: */ null);
      };

      conn.onclose = () => {
        logic(this, 'onclose');

        var idx = this._activeConnections.indexOf(conn);
        if (idx !== -1) {
          this._activeConnections.splice(idx, 1);
        } else {
          logic(this, 'dead-unknown-connection');
        }
      };
    })
      .catch((err) => {
        err = client.analyzeSmtpError(conn, err, sendingMessage);
        callbacks.onError(err);
      });
  }

};

export {
  SmtpAccount,
  SmtpAccount as Account,
};

