define(
  [
    'wbxml',
    'activesync/codepages',
    'activesync/protocol',
    'exports'
  ],
  function(
    $wbxml,
    $ascp,
    $activesync,
    exports
  ) {

function ActiveSyncFolderStorage(account, serverId) {
  this.account = account;
  this.serverId = serverId;
  this._bodiesBySuid = {};
}
exports.ActiveSyncFolderStorage = ActiveSyncFolderStorage;
ActiveSyncFolderStorage.prototype = {
  _loadMessages: function(serverId, callback) {
    var account = this.account;
    var as = $ascp.AirSync.Tags;
    var em = $ascp.Email.Tags;

    var w = new $wbxml.Writer("1.3", 1, "UTF-8");
    w.stag(as.Sync)
       .stag(as.Collections)
         .stag(as.Collection)
           .tag(as.SyncKey, "0")
           .tag(as.CollectionId, serverId)
         .etag()
       .etag()
     .etag();

    account.conn.doCommand(w, function(aResponse) {
      var syncKey;
      var e = new $wbxml.EventParser();
      e.addEventListener([as.Sync, as.Collections, as.Collection, as.SyncKey],
                         function(node) {
        syncKey = node.children[0].textContent;
      });
      e.run(aResponse);

      var w = new $wbxml.Writer("1.3", 1, "UTF-8");
      w.stag(as.Sync)
         .stag(as.Collections)
           .stag(as.Collection)
             .tag(as.SyncKey, syncKey)
             .tag(as.CollectionId, serverId)
             .tag(as.GetChanges)
           .etag()
         .etag()
       .etag();

      var folderId = account.id + '/' + serverId;
      account.conn.doCommand(w, function(aResponse) {
        var e = new $wbxml.EventParser();
        var headers = [];
        var bodies = [];
        e.addEventListener([as.Sync, as.Collections, as.Collection, as.Commands,
                            as.Add, as.ApplicationData],
        function(node) {
          var guid = Date.now() + Math.random().toString(16).substr(1) +
            '@mozgaia';
          var header = {
            subject: null,
            author: null,
            date: null,
            flags: [],
            id: null,
            suid: folderId + '/' + guid,
            guid: guid,
            hasAttachments: false,
            snippet: null,
          };
          var body = {
            to: null,
            cc: null,
            bcc: null,
            replyTo: null,
            attachments: null,
            references: null,
            bodyRep: [0x1, "This is my message body. There are many like it, " +
                      "but this one is mine."],
          };

          for (var i = 0; i < node.children.length; i++) {
            var child = node.children[i];
            var childText = child.children.length &&
                            child.children[0].textContent;

            if (child.tag == em.Subject)
              header.subject = childText;
            else if (child.tag == em.From || child.tag == em.To) {
              // XXX: This address parser is probably very bad. Fix it.
              var m = childText.match(/"(.+?)" <(.+)>/);
              var addr = m ? { name: m[1], address: m[2] } :
                             { name: "", address: childText };
              if (child.tag == em.From)
                header.author = addr;
              else // XXX: I wonder how this works with multiple To: fields???
                body.to = [addr];
            }
            else if (child.tag == em.DateReceived)
              header.date = new Date(childText).valueOf();
            else if (child.tag == em.Read) {
              if (childText == "1")
                header.flags.push('\\Seen');
            }
          }

          headers.push(header);
          bodies.push(body);
        });

        e.run(aResponse);
        callback(headers, bodies);
      });
    });
  },

  _sliceFolderMessages: function ffs__sliceFolderMessages(bridgeHandle) {
    var folderStorage = this;
    this._loadMessages(this.serverId, function(headers, bodies) {
      for (var i = 0; i < headers.length; i++)
        folderStorage._bodiesBySuid[headers[i].suid] = bodies[i];
      bridgeHandle.sendSplice(0, 0, headers, true, false);
    });
  },

  getMessageBody: function ffs_getMessageBody(suid, date, callback) {
    callback(this._bodiesBySuid[suid]);
  },
};

}); // end define
