/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Instantiates the IMAP Client in the same webpage as the UI and provides the
 * bridge hookup logic.
 **/

define(
  [
    'event-queue',
    'q',
    'imap',
    'rdplat/gindb',
    './imapsyncer',
    './schema',
    'exports'
  ],
  function(
    $_eventQueue,
    $Q,
    $imap,
    $db,
    $imapSync,
    $schema,
    exports
  ) {
'use strict';
const when = $Q.when;

exports.goSync = function(accountDef) {
  var db = $db.makeProductionDBConnection('', null, null, null),
      conn = new $imap.ImapConnection(accountDef);

  var syncer = $imapSync.ImapFolderSyncer(conn, db);

  when(
    db.defineSchema($schema.dbSchemaDef),
    function schemaDefined() {
      console.log("schema defined");
      conn.connect(function(err) {
        console.log("synchronizing folder");
        syncer.syncFolder('INBOX', null);
      });
    });
};

});
