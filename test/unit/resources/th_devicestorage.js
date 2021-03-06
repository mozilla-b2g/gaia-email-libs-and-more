/**
 * Testhelper for DeviceStorage stuff for use on the worker thread; depends on
 * matching logic in testhelper-main.js for the actual main-thread logic.
 **/

define(
  [
    'logic',
    'worker-router',
    'module',
    'exports'
  ],
  function(
    logic,
    $router,
    $module,
    exports
  ) {

var DEVICE_STORAGE_GET_PREFIX = 'TEST_PREFIX/';

var TestDeviceStorageMixins = {
  __constructor: function(self, opts) {
    if (!opts)
      throw new Error('opts like { storage: "sdcard" } required');
    if (!opts.storage)
      throw new Error('You must specify the storage to use; ex: "sdcard"');

    self.storage = null;

    logic.defineScope(self, 'TestDeviceStorage');
    self._nextReqId = 0;
    self._callbacks = {};

    var cleanupList = [];

    var sendMessage = this._sendMessage = $router.registerSimple(
      'th_devicestorage',
      function(msg) {
        var cmd = msg.cmd, data = msg.args;
        if (cmd === 'attached') {
          logic(self, 'attached');
        }
        else if (cmd === 'nuked') {
          logic(self, 'nuked', { path: data.path });
        }
        else if (cmd === 'detached') {
          logic(self, 'detached');
        }
        if (cmd === 'change') {
          var event = data;
          switch (event.reason) {
            case 'created':
              logic(self, 'created', { path: event.path });
              cleanupList.push(event.path);
              break;
            case 'modified':
              logic(self, 'modified', { path: event.path });
              break;
            case 'deleted':
              logic(self, 'deleted', { path: event.path });
              var idx = cleanupList.indexOf(event.path);
              if (idx !== -1)
                cleanupList.splice(idx, 1);
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
      self.expect('attached');
      sendMessage('attach', 'sdcard');
    });

    self.T.convenienceDeferredCleanup(self, 'nukes and detaches', function() {
      // NOTE!  We now request just the readcreate permission, not the readwrite
      // permission.  So we can't delete things.  This isn't a huge deal for us,
      // but it does mean we can't clean up after ourselves.
      /*
      cleanupList.forEach(function(path) {
        self.expect_deleted(path);
      });
      */
      self.expect('detached');
      sendMessage('detach', { nuke: [] });
    });
  },

  get: function(path, callback) {
    // remove prefix
    if (path.indexOf(DEVICE_STORAGE_GET_PREFIX) === -1)
      throw new Error('saved storage without test prefix');

    path = path.slice(DEVICE_STORAGE_GET_PREFIX.length);

    var id = this._nextReqId++;
    this._callbacks[id] = callback;
    this._sendMessage('get', { id: id, path: path });
  },
};

exports.TESTHELPER = {
  actorMixins: {
    TestDeviceStorage: TestDeviceStorageMixins
  }
};

}); // end define
