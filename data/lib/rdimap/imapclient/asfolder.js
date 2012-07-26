define(
  [
    'wbxml',
    'activesync/codepages',
    'activesync/protocol',
    'mimelib',
    'exports'
  ],
  function(
    $wbxml,
    $ascp,
    $activesync,
    $mimelib,
    exports
  ) {
'use strict';

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
    let asb = $ascp.AirSyncBase.Tags;
    var em = $ascp.Email.Tags;

    var w = new $wbxml.Writer('1.3', 1, 'UTF-8');
    w.stag(as.Sync)
       .stag(as.Collections)
         .stag(as.Collection)
           .tag(as.SyncKey, '0')
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

      var w = new $wbxml.Writer('1.3', 1, 'UTF-8');
      w.stag(as.Sync)
         .stag(as.Collections)
           .stag(as.Collection)
             .tag(as.SyncKey, syncKey)
             .tag(as.CollectionId, serverId)
             .tag(as.GetChanges)
             .stag(as.Options)
               .stag(asb.BodyPreference)
                 .tag(asb.Type, '1')
               .etag()
               .tag(as.MIMESupport, '2')
               .tag(as.MIMETruncation, '7')
             .etag()
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
            bodyRep: null,
          };

          for (let [,child] in Iterator(node.children)) {
            let childText = child.children.length &&
                            child.children[0].textContent;

            switch (child.tag) {
            case em.Subject:
              header.subject = childText;
              break;
            case em.From:
              header.author = $mimelib.parseAddresses(childText)[0];
              break;
            case em.To:
              body.to = $mimelib.parseAddresses(childText);
              break;
            case em.Cc:
              nody.cc = $mimelib.parseAddresses(childText);
              break;
            case em.ReplyTo:
              body.replyTo = $mimelib.parseAddresses(childText);
              break;
            case em.DateReceived:
              header.date = new Date(childText).valueOf();
              break;
            case em.Read:
              if (childText == '1')
                header.flags.push('\\Seen');
              break;
            case em.Flag:
              for (let [,grandchild] in Iterator(child.children)) {
                if (grandchild.tag === em.Status &&
                    grandchild.children[0].textContent !== '0')
                  header.flags.push('\\Flagged');
              }
              break;
            case asb.Body:
              for (let [,grandchild] in Iterator(child.children)) {
                if (grandchild.tag === asb.Data)
                  body.bodyRep = [0x1, grandchild.children[0].textContent];
              }
              break;
            case asb.Attachments:
              header.hasAttachments = true;
              body.attachments = [];
              for (let [,attachmentNode] in Iterator(child.children)) {
                if (attachmentNode.tag !== asb.Attachment)
                  continue; // XXX: throw an error here??
                let attachment = { type: 'text/plain' }; // XXX: this is lies
                for (let [,attachData] in Iterator(attachmentNode.children)) {
                  switch (attachData.tag) {
                  case asb.DisplayName:
                    attachment.name = attachData.children[0].textContent;
                    break;
                  case asb.EstimatedDataSize:
                    attachment.sizeEstimate = attachData.children[0]
                                                        .textContent;
                    break;
                  }
                }
                body.attachments.push(attachment);
              }
              break;
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
