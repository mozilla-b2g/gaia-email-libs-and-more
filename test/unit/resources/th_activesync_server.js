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
    self.T.convenienceSetup(self, 'created, listening to get port',
                            function() {
      self.serverBaseUrl = 'http://localhost:8880';
      $accountcommon._autoconfigByDomain['aslocalhost'].incoming.server =
        self.serverBaseUrl;
    });
    self.T.convenienceDeferredCleanup(self, 'cleans up', function() {
    });
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

  getFirstFolderWithName: function(folderName) {
    return this._backdoor({
      command: 'getFirstFolderWithName',
      name: folderName
    });
  },

  addFolder: function(name, type, parentId, args) {
    return this._backdoor({
      command: 'addFolder',
      name: name,
      type: type,
      parentId: parentId
    });
  },

  removeFolder: function(folderId) {
    return this._backdoor({
      command: 'removeFolder',
      folderId: folderId
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
          type: bodyPart._contentType,
          content: bodyPart.body
        },
        attachments: attachments.map(function(attachment) {
          return {
            filename: attachment._filename,
            contentId: attachment._contentId,
            content: attachment.body
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
