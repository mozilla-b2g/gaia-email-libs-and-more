/**
 * Fake ActiveSync server control.
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

function extractUsernameFromEmail(str) {
  var idx = str.indexOf('@');
  if (idx === -1)
    return str;
  return str.substring(0, idx);
}

/**
 * For now, we create at most one server for the lifetime of the xpcshell test.
 * So we spin it up the first time we need it, and we never actually clean up
 * after it.
 */
var gActiveSyncServer = null;
var TestActiveSyncServerMixins = {
  __constructor: function(self, opts) {
    if (!opts.universe)
      throw new Error('You need to provide a universe!');
    if (!("fakeActiveSyncServers" in self.RT.fileBlackboard))
      self.RT.fileBlackboard.fakeActiveSyncServers = {};

    var normName = self.__name.replace(/\d+/g, '');
    var serverExists = normName in self.RT.fileBlackboard.fakeActiveSyncServers;
    var setupVerb = serverExists ? 'reusing' : 'creating';
    // Flag the value to true so that static checks of whether it exists return
    // true.  Use of the value for data purposes must only be done at step-time
    // since 'true' is not very useful on its own.
    if (!serverExists)
      self.RT.fileBlackboard.fakeActiveSyncServers[normName] = true;

    self.testAccount = opts.testAccount;

    self.T.convenienceSetup(setupVerb, self,
                            function() {
      self.__attachToLogger(LOGFAB.testActiveSyncServer(self, null,
                                                        self.__name));

      var TEST_PARAMS = self.RT.envOptions, serverInfo;
      if (!serverExists) {
        // talk to the control server to get it to create our server
        self.backdoorUrl = TEST_PARAMS.controlServerBaseUrl + '/control';
        serverInfo = self._backdoor(
          {
            command: 'make_activesync',
            credentials: {
              username: extractUsernameFromEmail(self.testAccount.emailAddress),
              password: self.testAccount.initialPassword
            },
            deliveryMode: opts.deliveryMode
          });

        // now we only want to talk to our specific server control endpoint
        self.backdoorUrl = serverInfo.url + '/backdoor';
        self.RT.fileBlackboard.fakeActiveSyncServers[normName] = serverInfo;
      }
      else {
        serverInfo = self.RT.fileBlackboard.fakeActiveSyncServers[normName];
        self.backdoorUrl = serverInfo.url + '/backdoor';
      }

      $accountcommon._autoconfigByDomain['fakeashost'].incoming.server =
        serverInfo.url;
    });
    self.T.convenienceDeferredCleanup(self, 'cleans up', function() {
    });
  },

  finishSetup: function(testAccount) {
    this.supportsServerFolders =
      testAccount.folderAccount.supportsServerFolders;
    if (testAccount._useDate)
      this.setDate(testAccount._useDate.valueOf());
  },

  _backdoor: function(request) {
    var xhr = new XMLHttpRequest({mozSystem: true, mozAnon: true});
    xhr.open('POST', this.backdoorUrl, false);
    try {
      xhr.send(JSON.stringify(request));
    }
    catch (ex) {
      // wrap the error with some hint in the log.
      console.error('Problem contacting backdoor at:', this.serverBaseUrl);
      throw ex;
    }
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
  addFolder: function(name) {
    return this._backdoor({
      command: 'addFolder',
      name: name,
      type: undefined,
      parentId: undefined
    });
  },

  removeFolder: function(serverFolderInfo) {
    // ActiveSync will hear about this deletion when it triggers syncFolderList
    // next.  Which in a remove-then-add idiom happens immediately after this.
    // But the real point is we don't need to delete the folder info locally.
    return this._backdoor({
      command: 'removeFolder',
      folderId: serverFolderInfo.id
    });
  },

  addMessagesToFolder: function(serverFolderInfo, messages) {
    // We need to clean the passed-in messages to something the fake server
    // understands.
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
            content: attachment.body,
          };
        })
      };
    });

    var ret = this._backdoor({
      command: 'addMessagesToFolder',
      folderId: serverFolderInfo.id,
      messages: cleanedMessages
    });
    return ret;
  },

  getMessagesInFolder: function(serverFolderInfo) {
    return this._backdoor({
      command: 'getMessagesInFolder',
      folderId: serverFolderInfo.id
    });
  },

  modifyMessagesInFolder: function(serverFolderInfo, messages,
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
    return this._backdoor({
      command: 'modifyMessagesInFolder',
      folderId: serverFolderInfo.id,
      serverIds: serverIds,
      changes: changes
    });

  },

  deleteMessagesFromFolder: function(serverFolderInfo, messages) {
    // The server is our friend and uses the message's message-id header value
    // as its serverId.
    var serverIds = messages.map(function(message) {
      // message is either a MailHeader (where srvid is currently available) or
      // a knownMessage, in which case the rep is what we generated in
      // addMessagesToFolder where the good stuff is in id
      return message._wireRep ? message._wireRep.srvid : message.id;
    });
    return this._backdoor({
      command: 'removeMessagesByServerId',
      folderId: serverFolderInfo.id,
      serverIds: serverIds
    });
  },

  changeCredentials: function(newCreds) {
    return this._backdoor({
      command: 'changeCredentials',
      credentials: newCreds
    });
  },

  /**
   * Ask the ActiveSync server for the list of distinct device id's it has seen
   * since startup or when the clear option was last provided.
   *
   * @param {Boolean} [opts.clear]
   *   Clear the list subsequent to returning the current list contents.
   */
  getObservedDeviceIds: function(opts) {
    return this._backdoor({
      command: 'getObservedDeviceIds',
      clearObservedDeviceIds: opts && opts.clear
    });
  },

  moveSystemFoldersUnderneathInbox: function() {
    return this._backdoor({
      command: 'moveSystemFoldersUnderneathInbox'
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
  }
};



var LOGFAB = exports.LOGFAB = $log.register($module, {
  testActiveSyncServer: {
    type: $log.SERVER,
    topBilling: true,

    events: {
      started: { port: false },
      stopped: {},

      request: { method: false, path: false, headers: false },
      requestBody: { },
      response: { status: false, headers: false },

      backdoor: { request: false, response: false, url: false },
    },
    errors: {
      backdoorError: { request: false, response: false, url: false },
    },
    // I am putting these under TEST_ONLY_ as a hack to get these displayed
    // differently since they are walls of text.
    TEST_ONLY_events: {
      requestBody: { body: false },
      response: { body: false },
    },
  },
});

exports.TESTHELPER = {
  LOGFAB_DEPS: [
    LOGFAB,
  ],
  actorMixins: {
    testActiveSyncServer: TestActiveSyncServerMixins,
  }
};

}); // end define
