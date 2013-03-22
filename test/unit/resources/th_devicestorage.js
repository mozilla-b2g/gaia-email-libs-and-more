/**
 * Testhelper for DeviceStorage stuff; it adds a chance listener for the device
 * storage so we can generate log entries.
 **/

define(
  [
    'rdcommon/log',
    'module',
    'exports'
  ],
  function(
    $log,
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
    self._bound_onChange = self.onChange.bind(self);

    self.T.convenienceSetup(self, 'attaches', function() {
      self.__attachToLogger(LOGFAB.testDeviceStorage(self, null, self.__name));

      self.storage = navigator.getDeviceStorage(opts.storage);
      self.storage.addEventListener('change', self._bound_onChange);
    });

    self.T.convenienceDeferredCleanup(self, 'detaches', function() {
      self.storage.removeEventListener('change', self._bound_onChange);
    });
  },

  onChange: function(event) {
console.log('!!!!!! CHANGE EVENT', event.reason, event.path);
    switch (event.reason) {
      case 'created':
        this._logger.created(event.path);
        break;
      case 'modified':
        this._logger.modified(event.path);
        break;
      case 'deleted':
        this._logger.deleted(event.path);
        break;

      // we don't care about available/shared/unavailable
    }
  },
};

var LOGFAB = exports.LOGFAB = $log.register($module, {
  testDeviceStorage: {
    events: {
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
