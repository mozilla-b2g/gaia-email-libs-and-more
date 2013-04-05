/**
 * Fake ActiveSync server control.
 **/

define(
  [
    'rdcommon/log',
    'activesync/codepages',
    'wbxml',
    'mailapi/accountcommon',
    'module',
    'exports'
  ],
  function(
    $log,
    $ascp,
    $wbxml,
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
    return JSON.parse(xhr.response);
  },

  getFirstFolderWithType: function(folderType) {
    var folders = this.server.foldersByType[folderType];
    return folders[0];
  },

  getFirstFolderWithName: function(folderName) {
    return this.server.findFolderByName(folderName);
  },

  addFolder: function(name, type, parentId, messageSetDef) {
    return this._backdoor({
      command: 'addFolder',
      name: name,
      type: type,
      parentId: parentId,
      args: messageSetDef
    });
  },

  addMessageToFolder: function(folderId, messageDef) {
    return this._backdoor({
      command: 'addMessageToFolder',
      folderId: folderId,
      args: messageDef
    });
  },

  addMessagesToFolder: function(folderId, messageSetDef) {
    return this._backdoor({
      command: 'addMessagesToFolder',
      folderId: folderId,
      args: messageSetDef
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
