/**
 * Fake IMAP server spin-up and control.  Created on-demand by sending HTTP
 * requests to the control server via HTTP.
 **/

define(
  [
    'rdcommon/log',
    './messageGenerator',
    'accountcommon',
    'module',
    'exports'
  ],
  function(
    $log,
    $msggen,
    $accountcommon,
    $module,
    exports
  ) {

var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep',
              'Oct', 'Nov', 'Dec'];

// from (node-imap) imap.js
function formatImapDateTime(date) {
  var s;
  s = ((date.getDate() < 10) ? ' ' : '') + date.getDate() + '-' +
       MONTHS[date.getMonth()] + '-' +
       date.getFullYear() + ' ' +
       ('0'+date.getHours()).slice(-2) + ':' +
       ('0'+date.getMinutes()).slice(-2) + ':' +
       ('0'+date.getSeconds()).slice(-2) +
       ((date.getTimezoneOffset() > 0) ? ' -' : ' +' ) +
       ('0'+(Math.abs(date.getTimezoneOffset()) / 60)).slice(-2) +
       ('0'+(Math.abs(date.getTimezoneOffset()) % 60)).slice(-2);
  return s;
}

function extractUsernameFromEmail(str) {
  var idx = str.indexOf('@');
  if (idx === -1)
    return str;
  return str.substring(0, idx);
}

var TestFakeIMAPServerMixins = {
  NEEDS_REL_TZ_OFFSET_ADJUSTMENT: false,

  __constructor: function(self, opts) {
    if (!("fakeIMAPServers" in self.RT.fileBlackboard))
      self.RT.fileBlackboard.fakeIMAPServers = {};

    var normName = self.__name.replace(/\d+/g, '');
    var serverExists = normName in self.RT.fileBlackboard.fakeIMAPServers;
    var setupVerb = serverExists ? 'reusing' : 'creating';
    // Flag the value to true so that static checks of whether it exists return
    // true.  Use of the value for data purposes must only be done at step-time
    // since 'true' is not very useful on its own.
    if (!serverExists)
      self.RT.fileBlackboard.fakeIMAPServers[normName] = true;

    self.testAccount = opts.testAccount;

    self.T.convenienceSetup(setupVerb, self,
                            function() {
      self.__attachToLogger(LOGFAB.testFakeIMAPServer(self, null, self.__name));

      var TEST_PARAMS = self.RT.envOptions, serverInfo;

      var imapExtensions = opts.imapExtensions || ['RFC2195'];

      if (!serverExists) {
        // talk to the control server to get it to create our server
        self.backdoorUrl = TEST_PARAMS.controlServerBaseUrl + '/control';
        serverInfo = self._backdoor(
          {
            command: 'make_imap_and_smtp',
            credentials: {
              username: extractUsernameFromEmail(self.testAccount.emailAddress),
              password: self.testAccount.initialPassword
            },
            options: {
              imapExtensions: imapExtensions
            },
            deliveryMode: opts.deliveryMode
          });

        // now we only want to talk to our specific server control endpoint
        self.backdoorUrl = serverInfo.controlUrl;
        self.RT.fileBlackboard.fakeIMAPServers[normName] = serverInfo;

        // XXX because of how our timezone detection logic works, we really need
        // a message in the Inbox...
        // And timestamp-wise, for 'new' message reasons, this needs to be a
        // somewhat older message.
        var fakeMsgDate;
        var testUniverse = opts.testAccount.testUniverse;
        // realDate specified?  then we can use something slightly old.
        if (!testUniverse._useDate) {
          fakeMsgDate = new Date(Date.now() - 2000);
        }
        else {
          // XXX ugh, not sure what the right answer is here.
          fakeMsgDate = new Date(
            testUniverse._useDate.valueOf() - 2 * 24 * 60 * 60 * 1000);
        }
        self.addMessagesToFolder('INBOX', [{
          date: fakeMsgDate,
          metaState: {},
          toMessageString: function() {
            return [
              'Date: ' + fakeMsgDate,
              'From: superfake@example.nul',
              'Subject: blaaaah',
              'Message-ID: <blaaaaaaaaaah@example.nul>',
              'Content-Type: text/plain',
              '',
              'Hello, shoe.'
              ].join('\r\n');
          },
        }]);
      }
      else {
        serverInfo = self.RT.fileBlackboard.fakeIMAPServers[normName];
        self.backdoorUrl = serverInfo.controlUrl;
      }

      var configEntry = $accountcommon._autoconfigByDomain['fakeimaphost'];
      configEntry.incoming.hostname = serverInfo.imapHost;
      configEntry.incoming.port = serverInfo.imapPort;
      configEntry.outgoing.hostname = serverInfo.smtpHost;
      configEntry.outgoing.port = serverInfo.smtpPort;
    });
  },

  /**
   * Weird hack method invoked at runtime following the creation of the account.
   * Really question why anything is in here.
   */
  finishSetup: function(testAccount) {
    this.supportsServerFolders =
      testAccount.folderAccount.supportsServerFolders;
    if (testAccount._useDate)
      this.setDate(testAccount._useDate.valueOf());
  },

  _backdoor: function(request, explicitPath) {
    var xhr = new XMLHttpRequest({mozSystem: true, mozAnon: true});
    xhr.open('POST', this.backdoorUrl, false);
    xhr.send(JSON.stringify(request));
    var response = xhr.response || null;
    try {
      if (response)
        response = JSON.parse(response);
    }
    catch (ex) {
      console.error('JSON parsing problem!');
      this._logger.backdoorError(request, response, this.backdoorUrl);
      return null;
    }
    this._logger.backdoor(request, response, this.backdoorUrl);
    return response;
  },

  // => folderPath or falsey
  getFolderByPath: function(folderPath) {
    return this._backdoor({
      command: 'getFolderByPath',
      name: folderPath
    });
  },

  setDate: function(timestamp) {
    return this._backdoor({
      command: 'setDate',
      timestamp: timestamp
    });
  },

  SYNC_FOLDER_LIST_AFTER_ADD: true,
  addFolder: function(folderPath, testFolder) {
    // returns the canonical folder path (probably)
    return this._backdoor({
      command: 'addFolder',
      name: folderPath,
    });
  },

  removeFolder: function(folderPath) {
    var folderMeta = this.testAccount.imapAccount.getFolderByPath(folderPath);
    // do generate notifications; don't want the slice to get out of date
    this.testAccount.imapAccount._forgetFolder(folderMeta.id, false);
    var result = this._backdoor({
      command: 'removeFolder',
      name: folderPath
    });
    if (result !== true)
      this._logger.folderDeleteFailure(folderPath);
  },

  addMessagesToFolder: function(folderPath, messages) {
    var transformedMessages = messages.map(function(message) {
      // Generate an rfc822 message, prefixing on a fake 'received' line so that
      // our INTERNALDATE detecting logic can be happy.
      //
      // XXX this currently requires the timezone to be the computer's local tz
      // since we can't force a timezone offset into a Date object; it's locale
      // dependent.
      var msgString =
        'Received: from 127.1.2.3 by 127.1.2.3; ' +
        formatImapDateTime(message.date) + '\r\n' +
        message.toMessageString();

      var rep = {
        flags: [],
        date: message.date.valueOf(),
        msgString: msgString
      };

      if (message.metaState.deleted)
        rep.flags.push('\\Deleted');
      if (message.metaState.read)
        rep.flags.push('\\Seen');

      return rep;
    });

    var ret = this._backdoor({
      command: 'addMessagesToFolder',
      name: folderPath,
      messages: transformedMessages
    });
    return ret;
  },

  /**
   * Return a list of the messages currently in the given folder, where each
   * messages is characterized by { date, subject }.
   */
  getMessagesInFolder: function(folderPath) {
    return this._backdoor({
      command: 'getMessagesInFolder',
      name: folderPath
    });
  },

  /**
   * Modify the flags on one or more messages in a folder.
   */
  modifyMessagesInFolder: function(folderPath, messages, addFlags, delFlags) {
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

    return this._backdoor({
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
    this.modifyMessagesInFolder(
      folderPath, messages, ['\\Deleted'], null);
  },

  changeCredentials: function(newCreds) {
    return this._backdoor({
      command: 'changeCredentials',
      credentials: newCreds
    });
  },

  /**
   * When set to true, the outgoing server will reject all messages.
   */
  toggleSendFailure: function(shouldFail) {
    return this._backdoor({
      command: 'toggleSendFailure',
      shouldFail: shouldFail
    });
  },

  moveSystemFoldersUnderneathInbox: function() {
    return this._backdoor({
      command: 'moveSystemFoldersUnderneathInbox'
    });
  }
};



var LOGFAB = exports.LOGFAB = $log.register($module, {
  testFakeIMAPServer: {
    type: $log.SERVER,
    topBilling: true,

    events: {
      started: { port: false },
      stopped: {},

      backdoor: { request: false, response: false, url: false },
    },
    errors: {
      backdoorError: { request: false, response: false, url: false },

      folderDeleteFailure: { folderPath: false }
    },
    TEST_ONLY_events: {
    },
  },
});

exports.TESTHELPER = {
  LOGFAB_DEPS: [
    LOGFAB,
  ],
  actorMixins: {
    testFakeIMAPServer: TestFakeIMAPServerMixins,
  }
};

}); // end define
