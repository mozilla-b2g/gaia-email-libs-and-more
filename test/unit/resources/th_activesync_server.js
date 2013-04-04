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
      self.__attachToLogger(LOGFAB.testActiveSyncServer(self, null,
                                                        self.__name));
      if (!gActiveSyncServer) {
        gActiveSyncServer =
          MAGIC_SERVER_CONTROL.createServer(opts.universe._useDate);
      }
      self.serverHandle = gActiveSyncServer.id;
      MAGIC_SERVER_CONTROL.useLoggers(
        self.serverHandle,
        {
          request: function(request) {
            self._logger.request(request._method, request._path,
                                 request._headers._headers);
          },
          requestBody: function(reader) {
            self._logger.requestBody(reader.dump());
            reader.rewind();
          },
          response: function(request, response, writer) {
            var body;
            if (writer) {
              var reader = new $wbxml.Reader(writer.bytes, $ascp);
              body = reader.dump();
            }
            self._logger.response(response._httpCode, response._headers._headers,
                                  body);
          },
          responseError: function(error) {
            self._logger.responseError(error);
          },
       });
      $accountcommon._autoconfigByDomain['aslocalhost'].incoming.server =
        'http://localhost:' + gActiveSyncServer.port;
      self._logger.started(gActiveSyncServer.port);
    });
    self.T.convenienceDeferredCleanup(self, 'cleans up', function() {
      // Do not stop, pre the above, but do stop logging stuff to it.
      MAGIC_SERVER_CONTROL.useLoggers(self.serverHandle, {});
    });
  },

  getFirstFolderWithType: function(folderType) {
    var folders = this.server.foldersByType[folderType];
    return folders[0];
  },

  getFirstFolderWithName: function(folderName) {
    return this.server.findFolderByName(folderName);
  },

  addFolder: function(name, type, parentId, messageSetDef) {
    return MAGIC_SERVER_CONTROL.addFolder(
      this.serverHandle, name, type, parentId, messageSetDef);
  },

  addMessageToFolder: function(folderId, messageDef) {
    return MAGIC_SERVER_CONTROL.addMessageToFolder(
      this.serverHandle, folderId, messageDef);
  },

  addMessagesToFolder: function(folderId, messageSetDef) {
    return MAGIC_SERVER_CONTROL.addMessagesToFolder(
      this.serverHandle, folderId, messageSetDef);
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
