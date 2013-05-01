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
      self.msggen = new $msggen.MessageGenerator();
      // XXX: We'll need to sync this with the server
      self.msggen._clock = Date.now();
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
    var result = this._backdoor({
      command: 'addFolder',
      name: name,
      type: type,
      parentId: parentId
    });
    return this.addMessagesToFolder(result.id, args);
  },

  removeFolder: function(folderId) {
    return this._backdoor({
      command: 'removeFolder',
      folderId: folderId
    });
  },

  addMessageToFolder: function(folderId, args) {
    var newMessage = args instanceof $msggen.SyntheticPart ? args :
                     this.msggen.makeMessage(args);
    return this._backdoor({
      command: 'addMessageToFolder',
      folderId: folderId,
      message: newMessage
    });
  },

  addMessagesToFolder: function(folderId, args) {
   var newMessages = Array.isArray(args) ? args :
                     this.msggen.makeMessages(args);
    return this._backdoor({
      command: 'addMessagesToFolder',
      folderId: folderId,
      messages: newMessages
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
