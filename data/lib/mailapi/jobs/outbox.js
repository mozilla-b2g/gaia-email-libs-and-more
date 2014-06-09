'use strict';
/**
 * This module exposes a single helper method,
 * `sendNextAvailableOutboxMessage`, which is used by the
 * sendOutboxMessages job in jobmixins.js.
 */
define(function(require) {


  /**
   * Send the next available outbox message. Returns a promise that
   * resolves to the following:
   *
   * {
   *   moreExpected: (Boolean),
   *   messageNamer: { date, suid }
   * }
   *
   * If there might be more messages left to send after this one,
   * moreExpected will be `true`.
   *
   * If we attempted to send a message, messageNamer will point to it.
   * This can then be passed to a subsequent invocation of this, to
   * send the next available message after the given messageNamer.
   *
   * @param {CompositeAccount|ActiveSyncAccount} account
   * @param {FolderStorage} storage
   * @param {MessageNamer|null} beforeMessage
   *   Send the first message chronologically preceding `beforeMessage`.
   * @param {Boolean} emitNotifications
   *   If true, we will emit backgroundSendStatus notifications
   *   for this message.
   * @param {Boolean} outboxNeedsFreshSync
   *   If true, ignore any potentially stale "sending" state,
   *   as in when we restore the app from a crash.
   * @param {SmartWakeLock} wakeLock
   *   A SmartWakeLock to be held open during the sending process.
   * @return {Promise}
   * @public
   */
  function sendNextAvailableOutboxMessage(
    account, storage, beforeMessage, emitNotifications,
    outboxNeedsFreshSync, wakeLock) {

    return getNextHeader(storage, beforeMessage).then(function(header) {
      // If there are no more messages to send, resolve `null`. This
      // should ordinarily not happen, because clients should pay
      // attention to the `moreExpected` results from earlier sends;
      // but job scheduling might introduce edge cases where this
      // happens, so better to be safe.
      if (!header) {
        return {
          moreExpected: false,
          messageNamer: null
        };
      }

      if (!header.sendStatus) {
        header.sendStatus = {};
      }

      // If the header has not been sent, or we've been instructed to
      // ignore any existing sendStatus, clear it out.
      if (header.sendStatus.state !== 'sending' || outboxNeedsFreshSync) {
        // If this message is not already being sent, send it.
        return constructComposer(account, storage, header, wakeLock)
          .then(sendMessage.bind(null, account, storage, emitNotifications))
          .then(function(header) {
            // Figure out if this was the last message in the outbox.
            // If `storage` is empty, getOldestMessageTimestamp
            // returns zero.
            var oldestDate = storage.getOldestMessageTimestamp();
            return {
              moreExpected: oldestDate > 0 && header.date !== oldestDate,
              messageNamer: {
                suid: header.suid,
                date: header.date
              }
            };
          });
      } else {
        // If this message is currently being sent, advance to the
        // next header.
        return sendNextAvailableOutboxMessage(account, storage, {
          suid: header.suid,
          date: header.date
        }, emitNotifications, outboxNeedsFreshSync, wakeLock);
      }
    });
  }


  ////////////////////////////////////////////////////////////////
  // The following functions are internal helpers.

  /**
   * Resolve to the header immediately preceding `beforeMessage` in
   * time. If beforeMessage is null, resolve the most recent message.
   * If no message could be found, resolve `null`.
   *
   * @param {FolderStorage} storage
   * @param {MessageNamer} beforeMessage
   * @return {Promise(MailHeader)}
   */
  function getNextHeader(storage, /* optional */ beforeMessage) {
    return new Promise(function(resolve) {
      if (beforeMessage) {
        // getMessagesBeforeMessage expects an 'id', not a 'suid'.
        var id = parseInt(beforeMessage.suid.substring(
          beforeMessage.suid.lastIndexOf('/') + 1));
        storage.getMessagesBeforeMessage(
          beforeMessage.date,
          id,
          /* limit = */ 1,
          function(headers, moreExpected) {
            resolve(headers[0]);
          });
      } else {
        storage.getMessagesInImapDateRange(
          0,
          null,
          /* min */ 1,
          /* max */ 1,
          function(headers, moreExpected) {
            resolve(headers[0]);
          });
      }
    });
  }

  /**
   * Build a Composer instance pointing to the given header.
   *
   * @param {MailAccount} account
   * @param {FolderStorage} storage
   * @param {MailHeader} header
   * @param {SmartWakeLock} wakeLock
   * @return {Promise(Composer)}
   */
  function constructComposer(account, storage, header, wakeLock) {
    return new Promise(function(resolve) {
      storage.getMessage(header.suid, header.date, function(msg) {
        require(['mailapi/drafts/composer'], function(cmp) {

          var composer = new cmp.Composer(msg, account, account.identities[0]);
          composer.setSmartWakeLock(wakeLock);

          resolve(composer);
        });
      });
    });
  }

  /**
   * Attempt to send the given message from the outbox.
   *
   * During the sending process, post status updates to the universe,
   * so that the frontend can display status notifications if it
   * desires.
   *
   * If the message successfully sends, remove it from the outbox;
   * otherwise, its `sendStatus.state` will equal 'error', with
   * details about the failure.
   *
   * Resolves to the header; you can check `header.sendStatus` to see
   * the result of this send attempt.
   *
   * @param {MailAccount} account
   * @param {FolderStorage} storage
   * @param {Composer} composer
   * @return {Promise(MailHeader)}
   */
  function sendMessage(account, storage, emitNotifications, composer) {
    var header = composer.header;
    var progress = publishStatus.bind(
      null, account, storage, composer, header, emitNotifications);

    // As part of the progress notification, the client would like to
    // know whether or not they can expect us to immediately send more
    // messages after this one. If there are messages in the outbox
    // older than this one, the answer is yes.
    var oldestDate = storage.getOldestMessageTimestamp();
    var willSendMore = oldestDate > 0 && oldestDate < header.date.valueOf();

    // Send the initial progress information.
    progress({
      state: 'sending',
      err: null,
      badAddresses: null,
      sendFailures: header.sendStatus && header.sendStatus.sendFailures || 0
    });

    return new Promise(function(resolve) {
      account.sendMessage(composer, function(err, badAddresses) {
        if (err) {
          console.log('Message failed to send (' + err + ')');

          progress({
            state: 'error',
            err: err,
            badAddresses: badAddresses,
            sendFailures: (header.sendStatus.sendFailures || 0) + 1
          });

          resolve(composer.header);
        } else {
          console.log('Message sent; deleting from outbox.');

          progress({
            state: 'success',
            err: null,
            badAddresses: null
          });
          storage.deleteMessageHeaderAndBodyUsingHeader(header, function() {
           resolve(composer.header);
          });
        }
      });
    });
  }

  /**
   * Update the header's send status to the given data, and publish it
   * to the universe.
   */
  function publishStatus(account, storage, composer,
                         header, emitNotifications, status) {
    header.sendStatus = status;

    storage.updateMessageHeader(
      header.date,
      header.id,
      /* partOfSync */ false,
      header,
      /* body hint */ null,
      function() {
        status.accountId = account.id;
        status.suid = header.suid;
        status.emitNotifications = emitNotifications;

        // <test-support>
        status.messageId = composer.messageId;
        status.sentDate = composer.sentDate;
        // </test-support>

        account.universe.__notifyBackgroundSendStatus(status);
      });
  }

  return {
    sendNextAvailableOutboxMessage: sendNextAvailableOutboxMessage
  };
});
