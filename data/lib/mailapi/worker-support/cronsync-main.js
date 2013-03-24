
'use strict';

var CronSync = (function() {
  function debug(str) {
    //dump('CronSync: ' + str + '\n');
  }

  function clearAlarms() {
    var req = navigator.mozAlarms.getAll();
    req.onsuccess = function(event) {
      var alarms = event.target.result;
      for (var i = 0; i < alarms.length; i++) {
        navigator.mozAlarms.remove(alarms[i].id);
      }

      debug("clearAlarms: done.");
    };

    req.onerror = function(event) {
      debug("clearAlarms: failure.");
    }
  }

  function addAlarm(time) {
    var req = navigator.mozAlarms.add(time, 'ignoreTimezone', {});

    req.onsuccess = function() {
      debug('addAlarm: done.');
    };

    req.onerror = function(event) {
      debug('addAlarm: failure.');

      var target = event.target;
      console.warn('err:', target && target.error && target.error.name);
    };
  }

  var gApp, gIconUrl;
  navigator.mozApps.getSelf().onsuccess = function(event) {
    gApp = event.target.result;
    gIconUrl = gApp.installOrigin + '/style/icons/Email.png';
  };

  /**
   * Try and bring up the given header in the front-end.
   *
   * XXX currently, we just cause the app to display, but we don't do anything
   * to cause the actual message to be displayed.  Right now, since the back-end
   * and the front-end are in the same app, we can easily tell ourselves to do
   * things, but in the separated future, we might want to use a webactivity,
   * and as such we should consider using that initially too.
   */
  function showApp(header) {
    gApp.launch();
  }

  function showNotification(uid, title, body) {
    var success = function() {
      self.onmessage(uid, 'showNotification', true);
    }

    var close = function() {
      self.onmessage(uid, 'showNotification', false);
    }

    NotificationHelper.send(title, body, gIconUrl, success, close);
  }

  var self = {
    name: 'cronsyncer',
    onmessage: null,
    process: function(uid, cmd, args) {
      debug('process ' + cmd);
      switch (cmd) {
        case 'clearAlarms':
          clearAlarms.apply(this, args);
          break;
        case 'addAlarm':
          addAlarm.apply(this, args);
          break;
        case 'showNotification':
          args.unshift(uid);
          showNotification.apply(this, args);
          break;
        case 'showApp':
          showApp.apply(this, args);
          break;
      }
    }
  }
  return self;
})();

WorkerListener.register(CronSync);
