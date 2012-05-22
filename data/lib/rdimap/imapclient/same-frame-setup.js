/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Instantiates the IMAP Client in the same webpage as the UI and provides the
 * bridge hookup logic.
 **/

define(
  [
    './shim-sham',
    'rdcommon/logreaper',
    './mailapi',
    './mailbridge',
    './mailuniverse',
    './imapslice',
    'exports'
  ],
  function(
    $shim_setup,
    $logreaper,
    $mailapi,
    $mailbridge,
    $mailuniverse,
    $imapslice,
    exports
  ) {
'use strict';

function stringifyHeader(header) {
  return header.author.address + ': ' + header.subject + ' @ ' +
          (new Date(header.date)) + '\n' +
         '    "' + header.snippet + '"';
}

function PrintySliceBridge() {
  this.id = 'printy';
  this.items = [];
}
PrintySliceBridge.prototype = {
  sendSplice: function(index, howMany, addedItems, requested, moreExpected) {
    console.log('SPLICE @' + index, howMany, 'deleted');
    for (var iDel = index; iDel < index + howMany; iDel++) {
      var deleted = this.items[iDel];
      console.log('  -', stringifyHeader(deleted));
    }
    for (var i = 0; i < addedItems.length; i++) {
      var added = addedItems[i];
      console.log('  +', stringifyHeader(added));
    }
    this.items.splice.apply(this.items, [index, howMany].concat(addedItems));
  },

  sendUpdate: function() {
  },

  sendStatus: function(status) {
    console.log('STATUS', status);
  },
};

function createBridgePair(universe) {
  var TMB = new $mailbridge.MailBridge(universe);
  var TMA = new $mailapi.MailAPI();
  // shim-sham provide window.setZeroTimeout
  TMA.__bridgeSend = function(msg) {
    window.setZeroTimeout(function() {
      TMB.__receiveMessage(msg);
    });
  };
  TMB.__sendMessage = function(msg) {
    window.setZeroTimeout(function() {
      TMA.__bridgeReceive(msg);
    });
  };
  return {
    api: TMA,
    bridge: TMB
  };
}

var _universeCallbacks = [], localMailAPI = null;
function onUniverse() {
  localMailAPI = createBridgePair(universe).api;
  console.log("Mail universe/bridge created, notifying.");
  for (var i = 0; i < _universeCallbacks.length; i++) {
    _universeCallbacks[i](universe);
  }
  _universeCallbacks = null;
  var evtObject = document.createEvent('Event');
  evtObject.initEvent('mailapi', false, false);
  evtObject.mailAPI = localMailAPI;
  window.dispatchEvent(evtObject);
}
// XXX XXX XXX XXX XXX
// XXX Super-duper-debug mode should not be on outside of super-initial testing
// that's the boolean true here...
var universe = new $mailuniverse.MailUniverse(true, onUniverse);

function runOnUniverse(callback) {
  if (_universeCallbacks !== null) {
    _universeCallbacks.push(callback);
    return;
  }
  callback(universe);
}
console.log("Assigning mail API helper!");
window.gimmeMailAPI = function(callback) {
  runOnUniverse(function() {
    callback(localMailAPI);
  });
};

exports.goSync = function(testingModeLogTestData, connInfo, logFunc) {
  // Cross-object-wrappers result in DateCloneError even for simple objects.
  // I guess there could be good security reasons, but it's annoying.
  connInfo = JSON.parse(JSON.stringify(connInfo));
  runOnUniverse(function() {
    // create the account
    universe.tryToCreateAccount(connInfo, function(created, account) {
        if (!created) {
          console.error("Can't do anything; no account created!");
          return;
        }
        var inbox = account.folders[0];
        // ask for the slice,
        var printyBridge = new PrintySliceBridge(logFunc),
            slice = account.sliceFolderMessages(inbox, printyBridge);
      });
  });
  LOG_REAPER = new $logreaper.LogReaper(universe._LOG);
  return LOG_BACKLOG;
};

////////////////////////////////////////////////////////////////////////////////
// Logging

var LOG_REAPER, LOG_BACKLOG = [], MAX_LOG_BACKLOG = 60;

// once a second, potentially generate a log
setInterval(function() {
  if (!LOG_REAPER)
    return;
  var logTimeSlice = LOG_REAPER.reapHierLogTimeSlice();
  // if nothing interesting happened, this could be empty, yos.
  if (logTimeSlice.logFrag) {
    LOG_BACKLOG.push(logTimeSlice);
    // throw something away if we've got too much stuff already
    if (LOG_BACKLOG.length > MAX_LOG_BACKLOG)
      LOG_BACKLOG.shift();

    // In deuxdrop, this is where we would also update our subscribers.  We
    // may also want to do that here.
  }
}, 1000);

////////////////////////////////////////////////////////////////////////////////

});
