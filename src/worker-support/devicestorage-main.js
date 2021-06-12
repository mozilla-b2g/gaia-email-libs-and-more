var me;

// NB: This code works, avoiding refactor right now since we just want
// DeviceStorage to be available on the worker or normalize and move to
// bridge.js for this hacky stuff.
function save(uid, cmd, storage, blob, filename, registerDownload) {
  // For the download manager, we want to avoid the composite storage
  var deviceStorage = navigator.getDeviceStorage(storage);

  if (!deviceStorage) {
    console.warn('no device-storage available.');
    me.sendMessage(uid, cmd, [false, 'no-device-storage', null, false]);
    return;
  }

  console.log('issuing addNamed req');
  var req = deviceStorage.addNamed(blob, filename);

  req.onerror = function() {
    console.log('device-storage addNamed error, may be expected.', req.error);
    me.sendMessage(uid, cmd, [false, req.error.name, null, false]);
  };

  req.onsuccess = function(e) {
    console.log('addName returned happy');
    var prefix = '';

    if (typeof window.IS_GELAM_TEST !== 'undefined') {
      prefix = 'TEST_PREFIX/';
    }

    var savedPath = prefix + e.target.result;

    var registering = false;
    if (registerDownload) {
      var downloadManager = navigator.mozDownloadManager;
      console.warn('have downloadManager?', !!downloadManager,
                    'have adoptDownload?', downloadManager && !!downloadManager.adoptDownload);
      if (downloadManager && downloadManager.adoptDownload) {
        try {
          var fullPath = e.target.result;
          var firstSlash = fullPath.indexOf('/', 2); // ignore leading /
          var storageName = fullPath.substring(1, firstSlash); // eat 1st /
          var storagePath = fullPath.substring(firstSlash + 1);
          console.log('adopting download', deviceStorage.storageName,
                      e.target.result);
          registering = true;
          downloadManager.adoptDownload({
            totalBytes: blob.size,
            // There's no useful URL we can provide; anything would be an
            // internal URI scheme that we can't service.
            url: '',
            storageName: storageName,
            storagePath: storagePath,
            contentType: blob.type,
            // The time we started isn't inherently interesting given that the
            // entirety of the file appears instantaneously to the download
            // manager, now is good enough.
            startTime: new Date(Date.now()),
          }).then(function() {
            console.log('registered download with download manager');
            me.sendMessage(uid, cmd, [true, null, savedPath, true]);
          }, function() {
            console.warn('failed to register download with download manager');
            me.sendMessage(uid, cmd, [true, null, savedPath, false]);
          });
        } catch (ex) {
          console.error('Problem adopting download!:', ex, '\n', ex.stack);
        }
      } else {
        console.log('download manager not available, not registering.');
      }
    } else {
      console.log('do not want to register download');
    }

    // Bool success, String err, String filename
    if (!registering) {
      me.sendMessage(uid, cmd, [true, null, savedPath, false]);
    }
  };
}

me = {
  name: 'devicestorage',
  sendMessage: null,
  process: function(uid, cmd, args) {
    console.log('devicestorage-main:', cmd);
    switch (cmd) {
      case 'save':
        save(uid, cmd, ...args);
        break;
      default:
        // no other supported ops.
        break;
    }
  }
};
export default me;
