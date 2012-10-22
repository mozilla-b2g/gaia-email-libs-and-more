'use strict';

const {classes: Cc, interfaces: Ci, utils: Cu} = Components;

Cu.import('resource://testing-common/httpd.js');
Cu.import('resource://gre/modules/NetUtil.jsm');

load('deps/activesync/wbxml/wbxml.js');
load('deps/activesync/codepages.js');

const $wbxml = WBXML;
const $ascp = ActiveSyncCodepages;

function encodeWBXML(wbxml) {
  return TextDecoder('ascii').decode(wbxml.bytes);
}

function decodeWBXML(stream) {
  let str = NetUtil.readInputStreamToString(stream, stream.available());
  let bytes = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++)
    bytes[i] = str.charCodeAt(i);

  return new $wbxml.Reader(bytes, $ascp);
}

let server = new HttpServer();

server.registerPathHandler('/Microsoft-Server-ActiveSync', {
  handle: function(request, response) {
    if (request.method === 'OPTIONS') {
      this._options(request, response);
    }
    else if (request.method === 'POST') {
      let query = {};
      for (let param of request.queryString.split('&')) {
        let idx = param.indexOf('=');
        if (idx === -1) {
          query[decodeURIComponent(param)] = null;
        }
        else {
          query[decodeURIComponent(param.substring(0, idx))] =
            decodeURIComponent(param.substring(idx +1 ));
        }
      }

      this['_handle' + query.Cmd](request, query, response);
    }
  },

  _options: function(request, response) {
    response.setStatusLine('1.1', 200, 'OK');
    response.setHeader('Public', 'OPTIONS,POST');
    response.setHeader('Allow', 'OPTIONS,POST');
    response.setHeader('MS-ASProtocolVersions', '2.5,14.0');
    response.setHeader('MS-ASProtocolCommands', 'FolderSync,Sync');
  },

  _handleFolderSync: function(request, query, response) {
    const fh = $ascp.FolderHierarchy.Tags;
    const folderType = $ascp.FolderHierarchy.Enums.Type;

    let w = new $wbxml.Writer('1.3', 1, 'UTF-8');
    w.stag(fh.FolderSync)
       .tag(fh.Status, '1')
       .tag(fh.SyncKey, 'XXX')
       .stag(fh.Changes)
         .tag(fh.Count, '2')
         .stag(fh.Add)
           .tag(fh.ServerId, 'XXX-1')
           .tag(fh.ParentId, '0')
           .tag(fh.DisplayName, 'Inbox')
           .tag(fh.Type, folderType.DefaultInbox)
         .etag()
         .stag(fh.Add)
           .tag(fh.ServerId, 'XXX-2')
           .tag(fh.ParentId, '0')
           .tag(fh.DisplayName, 'Sent')
           .tag(fh.Type, folderType.DefaultSent)
         .etag()
       .etag()
     .etag();

    response.setStatusLine('1.1', 200, 'OK');
    response.setHeader('Content-Type', 'application/vnd.ms-sync.wbxml');
    response.write(encodeWBXML(w));
  },

  _handleSync: function(request, query, response) {
    const as  = $ascp.AirSync.Tags;
    const em  = $ascp.Email.Tags;
    const asb = $ascp.AirSyncBase.Tags;

    let syncKey, collectionId;

    let e = new $wbxml.EventParser();
    const base = [as.Sync, as.Collections, as.Collection];

    e.addEventListener(base.concat(as.SyncKey), function(node) {
      syncKey = node.children[0].textContent;
    });
    e.addEventListener(base.concat(as.CollectionId), function(node) {
      collectionId = node.children[0].textContent;
    });

    e.run(decodeWBXML(request.bodyInputStream));

    let w = new $wbxml.Writer('1.3', 1, 'UTF-8');

    if (syncKey === '0') {
      w.stag(as.Sync)
         .stag(as.Collections)
           .stag(as.Collection)
             .tag(as.SyncKey, 'XXX')
             .tag(as.CollectionId, collectionId)
             .tag(as.Status, '1')
           .etag()
         .etag()
       .etag();
    }
    else {
      w.stag(as.Sync)
         .stag(as.Collections)
           .stag(as.Collection)
             .tag(as.SyncKey, syncKey + 'X')
             .tag(as.CollectionId, collectionId)
             .tag(as.Status, '1')
             .stag(as.Commands)
               .stag(as.Add)
                 .tag(as.ServerId, 'XXX-1')
                 .stag(as.ApplicationData)
                   .tag(em.To, 'foo@example.com')
                   .tag(em.From, 'bar@example.com')
                   .tag(em.Subject, 'A test message')
                   .tag(em.DateReceived, '2012-10-19T03:03:43.283Z')
                   .tag(em.Importance, '1')
                   .tag(em.Read, '0')
                   .stag(asb.Body)
                     .tag(asb.Type, '1')
                     .tag(asb.EstimatedDataSize, '13')
                     .tag(asb.Truncated, '0')
                     .tag(asb.Data, 'Hello, world!')
                   .etag()
                 .etag()
               .etag()
               .stag(as.Add)
                 .tag(as.ServerId, 'XXX-2')
                 .stag(as.ApplicationData)
                   .tag(em.To, 'foo@example.com')
                   .tag(em.From, 'bar@example.com')
                   .tag(em.Subject, 'Another test message')
                   .tag(em.DateReceived, '2012-10-19T03:03:43.283Z')
                   .tag(em.Importance, '1')
                   .tag(em.Read, '0')
                   .stag(asb.Body)
                     .tag(asb.Type, '1')
                     .tag(asb.EstimatedDataSize, '13')
                     .tag(asb.Truncated, '0')
                     .tag(asb.Data, 'Hello, world!')
                   .etag()
                 .etag()
               .etag()
             .etag()
           .etag()
         .etag()
       .etag();
    }

    response.setStatusLine('1.1', 200, 'OK');
    response.setHeader('Content-Type', 'application/vnd.ms-sync.wbxml');
    response.write(encodeWBXML(w));
  },
});

server.start(8080);

_do_main();
