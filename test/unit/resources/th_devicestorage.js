/**
 * Testhelper for DeviceStorage stuff; it adds a chance listener for the device
 * storage so we can generate log entries.
 **/

define(
  [
    'rdcommon/log',
    'mailapi/worker-router',
    'module',
    'exports'
  ],
  function(
    $log,
    $router,
    $module,
    exports
  ) {


var TestDeviceStorageMixins = {
  __constructor: function(self, opts) {
    if (!opts)
      throw new Error('opts like { storage: "sdcard" } required');
    if (!opts.storage)
      throw new Error('You must specify the storage to use; ex: "sdcard"');

    self.storage = null;
    self._nextReqId = 0;
    self._callbacks = {};

    var sendMessage = this._sendMessage = $router.registerSimple(
      'th_devicestorage',
      function(msg) {
        var cmd = msg.cmd, data = msg.args;
        if (cmd === 'attached') {
          self._logger.attached();
        }
        else if (cmd === 'detached') {
          self._logger.detached();
        }
        if (cmd === 'change') {
          var event = data;
          switch (event.reason) {
            case 'created':
              self._logger.created(event.path);
              break;
            case 'modified':
              self._logger.modified(event.path);
              break;
            case 'deleted':
              self._logger.deleted(event.path);
              break;
            // we don't care about available/shared/unavailable
          }
        }
        else if (cmd === 'got') {
          var callback = self._callbacks[data.id];
          delete self._callbacks[data.id];
          try {
            callback(data.error, data.blob);
          } catch (ex) {
            console.error('error in callback', ex, '\n', ex.stack);
          }
        }
      });

    self.T.convenienceSetup(self, 'attaches', function() {
      self.__attachToLogger(LOGFAB.testDeviceStorage(self, null, self.__name));
      self.expect_attached();
      sendMessage('attach', 'sdcard');
    });

    self.T.convenienceDeferredCleanup(self, 'detaches', function() {
      sendMessage('detach');
    });
  },

  get: function(path, callback) {
    var id = this._nextReqId++;
    this._callbacks[id] = callback;
    this._sendMessage('get', { id: id, path: path });
  },
};

var LOGFAB = exports.LOGFAB = $log.register($module, {
  testDeviceStorage: {
    events: {
      attached: {},
      detached: {},

      created: { path: true },
      modified: { path: true },
      deleted: { path: true },
    }
  },
});

exports.TESTHELPER = {
  LOGFAB_DEPS: [
    LOGFAB
  ],
  actorMixins: {
    testDeviceStorage: TestDeviceStorageMixins
  }
};

}); // end define
