/**
 * Fake POP3 server spin-up and control. Created on-demand by sending
 * HTTP requests to the control server via HTTP, though because
 * folders are local-only in POP3, very few operations actually get
 * sent to the fake server.
 */

define(
  [
    'rdcommon/log',
    './messageGenerator',
    'mailapi/accountcommon',
    'pop3/pop3',
    'module',
    'exports'
  ],
  function(
    $log,
    $msggen,
    $accountcommon,
    pop3,
    $module,
    exports
  ) {

var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep',
              'Oct', 'Nov', 'Dec'];

function formatPop3DateTime(date) {
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

var TestFakePOP3ServerMixins = {
  NEEDS_REL_TZ_OFFSET_ADJUSTMENT: false,

  __constructor: function(self, opts) {
    if (!("fakePOP3Servers" in self.RT.fileBlackboard))
      self.RT.fileBlackboard.fakePOP3Servers = {};

    var normName = self.__name.replace(/\d+/g, '');
    var serverExists = normName in self.RT.fileBlackboard.fakePOP3Servers;
    var setupVerb = serverExists ? 'reusing' : 'creating';
    // Flag the value to true so that static checks of whether it exists return
    // true.  Use of the value for data purposes must only be done at step-time
    // since 'true' is not very useful on its own.
    if (!serverExists)
      self.RT.fileBlackboard.fakePOP3Servers[normName] = true;

    self.testAccount = null;

    self.folderMessages = {};

    self.T.convenienceSetup(setupVerb, self,
                            function() {
      self.__attachToLogger(LOGFAB.testFakePOP3Server(self, null, self.__name));

      var TEST_PARAMS = self.RT.envOptions, serverInfo;

      if (!serverExists) {
        // talk to the control server to get it to create our server
        self.backdoorUrl = TEST_PARAMS.controlServerBaseUrl + '/control';
        serverInfo = self._backdoor(
          {
            command: 'make_pop3_and_smtp',
            credentials: {
              username: extractUsernameFromEmail(TEST_PARAMS.emailAddress),
              password: TEST_PARAMS.password
            },
            options: {

            }
          });

        // now we only want to talk to our specific server control endpoint
        self.backdoorUrl = serverInfo.controlUrl;
        self.RT.fileBlackboard.fakePOP3Servers[normName] = serverInfo;
      }
      else {
        serverInfo = self.RT.fileBlackboard.fakePOP3Servers[normName];
        self.backdoorUrl = serverInfo.controlUrl;
      }

      var configEntry = $accountcommon._autoconfigByDomain['fakepop3host'];
      configEntry.incoming.hostname = serverInfo.pop3Host;
      configEntry.incoming.port = serverInfo.pop3Port;
      configEntry.outgoing.hostname = serverInfo.smtpHost;
      configEntry.outgoing.port = serverInfo.smtpPort;
    });
  },

  finishSetup: function(testAccount) {
    this.testAccount = testAccount;
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
    var account = this.testAccount.pop3Account;
    return account.getFolderByPath(folderPath);
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
    var account = this.testAccount.pop3Account;
    account._learnAboutFolder(folderPath, folderPath, null,
                              folderPath, '/', 0, false);
    return folderPath;
  },

  removeFolder: function(folderPath) {
    var account = this.testAccount.pop3Account;
    account._forgetFolder(folderPath.id, false);
    var name = folderPath.path || folderPath;
    delete this.folderMessages[name];
  },

  addMessagesToFolder: function(folderPath, messages) {
    var transformedMessages = messages.map(function(message) {
      // Generate an rfc822 message.
      var msgString = message.toMessageString();

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
    if ((folderPath.path || folderPath) === 'INBOX') {
      var ret = this._backdoor({
        command: 'addMessagesToFolder',
        name: folderPath,
        messages: transformedMessages
      });
      return ret;
    } else {
      var account = this.testAccount.pop3Account;
      var folderMeta = account.getFolderByPath(folderPath);
      var storage = account.getFolderStorageForFolderId(folderMeta.id);
      if (!folderMeta._TEST_pendingAdds) {
        folderMeta._TEST_pendingAdds = [];
      }
      transformedMessages.forEach(function(obj) {
        var msg = pop3.Pop3Client.parseMime(obj.msgString);
        folderMeta._TEST_pendingAdds.push(msg);
      }, this);
      return null;
    }
  },

  /**
   * Return a list of the messages currently in the given folder, where each
   * messages is characterized by { date, subject }.
   */
  getMessagesInFolder: function(folderPath) {
    if ((folderPath.path || folderPath) === 'INBOX') {
      return this._backdoor({
        command: 'getMessagesInFolder',
        name: folderPath
      });
    } else {
      var name = folderPath.path || folderPath;
      return (this.folderMessages[name] || []).map(function(msg) {
        return {subject: msg.subject, date: msg.date};
      });
    }
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
   *     provided from MailHeaders, it's not allowed to call into POP3 with
   *     that.
   *   }
   * ]
   */
  deleteMessagesFromFolder: function(folderPath, messages) {
    if ((folderPath.path || folderPath) === 'INBOX') {
      return this._backdoor({
        command: 'deleteMessagesFromFolder',
        name: folderPath,
        ids: messages.map(function(msg) { return msg.guid; })
      });
    } else {
      var account = this.testAccount.pop3Account;
      var folderMeta = account.getFolderByPath(folderPath);
      var storage = account.getFolderStorageForFolderId(folderMeta.id);

      if (!folderMeta._TEST_pendingHeaderDeletes) {
        folderMeta._TEST_pendingHeaderDeletes = [];
      }
      messages.forEach(function(msg) {
        folderMeta._TEST_pendingHeaderDeletes.push(msg);
        var name = folderPath.path || folderPath;
        this.folderMessages[name] =
          (this.folderMessages[name] || []).filter(function(m) {
            return m.header.guid !== msg.guid;
          });
      }, this);
      return null;
    }
    // this.modifyMessagesInFolder(
    //   folderPath, messages, ['\\Deleted'], null);
  },

  changeCredentials: function(newCreds) {
    return this._backdoor({
      command: 'changeCredentials',
      credentials: newCreds
    });
  },

  setDropOnAuthFailure: function(dropOnAuthFailure) {
    return this._backdoor({
      command: 'setDropOnAuthFailure',
      dropOnAuthFailure: dropOnAuthFailure
    });
  }
};



var LOGFAB = exports.LOGFAB = $log.register($module, {
  testFakePOP3Server: {
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
    testFakePOP3Server: TestFakePOP3ServerMixins,
  }
};

}); // end define
