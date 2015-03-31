define((require) => {

  var logic = require('logic');
  var pop3 = require('pop3/pop3');
  var accountcommon = require('accountcommon');


  /**
   * options:
   *   - type (imap/pop3/activesync)
   *   - controlServerBaseUrl (string)
   *
   *   - imapExtensions (array), default ['RFC2195']
   *   - smtpExtensions
   *   - deliveryMode
   *   - oauth
   *   - date
   *   - emailAddress (string)
   *   - password (string)
   */
  function FakeServer(options) {
    options.imapExtensions = options.imapExtensions || ['RFC2195'];
    this.imapExtensions = options.imapExtensions;
    this.type = options.type;
    this.options = options;
    this.backdoorUrl = null;
    this.serverInfo = null;
    this.date = options.date || null;
    this.timezoneMins = (options.useTimezoneMins != null ?
                         options.useTimezoneMins : 0);

    if (options.account) {
      this.setAccount(options.account);
    }

    // for pop3
    this.folderMessages = {};

    logic.defineScope(this, 'FakeServer');

    this.serverInfo = this.backdoor({
      command: (this.type === 'imap' ? 'make_imap_and_smtp' :
                (this.type === 'pop3' ? 'make_pop3_and_smtp' :
                 'make_activesync')),
      credentials: {
        username: extractUsernameFromEmail(options.emailAddress),
        password: options.password
      },
      options: {
        imapExtensions: options.imapExtensions,
        folderConfig: options.folderConfig || null,
        useTimezoneMins: this.timezoneMins,
        smtpExtensions: options.smtpExtensions,
        oauth: options.oauth
      },
      deliveryMode: options.deliveryMode
    });

    // Set up autoconfiguration to work with this local fake server.
    var configEntry = accountcommon._autoconfigByDomain[
      (this.type === 'imap' ? 'fakeimaphost' :
       this.type === 'pop3' ? 'fakepop3host' :
       'fakeashost')];

    if (this.type === 'activesync') {
      configEntry.incoming.server = this.serverInfo.url;
    } else {
      configEntry.incoming.hostname =
        this.serverInfo.imapHost || this.serverInfo.pop3Host;
      configEntry.incoming.port =
        this.serverInfo.imapPort || this.serverInfo.pop3Port;
      configEntry.outgoing.hostname = this.serverInfo.smtpHost;
      configEntry.outgoing.port = this.serverInfo.smtpPort;
    }

    if (this.type === 'imap') {
      // XXX because of how our timezone detection logic works, we
      // really need a message in the Inbox... And timestamp-wise, for
      // 'new' message reasons, this needs to be a somewhat older
      // message.
      var fakeMsgDate;
      // realDate specified?  then we can use something slightly old.
      if (!options.date) {
        fakeMsgDate = new Date(Date.now() - 2000);
      }
      else {
        // XXX ugh, not sure what the right answer is here.
        fakeMsgDate = new Date(
          options.date.valueOf() - 2 * 24 * 60 * 60 * 1000);
      }
      this.addMessagesToFolder('INBOX', [{
        date: fakeMsgDate,
        metaState: {},
        toMessageString: function() {
          return [
            'Date: ' + formatDateTime(fakeMsgDate, 'rfc2822',
                                      this.timezoneMins),
            'From: superfake@example.nul',
            'Subject: blaaaah',
            'Message-ID: <blaaaaaaaaaah@example.nul>',
            'Content-Type: text/plain',
            '',
            'Hello, shoe.'
          ].join('\r\n');
        }
      }]);
    }

    if (options.date) {
      this.setDate(options.date.valueOf());
    }
  }

  FakeServer.prototype = {

    /**
     * An account reference is needed to perform certain fake server
     * operations, but at least in the legacy test framework, we don't
     * have direct access until a while after we boot up the fake
     * server. Hook it up here.
     */
    setAccount: function(account) {
      this.account = account;
    },

    backdoor: function(request, explicitPath) {
      var url;
      if (this.serverInfo) {
        if (this.type === 'activesync') {
          url = this.serverInfo.url + '/backdoor';
        } else {
          url = this.serverInfo.controlUrl;
        }
      } else {
        url = this.options.controlServerBaseUrl + '/control';
      }
      var xhr = new XMLHttpRequest({ mozSystem: true, mozAnon: true });
      xhr.open('POST', url, false);
      xhr.send(JSON.stringify(request));
      var response = xhr.response || null;
      try {
        if (response) {
          response = JSON.parse(response);
        }
      } catch (ex) {
        console.error('JSON parsing problem!', url, ex.stack);
        logic(this, 'backdoorError', {
          request: request,
          response: response
        });
        return null;
      }
      logic(this, 'backdoor', {
        request: request,
        response: response
      });
      return response;
    },

    // => folderPath or falsey
    getFolderByPath: function(folderPath) {
      if (this.type === 'imap' || this.type === 'activesync') {
        return this.backdoor({
          command: 'getFolderByPath',
          name: folderPath
        });
      } else if (this.type === 'pop3') {
        return this.account.getFolderByPath(folderPath);
      }
    },

    setDate: function(timestamp) {
      this.date = timestamp;
      return this.backdoor({
        command: 'setDate',
        timestamp: timestamp
      });
    },

    SYNC_FOLDER_LIST_AFTER_ADD: true,
    addFolder: function(folderPath) {
      // returns the canonical folder path (probably)
      if (this.type === 'imap') {
        return this.backdoor({
          command: 'addFolder',
          name: folderPath
        });
      } else if (this.type === 'activesync') {
        return this.backdoor({
          command: 'addFolder',
          name: folderPath,
          type: undefined,
          parentId: undefined
        });
      } else if (this.type === 'pop3') {
        this.account._learnAboutFolder(folderPath, folderPath, null,
                                       folderPath, '/', 0, false);
        return folderPath;
      }
    },

    removeFolder: function(folderPath) {
      if (this.type === 'activesync') {
        // ActiveSync will hear about this deletion when it triggers
        // syncFolderList next. Which in a remove-then-add idiom
        // happens immediately after this. But the real point is we
        // don't need to delete the folder info locally.
        return this.backdoor({
          command: 'removeFolder',
          folderId: folderPath.id
        });
      } else {
        // do generate notifications; don't want the slice to get out of date
        this.account._forgetFolder(folderPath.id ||
                                   this.account.getFolderByPath(folderPath).id,
                                   false);

        var result = this.backdoor({
          command: 'removeFolder',
          name: folderPath
        });

        if (result !== true) {
          logic(this, 'folderDeleteFailure', { path: folderPath });
        }
        if (this.type === 'pop3') {
          delete this.folderMessages[folderPath.path || folderPath];
        }
      }
    },

    addMessagesToFolder: function(folderPath, messages) {
      // ActiveSync is sufficiently weird to pull it out.
      if (this.type === 'activesync') {
        return this.addMessagesToFolderActiveSync(folderPath, messages);
      }

      var transformedMessages = messages.map((message) => {

        var msgString = message.toMessageString();
        if (this.type === 'imap') {
          // Generate an rfc822 message, prefixing on a fake 'received'
          // line so that our INTERNALDATE detecting logic can be happy.
          //
          // XXX this currently requires the timezone to be the
          // computer's local tz since we can't force a timezone offset
          // into a Date object; it's locale dependent.
          msgString =
            ('Received: from 127.1.2.3 by 127.1.2.3; ' +
             formatDateTime(message.date, 'rfc2822', this.timezoneMins) +
             '\r\n' +
             msgString);
        }

        var flags = [];
        if (message.metaState.deleted) {
          flags.push('\\Deleted');
        }
        if (message.metaState.read) {
          flags.push('\\Seen');
        }

        return {
          flags: flags,
          date: message.date && message.date.valueOf(),
          msgString: msgString
        };
      });

      // XXX There is something inconsistent/wrong with this fake-server or its
      // use by the composite test mixins that folderPath could be an object or
      // a string.  Per debug logs, it definitely is an object at least some of
      // the time.  And a brief foray to address this found instances where some
      // caller must be providing a string.

      // Reach the server for IMAP, and for the INBOX of POP3.
      if (this.type === 'imap' ||
          (this.type === 'pop3' &&
           (folderPath.path || folderPath) === 'INBOX')) {

        return this.backdoor({
          command: 'addMessagesToFolder',
          name: folderPath.path || folderPath,
          messages: transformedMessages
        });

      } else if (this.type === 'pop3') {
        var folderMeta = this.account.getFolderByPath(folderPath);
        var storage = this.account.getFolderStorageForFolderId(folderMeta.id);
        if (!folderMeta._TEST_pendingAdds) {
          // Use Object.defineProperty here, without specifying the
          // enumeration attribute, so that this property doesn't screw
          // up postMessage serialization.
          Object.defineProperty(folderMeta, '_TEST_pendingAdds', {
            writable: true,
            enumerable: false,
            value: []
          });
        }
        transformedMessages.forEach((obj) => {
          var msg = pop3.Pop3Client.parseMime(obj.msgString);
          folderMeta._TEST_pendingAdds.push(msg);
        });

        return null;
      }
    },

    /** ActiveSync-Only! */
    addMessagesToFolderActiveSync: function(folderPath, messages) {
      // We need to clean the passed-in messages to something the fake
      // server understands.
      var cleanedMessages = messages.map(function(message) {
        var bodyPart = message.bodyPart;
        var attachments = [];
        // XXX FIXME! this is a way too simplified transform of bodies!
        if (bodyPart.parts) {
          attachments = bodyPart.parts.slice(1);
          bodyPart = bodyPart.parts[0];
        }

        return {
          id: message.messageId,
          from: message.headers['From'],
          to: message.headers['To'],
          cc: message.headers['Cc'],
          replyTo: message.headers['Reply-To'],
          date: message.date.valueOf(),
          subject: message.subject,
          flags: [], // TODO: handle flags
          body: {
            contentType: bodyPart._contentType,
            content: bodyPart.body
          },
          attachments: attachments.map(function(attachment) {
            return {
              filename: attachment._filename,
              contentId: attachment._contentId,
              contentType: attachment._contentType,
              content: attachment.body
            };
          })
        };
      });

      var ret = this.backdoor({
        command: 'addMessagesToFolder',
        folderId: folderPath.id,
        messages: cleanedMessages
      });
      return ret;
    },

    modifyMessagesInFolderActiveSync: function(serverFolderInfo, messages,
                                               addFlags, delFlags) {
      var changes = {};
      addFlags = addFlags || [];
      delFlags = delFlags || [];
      addFlags.forEach(function(flag) {
        switch (flag) {
        case '\\Flagged':
          changes.flag = true;
          break;
        case '\\Seen':
          changes.read = true;
          break;
        default:
          console.warn('ActiveSync does not grok (add) flag:', flag);
          break;
        }
      });
      delFlags.forEach(function(flag) {
        switch (flag) {
        case '\\Flagged':
          changes.flag = false;
          break;
        case '\\Seen':
          changes.read = false;
          break;
        default:
          console.warn('ActiveSync does not grok (false) flag:', flag);
          break;
        }
      });
      var serverIds = messages.map(function(message) {
        // message is either a MailHeader (where srvid is currently available) or
        // a knownMessage, in which case the rep is what we generated in
        // addMessagesToFolder where the good stuff is in id
        return message._wireRep ? message._wireRep.srvid : message.id;
      });
      return this.backdoor({
        command: 'modifyMessagesInFolder',
        folderId: serverFolderInfo.id,
        serverIds: serverIds,
        changes: changes
      });

    },



    /**
     * Return a list of the messages currently in the given folder, where each
     * messages is characterized by { date, subject }.
     */
    getMessagesInFolder: function(folderPath) {
      var path = folderPath.path || folderPath;
      if (this.type === 'pop3' && path !== 'INBOX') {
        return (this.folderMessages[path] || []).map((msg) => {
          return { subject: msg.subject, date: msg.date };
        });
      } else if (this.type === 'activesync') {
        return this.backdoor({
          command: 'getMessagesInFolder',
          folderId: folderPath.id
        });
      } else {
        return this.backdoor({
          command: 'getMessagesInFolder',
          name: folderPath
        });
      }
    },

    /**
     * Modify the flags on one or more messages in a folder.
     */
    modifyMessagesInFolder: function(folderPath, messages, addFlags, delFlags) {
      if (this.type === 'activesync') {
        return this.modifyMessagesInFolderActiveSync(folderPath, messages, addFlags, delFlags);
      }

      var uids = messages.map(function(header) {
        // XXX We currently use the UID.  It's available off of the header because
        // we keep the wire rep around (which is just the HeaderInfo dict);
        // that was available before because of our now-moot cookie caching, but
        // then the makeCopy() method made it temporarily required.  So we'll
        // use it for now, but we should potentially just use the guid and change
        // our fake-server to use that instead.  It's only slightly slower and
        // we could just cache it.
        return header._wireRep.srvid;
      });

      return this.backdoor({
        command: 'modifyMessagesInFolder',
        name: folderPath,
        uids: uids,
        addFlags: addFlags,
        delFlags: delFlags
      });
    },

    /**
     * Delete one or more messages from a folder.
     *
     * @args[
     *   @param[messages @listof[MailHeader]]{
     *     MailHeaders from which we can extract the message-id header values.
     *     Although the upstream caller may have a variant where it is not
     *     provided from MailHeaders, it's not allowed to call into IMAP with
     *     that.
     *   }
     * ]
     */
    deleteMessagesFromFolder: function(folderPath, messages) {
      if (this.type === 'imap') {
        this.modifyMessagesInFolder(folderPath, messages, ['\\Deleted'], null);
      }
      else if (this.type === 'pop3') {
        if ((folderPath.path || folderPath) === 'INBOX') {
          return this.backdoor({
            command: 'deleteMessagesFromFolder',
            name: folderPath,
            ids: messages.map((msg) => msg.guid)
          });
        } else {
          var folderMeta = this.account.getFolderByPath(folderPath);
          var storage = this.account.getFolderStorageForFolderId(folderMeta.id);

          if (!folderMeta._TEST_pendingHeaderDeletes) {
            // Use Object.defineProperty here, without specifying the
            // enumeration attribute, so that this property doesn't screw
            // up postMessage serialization.
            Object.defineProperty(folderMeta, '_TEST_pendingHeaderDeletes', {
              writable: true,
              enumerable: false,
              value: []
            });
          }

          messages.forEach((mailHeader) => {
            folderMeta._TEST_pendingHeaderDeletes.push({
              date: mailHeader.date,
              suid: mailHeader.id
            });
            var name = folderPath.path || folderPath;
            this.folderMessages[name] =
              (this.folderMessages[name] || []).filter((m) => {
                return m.header.guid !== mailHeader.guid;
              });
          });
        }
      } else if (this.type === 'activesync') {
        // The server is our friend and uses the message's message-id header value
        // as its serverId.
        var serverIds = messages.map(function(message) {
          // message is either a MailHeader (where srvid is currently available) or
          // a knownMessage, in which case the rep is what we generated in
          // addMessagesToFolder where the good stuff is in id
          return message._wireRep ? message._wireRep.srvid : message.id;
        });
        return this.backdoor({
          command: 'removeMessagesByServerId',
          folderId: folderPath.id,
          serverIds: serverIds
        });
      }
    },

    setValidOAuthAccessTokens: function(accessTokens) {
      return this.backdoor({
        command: 'setValidOAuthAccessTokens',
        accessTokens: accessTokens
      });
    },

    changeCredentials: function(newCreds) {
      return this.backdoor({
        command: 'changeCredentials',
        credentials: newCreds
      });
    },

    /** POP3-only. */
    setDropOnAuthFailure: function(dropOnAuthFailure) {
      return this.backdoor({
        command: 'setDropOnAuthFailure',
        dropOnAuthFailure: dropOnAuthFailure
      });
    },

    /**
     * When set to true, the outgoing server will reject all messages.
     */
    toggleSendFailure: function(shouldFail) {
      return this.backdoor({
        command: 'toggleSendFailure',
        shouldFail: shouldFail
      });
    },

    moveSystemFoldersUnderneathInbox: function() {
      return this.backdoor({
        command: 'moveSystemFoldersUnderneathInbox'
      });
    },

    /**
     * ActiveSync-Only!
     *
     * Ask the ActiveSync server for the list of distinct device id's it has seen
     * since startup or when the clear option was last provided.
     *
     * @param {Boolean} [opts.clear]
     *   Clear the list subsequent to returning the current list contents.
     */
    getObservedDeviceIds: function(opts) {
      return this.backdoor({
        command: 'getObservedDeviceIds',
        clearObservedDeviceIds: opts && opts.clear
      });
    },

    //////////////////////////////////////////////////////////////////////////////
    // OAuth stuff
    //
    // This should all probably be on a separate helper object.
    // Another thing for the great test refactoring/cleanup.
    _oauthbackdoor: function(request, explicitPath) {
      var xhr = new XMLHttpRequest({mozSystem: true, mozAnon: true});
      xhr.open('POST', this.serverInfo.oauthInfo.backdoor, false);
      xhr.send(JSON.stringify(request));
      var response = xhr.response || null;
      try {
        if (response)
          response = JSON.parse(response);
      }
      catch (ex) {
        logic(this, 'backdoorError', {
          request: request,
          response: response
        });
        return null;
      }
      logic(this, 'backdoor', {
        request: request,
        response: response
      });
      return response;
    },

    oauth_getNumAccessTokensProvided: function(params) {
      return this._oauthbackdoor({
        command: 'getNumAccessTokensProvided',
        reset: params.reset
      });
    }

  }

  function extractUsernameFromEmail(str) {
    var idx = str.indexOf('@');
    if (idx === -1)
      return str;
    return str.substring(0, idx);
  }



  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep',
                'Oct', 'Nov', 'Dec'];

  /**
   * Format an IMAP date-time or an 2822 date-time string.  The difference is
   * whether the date has dashes between it or spaces.
   *
   * An RFC 3501 example is: 17-Jul-1996 02:44:25 -0700
   * An RFC 2822 example is: 21 Nov 1997 10:05:43 -0600
   */
  function formatDateTime(date, format, forceTZOffset) {
    var s;
    var dateSpacer = (format === 'imap') ? '-' : ' ';
    var tzOffset = (forceTZOffset != null) ? forceTZOffset :
          date.getTimezoneOffset();
    s = ((date.getDate() < 10) ? ' ' : '') + date.getDate() + dateSpacer +
      MONTHS[date.getMonth()] + dateSpacer +
      date.getFullYear() + ' ' +
      ('0'+date.getHours()).slice(-2) + ':' +
      ('0'+date.getMinutes()).slice(-2) + ':' +
      ('0'+date.getSeconds()).slice(-2) +
      ((tzOffset > 0) ? ' -' : ' +' ) +
      ('0'+(Math.abs(tzOffset) / 60)).slice(-2) +
      ('0'+(Math.abs(tzOffset) % 60)).slice(-2);
    return s;
  }


  var instances = {};

  var servers = {
    bootNamedServer: function(name, opts) {
      if (!instances[name]) {
        instances[name] = new FakeServer(opts);
      }
      return instances[name];
    }
  };

  return servers;

});
