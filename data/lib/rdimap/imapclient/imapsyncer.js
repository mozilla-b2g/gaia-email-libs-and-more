/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * IMAP folder synchronization logic.
 **/

define(
  [
    'q',
    'exports'
  ],
  function(
    $Q,
    exports
  ) {
'use strict';
const when = $Q.when;

/**
 * Folder synchronization logic.
 */
function ImapFolderSyncer(conn, db) {
  this._folderName = null;
  this._folderState = null;
  this._boxEntryState = null;
}
ImapFolderSyncer.prototype = {
  /**
   * Select the given folder using QRESYNC if previously syncronized, otherwise
   * initiating initial synchronization of the folder.  Fulfills the returned
   * promise once complete and then enters IDLE mode to receive updates.
   */
  syncFolder: function(folderName, folderState) {
    this._folderName = folderName;
    this._folderState = folderState;

    // - issue an initial sync or qresync as appropriate

  },

  _initialSync: function() {
    // - enter the folder, making note of the sync state for persistence
    // We will persist the sync state as-of our entry once our initial SEARCH
    // and related FETCHes have been completed.
  },

  _qresync: function() {
    // - enter the folder using QRESYNC

  },

  _onVanished: function(uids, happenedEarlier) {
  },

  /**
   * Keyword updates.
   */
  _onMsgUpdate: function(msg) {
  },


};

}); // end define
