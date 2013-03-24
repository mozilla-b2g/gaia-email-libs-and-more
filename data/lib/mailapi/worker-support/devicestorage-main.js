
'use strict';

var DeviceStorage = (function() {
  function debug(str) {
    dump('DeviceStorage: ' + str + '\n');
  }

  function save(uid, cmd, storage, blob, filename) {
    var deviceStorage = navigator.getDeviceStorage(storage);
    var req = deviceStorage.addNamed(blob, filename);

    req.onerror = function() {
      self.onmessage(uid, cmd, false);
    }

    req.onsuccess = function() {
      self.onmessage(uid, cmd, true);
    }
  }

  var self = {
    name: 'devicestorage',
    onmessage: null,
    process: function(uid, cmd, args) {
      debug('process ' + cmd);
      switch (cmd) {
        case 'save':
          save(uid, cmd, args[0], args[1], args[2]);
          break;
      }
    }
  }
  return self;
})();

WorkerListener.register(DeviceStorage);
