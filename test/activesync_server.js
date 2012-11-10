'use strict';

Components.utils.import('resource://testing-common/httpd.js');
Components.utils.import('resource://gre/modules/NetUtil.jsm');

/**
 * Encode a WBXML writer's bytes for sending over the network.
 *
 * @param wbxml the WBXML Writer
 * @return a string of the bytes
 */
function encodeWBXML(wbxml) {
  return String.fromCharCode.apply(String, wbxml.bytes);
}

/**
 * Decode a stream from the network into a WBXML reader.
 *
 * @param stream the incoming stream
 * @return the WBXML Reader
 */
function decodeWBXML(stream) {
  let str = NetUtil.readInputStreamToString(stream, stream.available());
  let bytes = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++)
    bytes[i] = str.charCodeAt(i);

  return new $wbxml.Reader(bytes, $ascp);
}

function ActiveSyncFolder(server, name, type, parent, args) {
  this.server = server;
  this.name = name;
  this.type = type || $ascp.FolderHierarchy.Enums.Type.Mail;
  this.id = 'folder-' + (this.server._nextCollectionId++);
  this.parentId = parent ? parent.id : '0';

  if (!args) {
    // Start with the first message one hour in the past and each message after
    // it going one hour further into the past.  This ordering has the nice
    // benefit that it mirrors the ordering of view slices.  It also helps make
    // bugs in sync evident since view-slices will not automatically expand
    // into the field of older messages.
    args = { count: 10,
             age: { hours: 1 },
             age_incr: { hours: 1 },
           };
  }

  this.messages = this.server.msgGen.makeMessages(args);

  this._nextMessageSyncId = 1;
  this._messageSyncStates = {};
}

ActiveSyncFolder.prototype = {
  /**
   * Find a message object by its server ID.
   *
   * @param id the ServerId for the message
   * @return the message object, or null if no message was found
   */
  findMessageById: function(id) {
    for (let message of this.messages) {
      if (message.messageId === id)
        return message;
    }
    return null;
  },

  addMessage: function(args) {
    let newMessage = this.server.msgGen.makeMessage(args);
    this.messages.unshift(newMessage);
    this.messages.sort(function(a, b) { return a.date < b.date; });

    for (let [,syncState] in Iterator(this._messageSyncStates))
      syncState.push({ type: 'add', message: newMessage });

    return newMessage;
  },

  addMessages: function(args) {
    let newMessages = this.server.msgGen.makeMessages(args);
    this.messages.unshift.apply(this.messages, newMessages);
    this.messages.sort(function(a, b) { return a.date < b.date; });

    for (let [,syncState] in Iterator(this._messageSyncStates)) {
      for (let message of newMessages)
        syncState.push({ type: 'add', message: message });
    }

    return newMessages;
  },

  createSyncState: function(oldSyncKey) {
    if (oldSyncKey !== '0' &&
        !this._messageSyncStates.hasOwnProperty(oldSyncKey))
      return '0';

    let syncKey = 'messages-' + (this._nextMessageSyncId++) + '/' + this.id;
    this._messageSyncStates[syncKey] = [];
    if (oldSyncKey === '0')
      this._messageSyncStates[syncKey].push({ type: 'addall' });
    return syncKey;
  },

  takeSyncState: function(syncKey) {
    let syncState = this._messageSyncStates[syncKey];
    delete this._messageSyncStates[syncKey];
    return syncState;
  },

  peekSyncState: function(syncKey) {
    return this._messageSyncStates[syncKey];
  },
};

function ActiveSyncServer(startDate) {
  this.server = new HttpServer();
  this.msgGen = new MessageGenerator();

  // Make sure the message generator is using the same start date as us.
  if (startDate)
    this.msgGen._clock = startDate;

  const folderType = $ascp.FolderHierarchy.Enums.Type;
  this._folders = [];
  this.foldersByType = {
    inbox:  [],
    sent:   [],
    drafts: [],
    trash:  [],
    normal: []
  };

  this._nextCollectionId = 1;
  this._nextFolderSyncId = 1;
  this._folderSyncStates = {};

  this.addFolder('Inbox', folderType.DefaultInbox);
  this.addFolder('Sent Mail', folderType.DefaultSent, null, {count: 5});

  this.logRequest = null;
  this.logRequestBody = null;
  this.logResponse = null;
}

