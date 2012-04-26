/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Instantiates the IMAP Client in the same webpage as the UI and provides the
 * bridge hookup logic.
 **/

define(
  [
    './mailapi',
    './imapacct',
    './imapslice',
    'exports'
  ],
  function(
    $mailapi,
    $imapacct,
    $imapslice,
    exports
  ) {
'use strict';

function stringifyHeader(header) {
  return author.address + ': ' + header.subject + ' @ ' +
          (new Date(header.date)) + '\n' +
         '    "' + header.snippet + '"';
}

function PrintySliceBridge() {
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
    this.items.splice.apply(this.items, [index, howMany].concat(items));
  },

  sendStatus: function(status) {
    console.log('STATUS', status);
  },
};

exports.goSync = function(connInfo, logFunc) {
  var universe = new $imapacct.MailUniverse();
  // create the account
  universe.tryToCreateAccount(connInfo, function(created, account) {
      var inbox = account.folders[0];
      // ask for the slice,
      var printyBridge = new PrintySliceBridge(),
          slice = account.sliceFolderMessages(inbox, printyBridge);
    });
};

});
