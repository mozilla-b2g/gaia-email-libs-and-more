/**
 * Fake ActiveSync server control.
 **/

define(
  [
    'rdcommon/log',
    './messageGenerator',
    'mailapi/accountcommon',
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
              username: extractUsernameFromEmail(TEST_PARAMS.emailAddress),
              password: TEST_PARAMS.password
            },
          });

        // now we only want to talk to our specific server control endpoint
        self.serverBaseUrl = serverInfo.url;
        self.RT.fileBlackboard.fakeActiveSyncServers[normName] = serverInfo;
      }
      else {
        serverInfo = self.RT.fileBlackboard.fakeActiveSyncServers[normName];
        self.serverBaseUrl = serverInfo.url;
      }

      $accountcommon._autoconfigByDomain['fakeashost'].incoming.server =
        self.serverBaseUrl;
    });
    self.T.convenienceDeferredCleanup(self, 'cleans up', function() {
    });
  },

  finishSetup: function(testAccount) {
  },

  _backdoor: function(request) {
    var xhr = new XMLHttpRequest({mozSystem: true, mozAnon: true});
    xhr.open('POST', this.serverBaseUrl + '/backdoor', false);
    xhr.send(JSON.stringify(request));
    return xhr.response ? JSON.parse(xhr.response) : null;
  },

  getFirstFolderWithType: function(folderType) {
    return this._backdoor({
      command: 'getFirstFolderWithType',
      type: folderType
    });
  },

  getFolderByPath: function(folderPath) {
    return this._backdoor({
      command: 'getFirstFolderWithName',
      name: folderPath
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
    return this._backdoor({
      command: 'removeFolder',
      folderId: serverFolderInfo.id
    });
  },

  addMessagesToFolder: function(folderId, messages) {
    // We need to clean the passed-in messages to something the fake server
    // understands.
    var cleanedMessages = messages.map(function(message) {
      var bodyPart = message.bodyPart;
      var attachments = [];
      if (!(bodyPart instanceof $msggen.SyntheticPartLeaf)) {
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

    return this._backdoor({
      command: 'addMessagesToFolder',
      folderId: folderId,
      messages: cleanedMessages
    });
  },

  removeMessageById: function(folderId, messageId) {
    return this._backdoor({
      command: 'removeMessageById',
      folderId: folderId,
      messageId: messageId
    });
  },
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
    },
    errors: {
      responseError: { err: false },
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