ActiveSyncServer.prototype = {
  /**
   * Start the server on a specified port.
   */
  start: function(port) {
    this.server.registerPathHandler('/Microsoft-Server-ActiveSync',
                                    this._commandHandler.bind(this));
    this.server.start(port);
  },

  /**
   * Stop the server.
   *
   * @param callback A callback to call when the server is stopped.
   */
  stop: function(callback) {
    this.server.stop({ onStopped: callback });
  },

  // Map folder type numbers from ActiveSync to Gaia's types
  _folderTypes: {
     1: 'normal', // Generic
     2: 'inbox',  // DefaultInbox
     3: 'drafts', // DefaultDrafts
     4: 'trash',  // DefaultDeleted
     5: 'sent',   // DefaultSent
     6: 'normal', // DefaultOutbox
    12: 'normal', // Mail
  },

  addFolder: function(name, type, parent, args) {
    if (type && !this._folderTypes.hasOwnProperty(type))
      throw new Error('Invalid folder type');

    let folder = new ActiveSyncFolder(this, name, type, parent, args);
    this._folders.push(folder);
    this.foldersByType[this._folderTypes[folder.type]].push(folder);

    for (let [,syncState] in Iterator(this._folderSyncStates))
      syncState.push({ type: 'add', folder: folder });

    return folder;
  },

  _commandHandler: function(request, response) {
    if (this.logRequest)
      this.logRequest(request);
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
            decodeURIComponent(param.substring(idx + 1));
        }
      }

      try {
        this['_handleCommand_' + query.Cmd](request, query, response);
      } catch(e) {
        console.error(e + '\n' + e.stack + '\n');
        dump(e + '\n' + e.stack + '\n');
        throw e;
      }
    }
  },

  _options: function(request, response) {
    response.setStatusLine('1.1', 200, 'OK');
    response.setHeader('Public', 'OPTIONS,POST');
    response.setHeader('Allow', 'OPTIONS,POST');
    response.setHeader('MS-ASProtocolVersions', '14.0');

    // Find the commands we've implemented.
    let commands = [], m;
    for (let key in this) {
      if (( m = /^_handleCommand_(.*)$/.exec(key) ))
        commands.push(m[1]);
    }
    response.setHeader('MS-ASProtocolCommands', commands.join(','));

    if (this.logResponse)
      this.logResponse(request, response);
  },

  _handleCommand_FolderSync: function(request, query, response) {
    const fh = $ascp.FolderHierarchy.Tags;
    const folderType = $ascp.FolderHierarchy.Enums.Type;

    let syncKey;

    let e = new $wbxml.EventParser();
    e.addEventListener([fh.FolderSync, fh.SyncKey], function(node) {
      syncKey = node.children[0].textContent;
    });
    let reader = decodeWBXML(request.bodyInputStream);
    if (this.logRequestBody)
      this.logRequestBody(reader);
    e.run(reader);

    let nextSyncKey = 'folders-' + (this._nextFolderSyncId++);
    this._folderSyncStates[nextSyncKey] = [];

    let w = new $wbxml.Writer('1.3', 1, 'UTF-8');
    w.stag(fh.FolderSync)
       .tag(fh.Status, '1')
       .tag(fh.SyncKey, nextSyncKey)
      .stag(fh.Changes);

    if (syncKey === '0') {
      w.tag(fh.Count, this._folders.length);

      for (let folder of this._folders) {
        w.stag(fh.Add)
           .tag(fh.ServerId, folder.id)
           .tag(fh.ParentId, folder.parentId)
           .tag(fh.DisplayName, folder.name)
           .tag(fh.Type, folder.type)
         .etag();
      }
    }
    else {
      let changes = this._folderSyncStates[syncKey];
      delete this._folderSyncStates[syncKey];
      w.tag(fh.Count, changes.length);

      for (let change of changes) {
        if (change.type === 'add') {
          w.stag(fh.Add)
           .tag(fh.ServerId, change.folder.id)
           .tag(fh.ParentId, change.folder.parentId)
           .tag(fh.DisplayName, change.folder.name)
           .tag(fh.Type, change.folder.type)
         .etag();
        }
      }
    }

    w  .etag(fh.Changes)
     .etag(fh.FolderSync);

    response.setStatusLine('1.1', 200, 'OK');
    response.setHeader('Content-Type', 'application/vnd.ms-sync.wbxml');
    response.write(encodeWBXML(w));
    if (this.logResponse)
      this.logResponse(request, response, w);
  },

  _handleCommand_Sync: function(request, query, response) {
    const as = $ascp.AirSync.Tags;
    const asEnum = $ascp.AirSync.Enums;

    let syncKey, nextSyncKey, collectionId;

    let e = new $wbxml.EventParser();
    const base = [as.Sync, as.Collections, as.Collection];

    e.addEventListener(base.concat(as.SyncKey), function(node) {
      syncKey = node.children[0].textContent;
    });
    e.addEventListener(base.concat(as.CollectionId), function(node) {
      collectionId = node.children[0].textContent;
    });

    let reader = decodeWBXML(request.bodyInputStream);
    if (this.logRequestBody)
      this.logRequestBody(reader);
    e.run(reader);

    let folder = this._findFolderById(collectionId),
        nextSyncKey = folder.createSyncState(syncKey),
        syncState = syncKey !== '0' ? folder.takeSyncState(syncKey) : [];

    let status = nextSyncKey === '0' ? asEnum.Status.InvalidSyncKey :
                                       asEnum.Status.Success;

    let w = new $wbxml.Writer('1.3', 1, 'UTF-8');

    w.stag(as.Sync)
       .stag(as.Collections)
         .stag(as.Collection)
           .tag(as.SyncKey, nextSyncKey)
           .tag(as.CollectionId, collectionId)
           .tag(as.Status, status);

    if (syncState.length) {
      w.stag(as.Commands);

      for (let change of syncState) {
        if (change.type === 'addall') {
          for (let message of folder.messages) {
            w.stag(as.Add)
              .tag(as.ServerId, message.messageId)
              .stag(as.ApplicationData);

            this._writeEmail(w, message);

            w  .etag(as.ApplicationData)
              .etag(as.Add);
          }
        }
        else if (change.type === 'add') {
          w.stag(as.Add)
            .tag(as.ServerId, change.message.messageId)
            .stag(as.ApplicationData);

          this._writeEmail(w, change.message);

          w  .etag(as.ApplicationData)
            .etag(as.Add);
        }
      }

      w.etag(as.Commands);
    }

    w    .etag(as.Collection)
       .etag(as.Collections)
     .etag(as.Sync);

    response.setStatusLine('1.1', 200, 'OK');
    response.setHeader('Content-Type', 'application/vnd.ms-sync.wbxml');
    response.write(encodeWBXML(w));
    if (this.logResponse)
      this.logResponse(request, response, w);
  },

  _handleCommand_ItemOperations: function(request, query, response) {
    const io = $ascp.ItemOperations.Tags;
    const as = $ascp.AirSync.Tags;

    let fetches = [];

    let server = this;
    let e = new $wbxml.EventParser();
    e.addEventListener([io.ItemOperations, io.Fetch], function(node) {
      let fetch = {};

      for (let child of node.children) {
        switch (child.tag) {
        case as.CollectionId:
          fetch.collectionId = child.children[0].textContent;
          break;
        case as.ServerId:
          fetch.serverId = child.children[0].textContent;
          break;
        }
      }

      // XXX: Implement error handling
      let folder = server._findFolderById(fetch.collectionId);
      fetch.message = folder.findMessageById(fetch.serverId);
      fetches.push(fetch);
    });
    let reader = decodeWBXML(request.bodyInputStream);
    if (this.logRequestBody)
      this.logRequestBody(reader);
    e.run(reader);

    let w = new $wbxml.Writer('1.3', 1, 'UTF-8');
    w.stag(io.ItemOperations)
       .tag(io.Status, '1')
       .stag(io.Response);

    for (let fetch of fetches) {
      w.stag(io.Fetch)
         .tag(io.Status, '1')
         .tag(as.CollectionId, fetch.collectionId)
         .tag(as.ServerId, fetch.serverId)
         .tag(as.Class, 'Email')
         .stag(io.Properties);

      this._writeEmail(w, fetch.message);

      w  .etag(io.Properties)
       .etag(io.Fetch);
    }

    w  .etag(io.Response)
     .etag(io.ItemOperations);

    response.setStatusLine('1.1', 200, 'OK');
    response.setHeader('Content-Type', 'application/vnd.ms-sync.wbxml');
    response.write(encodeWBXML(w));
    if (this.logResponse)
      this.logResponse(request, response, w);
  },

  _handleCommand_GetItemEstimate: function(request, query, response) {
    const ie = $ascp.ItemEstimate.Tags;
    const as = $ascp.AirSync.Tags;

    let syncKey, collectionId;

    let server = this;
    let e = new $wbxml.EventParser();
    e.addEventListener([ie.GetItemEstimate, ie.Collections, ie.Collection], function(node) {
      for (let child of node.children) {
        switch (child.tag) {
        case as.SyncKey:
          syncKey = child.children[0].textContent;
          break;
        case ie.CollectionId:
          collectionId = child.children[0].textContent;
          break;
        }
      }
    });
    let reader = decodeWBXML(request.bodyInputStream);
    if (this.logRequestBody)
      this.logRequestBody(reader);
    e.run(reader);

    let folder = this._findFolderById(collectionId),
        syncState = folder.takeSyncState(syncKey),
        estimate = 0;

    for (let change of syncState) {
      if (change.type === 'addall')
        estimate += folder.messages.length;
      else
        estimate++;
    }

    let w = new $wbxml.Writer('1.3', 1, 'UTF-8');
    w.stag(ie.GetItemEstimate)
       .stag(ie.Response)
         .tag(ie.Status, '1')
         .stag(ie.Collection)
           .tag(ie.CollectionId, collectionId)
           .tag(ie.Estimate, estimate)
         .etag()
       .etag()
     .etag();

    response.setStatusLine('1.1', 200, 'OK');
    response.setHeader('Content-Type', 'application/vnd.ms-sync.wbxml');
    response.write(encodeWBXML(w));
    if (this.logResponse)
      this.logResponse(request, response, w);
  },

  /**
   * Find a folder object by its server ID.
   *
   * @param id the CollectionId for the folder
   * @return the ActiveSyncFolder object, or null if no folder was found
   */
  _findFolderById: function(id) {
    for (let folder of this._folders) {
      if (folder.id === id)
        return folder;
    }
    return null;
  },

  /**
   * Write the WBXML for an individual message.
   *
   * @param w the WBXML writer
   * @param message the message object
   */
  _writeEmail: function(w, message) {
    const em  = $ascp.Email.Tags;
    const asb = $ascp.AirSyncBase.Tags;
    const asbEnum = $ascp.AirSyncBase.Enums;

    // TODO: this could be smarter, and accept more complicated MIME structures
    let bodyPart = message.bodyPart;
    let attachments = [];
    if (!(bodyPart instanceof SyntheticPartLeaf)) {
      attachments = bodyPart.parts.slice(1);
      bodyPart = bodyPart.parts[0];
    }

    // TODO: make this match the requested type
    let bodyType = bodyPart._contentType === 'text/html' ?
                   asbEnum.Type.HTML : asbEnum.Type.PlainText;

    w.tag(em.From, message.headers['From'])
     .tag(em.To, message.headers['To'])
     .tag(em.Subject, message.subject)
     .tag(em.DateReceived, new Date(message.date).toISOString())
     .tag(em.Importance, '1')
     .tag(em.Read, '0');

    if (attachments.length) {
      w.stag(asb.Attachments);
      for (let [i, attachment] in Iterator(attachments)) {
        w.stag(asb.Attachment)
           .tag(asb.DisplayName, attachment._filename)
           // We intentionally mimic Gmail's style of naming FileReferences here
           // to make testing our Gmail demunger easier.
           .tag(asb.FileReference, 'file_0.' + (i+1))
           .tag(asb.Method, asbEnum.Method.Normal)
          .tag(asb.EstimatedDataSize, attachment.body.length);

        if (attachment.hasContentId) {
          w.tag(asb.ContentId, attachment._contentId)
           .tag(asb.IsInline, '1');
        }

        w.etag();
      }
      w.etag();
    }

    w.stag(asb.Body)
       .tag(asb.Type, bodyType)
       .tag(asb.EstimatedDataSize, bodyPart.body.length)
       .tag(asb.Truncated, '0')
       .tag(asb.Data, bodyPart.body)
     .etag();
  }
};
