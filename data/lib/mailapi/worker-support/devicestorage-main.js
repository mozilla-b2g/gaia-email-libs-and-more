define(function() {
  'use strict';

  function debug(str) {
    dump('DeviceStorage: ' + str + '\n');
  }

  function save(uid, cmd, storage, blob, filename) {
    var deviceStorage = navigator.getDeviceStorage(storage);
    var req = deviceStorage.addNamed(blob, filename);

    req.onerror = function() {
      self.sendMessage(uid, cmd, [false, req.error.name]);
    };

    req.onsuccess = function() {
      self.sendMessage(uid, cmd, [true]);
    };
  }

  var self = {
    name: 'devicestorage',
    sendMessage: null,
    process: function(uid, cmd, args) {
      debug('process ' + cmd);
      switch (cmd) {
        case 'save':
          save(uid, cmd, args[0], args[1], args[2]);
          break;
      }
    }
  };
  return self;
});
