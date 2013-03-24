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
  if (!stream.available())
    return null;
  let str = NetUtil.readInputStreamToString(stream, stream.available());

  let bytes = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++)
    bytes[i] = str.charCodeAt(i);

  return new $_wbxml.Reader(bytes, $_ascp);
}

/**
 * Create a new ActiveSync folder.
 *
 * @param server the ActiveSyncServer object to associate this folder with
 * @param name the folder's name
 * @param type (optional) the folder's type, as an enum from
 *        FolderHierarchy.Enums.Type
 * @param parent (optional) the folder to contain this folder
 * @param args (optional) arguments to pass to makeMessages() to generate
 *        initial messages for this folder
 */
function ActiveSyncFolder(server, name, type, parentId, args) {
  this.server = server;
  this.name = name;
  this.type = type || $_ascp.FolderHierarchy.Enums.Type.Mail;
  this.id = 'folder-' + (this.server._nextCollectionId++);
  this.parentId = parentId || '0';

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
  this.messages.sort(function(a, b) { return b.date - a.date; });

  this._nextMessageSyncId = 1;
  this._messageSyncStates = {};
}

ActiveSyncFolder.prototype = {
  filterTypeToMS: {
    1: 86400 * 1000,
    2: 3 * 86400 * 1000,
    3: 7 * 86400 * 1000,
    4: 14 * 86400 * 1000,
    5: 30 * 86400 * 1000,
  },

  /**
   * Check if a message is in a given filter range.
   *
   * @param filterType the filter type to check
   * @param message a message object, created by messageGenerator.js
   * @return true if the message is in the filter range, false otherwise
   */
  _messageInFilterRange: function(filterType, message) {
    return filterType === $_ascp.AirSync.Enums.FilterType.NoFilter ||
           (this.server._clock - this.filterTypeToMS[filterType] <=
            message.date);
  },

  /**
   * Add a single message to this folder.
   *
   * @param args either a message object created by messageGenerator.js, or
   *        an object of arguments to pass to makeMessage()
   * @return the newly-added message
   */
  addMessage: function(args) {
    let newMessage = args instanceof SyntheticPart ? args :
                     this.server.msgGen.makeMessage(args);
    this.messages.unshift(newMessage);
    this.messages.sort(function(a, b) { return b.date - a.date; });

    for (let [,syncState] in Iterator(this._messageSyncStates)) {
      if (this._messageInFilterRange(syncState.filterType, newMessage))
        syncState.commands.push({ type: 'add', message: newMessage });
    }

    return newMessage;
  },

  /**
   * Add an array of messages to this folder.
   *
   * @param args either an array of message objects created by
   *        messageGenerator.js, or an object of arguments to pass to
   *        makeMessages()
   * @return the newly-added messages
   */
  addMessages: function(args) {
    let newMessages = Array.isArray(args) ? args :
                      this.server.msgGen.makeMessages(args);
    this.messages.unshift.apply(this.messages, newMessages);
    this.messages.sort(function(a, b) { return b.date - a.date; });

    for (let [,syncState] in Iterator(this._messageSyncStates)) {
      for (let message of newMessages)
        syncState.commands.push({ type: 'add', message: message });
    }

    return newMessages;
  },

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

  /**
   * Modify a message in this folder.
   *
   * @param message the message to modify
   * @param changes an object of changes to make; currently supports |read| (a
   *        boolean), and |flag| (a string)
   */
  changeMessage: function(message, changes) {
    if ('read' in changes)
      message.metaState.read = changes.read;
    if ('flag' in changes)
      message.metaState.flag = changes.flag;

    for (let [,syncState] in Iterator(this._messageSyncStates)) {
      // TODO: Handle the case where we already have this message in the command
      // list.
      if (this._messageInFilterRange(syncState.filterType, message))
        syncState.commands.push({ type: 'change', messageId: message.messageId,
                                  changes: changes });
    }
  },

  /**
   * Remove a message in this folder by its id.
   *
   * @param id the message's id
   * @return the deleted message, or null if the message wasn't found
   */
  removeMessageById: function(id) {
    for (let [i, message] in Iterator(this.messages)) {
      if (message.messageId === id) {
        this.messages.splice(i, 1);

        for (let [,syncState] in Iterator(this._messageSyncStates)) {
          if (this._messageInFilterRange(syncState.filterType, message))
            syncState.commands.push({ type: 'delete',
                                      messageId: message.messageId });
        }

        return message;
      }
    }
    return null;
  },

  /**
   * Create a unique SyncKey.
   */
  _createSyncKey: function() {
    return 'messages-' + (this._nextMessageSyncId++) + '/' + this.id;
  },

  /**
   * Create a new sync state for this folder. Sync states keep track of the
   * changes in the folder that occur since the creation of the sync state.
   * These changes are filtered by the |filterType|, which limits the date
   * range of changes to listen for.
   *
   * A sync state can also be populated with an initial array of commands, or
   * "initial" to add all the messages in the folder to the state (subject to
   * |filterType|).
   *
   * Commands are ordered in the sync state from oldest to newest, to mimic
   * Hotmail's behavior. However, this implementation doesn't currently coalesce
   * multiple changes into a single command.
   *
   * @param filterType the filter type for this sync state
   * @param commands (optional) an array of commands to add to the sync state
   *        immediately, or the string "initial" to add all the current messages
   *        in the folder
   * @return the SyncKey associated with this sync state
   */
  createSyncState: function(filterType, commands) {
    if (commands === 'initial') {
      commands = [];
      // Go in reverse, since messages are stored in descending date order, but
      // we want ascending date order.
      for (let i = this.messages.length - 1; i >= 0; i--) {
        if (this._messageInFilterRange(filterType, this.messages[i]))
          commands.push({ type: 'add', message: this.messages[i] });
      }
    }

    let syncKey = this._createSyncKey();
    let syncState = this._messageSyncStates[syncKey] = {
      filterType: filterType,
      commands: commands || []
    };

    return syncKey;
  },

  /**
   * Recreate a sync state by giving it a new SyncKey and adding it back to our
   * list of tracked states.
   *
   * @param syncState the old sync state to add back in
   * @return the SyncKey associated with this sync state
   */
  recreateSyncState: function(syncState) {
    let syncKey = this._createSyncKey();
    this._messageSyncStates[syncKey] = syncState;
    return syncKey;
  },

  /**
   * Remove a sync state from our list (thus causing it to stop listening for
   * new changes) and return it.
   *
   * @param syncKey the SyncKey associated with the sync state
   * @return the sync state
   */
  takeSyncState: function(syncKey) {
    let syncState = this._messageSyncStates[syncKey];
    delete this._messageSyncStates[syncKey];
    return syncState;
  },

  /**
   * Check if the folder knows about a particular sync state.
   *
   * @param syncKey the SyncKey associated with the sync state
   * @return true if the folder knows about this sycn state, false otherwise
   */
  hasSyncState: function(syncKey) {
    return this._messageSyncStates.hasOwnProperty(syncKey);
  },

  /**
   * Get the filter type for a given sync state.
   *
   * @param syncKey the SyncKey associated with the sync state
   * @return the filter type
   */
  filterTypeForSyncState: function(syncKey) {
    return this._messageSyncStates[syncKey].filterType;
  },

  /**
   * Get the number of pending commands for a given sync state.
   *
   * @param syncKey the SyncKey associated with the sync state
   * @return the number of commands
   */
  numCommandsForSyncState: function(syncKey) {
    return this._messageSyncStates[syncKey].commands.length;
  },
};

/**
 * Create a new ActiveSync server instance. Currently, this server only supports
 * one user.
 *
 * @param startDate (optional) a timestamp to set the server's clock to
 */
function ActiveSyncServer(startDate) {
  this.server = new HttpServer();
  this.msgGen = new MessageGenerator();

  // Make sure the message generator is using the same start date as us.
  this._clock = this.msgGen._clock = startDate || Date.now();

  const folderType = $_ascp.FolderHierarchy.Enums.Type;
  this._folders = [];
  this.foldersByType = {
    inbox:  [],
    sent:   [],
    drafts: [],
    trash:  [],
    normal: []
  };
  this.foldersById = {};

  this._nextCollectionId = 1;
  this._nextFolderSyncId = 1;
  this._folderSyncStates = {};

  this.addFolder('Inbox', folderType.DefaultInbox);
  this.addFolder('Sent Mail', folderType.DefaultSent, null, {count: 5});
  this.addFolder('Trash', folderType.DefaultDeleted, null, {count: 0});

  this.logRequest = null;
  this.logRequestBody = null;
  this.logResponse = null;
  this.logResponseError = null;
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

  /**
   * Create a new folder on this server.
   *
   * @param name the folder's name
   * @param type (optional) the folder's type, as an enum from
   *        FolderHierarchy.Enums.Type
   * @param parentId (optional) the id of the folder to contain this folder
   * @param args (optional) arguments to pass to makeMessages() to generate
   *        initial messages for this folder
   */
  addFolder: function(name, type, parentId, args) {
    if (type && !this._folderTypes.hasOwnProperty(type))
      throw new Error('Invalid folder type');

    let folder = new ActiveSyncFolder(this, name, type, parentId, args);
    this._folders.push(folder);
    this.foldersByType[this._folderTypes[folder.type]].push(folder);
    this.foldersById[folder.id] = folder;

    for (let [,syncState] in Iterator(this._folderSyncStates))
      syncState.push({ type: 'add', folder: folder });

    return folder;
  },

  /**
   * Handle incoming requests.
   *
   * @param request the nsIHttpRequest
   * @param response the nsIHttpResponse
   */
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
        let wbxmlResponse = this['_handleCommand_' + query.Cmd](
          request, query, response);

        if (wbxmlResponse) {
          response.setStatusLine('1.1', 200, 'OK');
          response.setHeader('Content-Type', 'application/vnd.ms-sync.wbxml');
          response.write(encodeWBXML(wbxmlResponse));
          if (this.logResponse)
            this.logResponse(request, response, wbxmlResponse);
        }
      } catch(e) {
        if (this.logResponseError)
          this.logResponseError(e + '\n' + e.stack);
        else
          dump(e + '\n' + e.stack + '\n');
        throw e;
      }
    }
  },

  /**
   * Handle the OPTIONS request, returning our list of supported commands, and
   * other useful details.
   *
   * @param request the nsIHttpRequest
   * @param response the nsIHttpResponse
   */
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

  /**
   * Handle the FolderSync command. This entails keeping track of which folders
   * the client knows about using folder SyncKeys.
   *
   * @param request the nsIHttpRequest
   * @param query an object of URL query parameters
   * @param response the nsIHttpResponse
   */
  _handleCommand_FolderSync: function(request, query, response) {
    const fh = $_ascp.FolderHierarchy.Tags;
    const folderType = $_ascp.FolderHierarchy.Enums.Type;

    let syncKey;

    let e = new $_wbxml.EventParser();
    e.addEventListener([fh.FolderSync, fh.SyncKey], function(node) {
      syncKey = node.children[0].textContent;
    });
    let reader = decodeWBXML(request.bodyInputStream);
    if (this.logRequestBody)
      this.logRequestBody(reader);
    e.run(reader);

    let nextSyncKey = 'folders-' + (this._nextFolderSyncId++);
    this._folderSyncStates[nextSyncKey] = [];

    let w = new $_wbxml.Writer('1.3', 1, 'UTF-8');
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
      let syncState = this._folderSyncStates[syncKey];
      delete this._folderSyncStates[syncKey];
      w.tag(fh.Count, syncState.length);

      for (let change of syncState) {
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

    return w;
  },

  /**
   * Handle the Sync command. This is the meat of the ActiveSync server. We need
   * to keep track of SyncKeys for each folder (handled in ActiveSyncFolder),
   * respond to commands from the client, and update clients with any changes
   * we know about.
   *
   * @param request the nsIHttpRequest
   * @param query an object of URL query parameters
   * @param response the nsIHttpResponse
   */
  _handleCommand_Sync: function(request, query, response) {
    const as = $_ascp.AirSync.Tags;
    const asEnum = $_ascp.AirSync.Enums;

    let syncKey, collectionId, getChanges,
        server = this,
        deletesAsMoves = true,
        filterType = asEnum.FilterType.NoFilter,
        clientCommands = [];

    let e = new $_wbxml.EventParser();
    const base = [as.Sync, as.Collections, as.Collection];

    e.addEventListener(base.concat(as.SyncKey), function(node) {
      syncKey = node.children[0].textContent;
    });
    e.addEventListener(base.concat(as.CollectionId), function(node) {
      collectionId = node.children[0].textContent;
    });
    e.addEventListener(base.concat(as.DeletesAsMoves), function(node) {
      deletesAsMoves = node.children.length === 0 ||
                       node.children[0].textContent === '1';
    });
    e.addEventListener(base.concat(as.GetChanges), function(node) {
      getChanges = node.children.length === 0 ||
                   node.children[0].textContent === '1';
    });
    e.addEventListener(base.concat(as.Options, as.FilterType), function(node) {
      filterType = node.children[0].textContent;
    });
    e.addEventListener(base.concat(as.Commands, as.Change), function(node) {
      let command = { type: 'change' };
      for (let child of node.children) {
        switch(child.tag) {
        case as.ServerId:
          command.serverId = child.children[0].textContent;
          break;
        case as.ApplicationData:
          command.changes = server._parseEmailChange(child);
          break;
        }
      }
      clientCommands.push(command);
    });
    e.addEventListener(base.concat(as.Commands, as.Delete), function(node) {
      let command = { type: 'delete' };
      for (let child of node.children) {
        switch(child.tag) {
        case as.ServerId:
          command.serverId = child.children[0].textContent;
          break;
        }
      }
      clientCommands.push(command);
    });

    let reader = decodeWBXML(request.bodyInputStream) ||
                 this._cachedSyncRequest;
    if (this.logRequestBody)
      this.logRequestBody(reader);
    e.run(reader);

    // If GetChanges wasn't specified, it defaults to true when the SyncKey is
    // non-zero, and false when the SyncKey is zero.
    if (getChanges === undefined)
      getChanges = syncKey !== '0';

    // Now it's time to actually perform the sync operation!

    let folder = this._findFolderById(collectionId),
        syncState = null, status, nextSyncKey;

    // - Get an initial sync key.
    if (syncKey === '0') {
      // Initial sync can't change anything, in either direction.
      if (getChanges || clientCommands.length) {
        let w = new $_wbxml.Writer('1.3', 1, 'UTF-8');
        w.stag(as.Sync)
           .tag(as.Status, asEnum.Status.ProtocolError)
         .etag();
       return w;
      }

      nextSyncKey = folder.createSyncState(filterType, 'initial');
      status = asEnum.Status.Success;
    }
    // - Check for invalid sync keys.
    else if (!folder.hasSyncState(syncKey) ||
             (filterType &&
              filterType !== folder.filterTypeForSyncState(syncKey))) {
      nextSyncKey = '0';
      status = asEnum.Status.InvalidSyncKey;
    }
    // - Perform a sync operation where the client has requested some changes.
    else if (clientCommands.length) {
      // Save off the sync state so that our commands don't touch it.
      syncState = folder.takeSyncState(syncKey);

      // Run any commands the client sent.
      for (let command of clientCommands) {
        if (command.type === 'change') {
          let message = folder.findMessageById(command.serverId);
          folder.changeMessage(message, command.changes);
        }
        else if (command.type === 'delete') {
          let message = folder.removeMessageById(command.serverId);
          if (deletesAsMoves)
            this.foldersByType['trash'][0].addMessage(message);
        }
      }

      // Create the next sync state, with a new SyncKey.
      if (getChanges) {
        // Create a fresh sync state.
        nextSyncKey = folder.createSyncState(syncState.filterType);
      }
      else {
        // Create a new state with the old one's command list, and clear out
        // our syncState so we don't return any changes.
        nextSyncKey = folder.recreateSyncState(syncState);
        syncState = null;
      }

      status = asEnum.Status.Success;
    }
    else if (getChanges) {
      if (folder.numCommandsForSyncState(syncKey)) {
        // There are pending changes, so create a fresh sync state.
        syncState = folder.takeSyncState(syncKey);
        nextSyncKey = folder.createSyncState(syncState.filterType);
        status = asEnum.Status.Success;
      }
      else {
        // There are no changes, so cache the sync request and return an empty
        // response.
        response.setStatusLine('1.1', 200, 'OK');
        reader.rewind();
        this._cachedSyncRequest = reader;
        return;
      }
    }
    // - A sync without changes requested and no commands to run -> error!
    else {
      let w = new $_wbxml.Writer('1.3', 1, 'UTF-8');
      w.stag(as.Sync)
         .tag(as.Status, asEnum.Status.ProtocolError)
       .etag();
      return w;
    }

    let w = new $_wbxml.Writer('1.3', 1, 'UTF-8');

    w.stag(as.Sync)
       .stag(as.Collections)
         .stag(as.Collection)
           .tag(as.SyncKey, nextSyncKey)
           .tag(as.CollectionId, collectionId)
           .tag(as.Status, status);

    if (syncState && syncState.commands.length) {
      w.stag(as.Commands);

      for (let command of syncState.commands) {
        if (command.type === 'add') {
          w.stag(as.Add)
             .tag(as.ServerId, command.message.messageId)
             .stag(as.ApplicationData);

          this._writeEmail(w, command.message);

          w  .etag(as.ApplicationData)
            .etag(as.Add);
        }
        else if (command.type === 'change') {
          w.stag(as.Change)
             .tag(as.ServerId, command.messageId)
             .stag(as.ApplicationData);

          if ('read' in command.changes)
            w.tag(em.Read, command.changes.read ? '1' : '0');

          if ('flag' in command.changes)
            w.stag(em.Flag)
               .tag(em.Status, command.changes.flag)
             .etag();

          w  .etag(as.ApplicationData)
            .etag(as.Change);
        }
        else if (command.type === 'delete') {
          w.stag(as.Delete)
             .tag(as.ServerId, command.messageId)
           .etag(as.Delete);
        }
      }

      w.etag(as.Commands);
    }

    if (clientCommands.length) {
      w.stag(as.Responses);

      for (let command of clientCommands) {
        if (command.type === 'change') {
          w.stag(as.Change)
             .tag(as.ServerId, command.serverId)
             .tag(as.Status, asEnum.Status.Success)
           .etag(as.Change);
        }
      }

      w.etag(as.Responses);
    }

    w    .etag(as.Collection)
       .etag(as.Collections)
     .etag(as.Sync);

    return w;
  },

  /**
   * Handle the ItemOperations command. Mainly, this is used to get message
   * bodies and attachments.
   *
   * @param request the nsIHttpRequest
   * @param query an object of URL query parameters
   * @param response the nsIHttpResponse
   */
  _handleCommand_ItemOperations: function(request, query, response) {
    const io = $_ascp.ItemOperations.Tags;
    const as = $_ascp.AirSync.Tags;

    let fetches = [];

    let server = this;
    let e = new $_wbxml.EventParser();
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

    let w = new $_wbxml.Writer('1.3', 1, 'UTF-8');
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

    return w;
  },

  /**
   * Handle the GetItemEstimate command. This gives the client the number of
   * changes to expect from a Sync request.
   *
   * @param request the nsIHttpRequest
   * @param query an object of URL query parameters
   * @param response the nsIHttpResponse
   */
  _handleCommand_GetItemEstimate: function(request, query, response) {
    const ie = $_ascp.ItemEstimate.Tags;
    const as = $_ascp.AirSync.Tags;
    const ieStatus = $_ascp.ItemEstimate.Enums.Status;

    let syncKey, collectionId;

    let server = this;
    let e = new $_wbxml.EventParser();
    e.addEventListener([ie.GetItemEstimate, ie.Collections, ie.Collection],
                       function(node) {
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

    let status, syncState, estimate,
        folder = this._findFolderById(collectionId);
    if (!folder)
      status = ieStatus.InvalidCollection;
    else if (syncKey === '0')
      status = ieStatus.NoSyncState;
    else if (!folder.hasSyncState(syncKey))
      status = ieStatus.InvalidSyncKey;
    else {
      status = ieStatus.Success;
      estimate = folder.numCommandsForSyncState(syncKey);
    }

    let w = new $_wbxml.Writer('1.3', 1, 'UTF-8');
    w.stag(ie.GetItemEstimate)
       .stag(ie.Response)
         .tag(ie.Status, status);

    if (status === ieStatus.Success)
      w  .stag(ie.Collection)
           .tag(ie.CollectionId, collectionId)
           .tag(ie.Estimate, estimate)
         .etag();

    w  .etag(ie.Response)
     .etag(ie.GetItemEstimate);

    return w;
  },

  /**
   * Handle the MoveItems command. This lets clients move messages between
   * folders. Note that they'll have to get up-to-date via a Sync request
   * afterward.
   *
   * @param request the nsIHttpRequest
   * @param query an object of URL query parameters
   * @param response the nsIHttpResponse
   */
  _handleCommand_MoveItems: function(request, query, response) {
    const mo = $_ascp.Move.Tags;
    const moStatus = $_ascp.Move.Enums.Status;

    let moves = [];
    let e = new $_wbxml.EventParser();
    e.addEventListener([mo.MoveItems, mo.Move], function(node) {
      let move = {};

      for (let child of node.children) {
        let textContent = child.children[0].textContent;

        switch (child.tag) {
        case mo.SrcMsgId:
          move.srcMessageId = textContent;
          break;
        case mo.SrcFldId:
          move.srcFolderId = textContent;
          break;
        case mo.DstFldId:
          move.destFolderId = textContent;
          break;
        }
      }

      moves.push(move);
    });
    let reader = decodeWBXML(request.bodyInputStream);
    if (this.logRequestBody)
      this.logRequestBody(reader);
    e.run(reader);

    let w = new $_wbxml.Writer('1.3', 1, 'UTF-8');
    w.stag(mo.MoveItems);

    for (let move of moves) {
      let srcFolder = this._findFolderById(move.srcFolderId),
          destFolder = this._findFolderById(move.destFolderId),
          status;

      if (!srcFolder) {
        status = moStatus.InvalidSourceId;
      }
      else if (!destFolder) {
        status = moStatus.InvalidDestId;
      }
      else if (srcFolder === destFolder) {
        status = moStatus.SourceIsDest;
      }
      else {
        let message = srcFolder.removeMessageById(move.srcMessageId);

        if (!message) {
          status = moStatus.InvalidSourceId;
        }
        else {
          status = moStatus.Success;
          destFolder.addMessage(message);
        }
      }

      w.stag(mo.Response)
         .tag(mo.SrcMsgId, move.srcMessageId)
         .tag(mo.Status, status);

      if (status === moStatus.Success)
        w.tag(mo.DstMsgId, move.srcMessageId)

      w.etag(mo.Response);
    }

    w.etag(mo.MoveItems);
    return w;
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
   * Find a folder object by its server ID.
   *
   * @param id the CollectionId for the folder
   * @return the ActiveSyncFolder object, or null if no folder was found
   */
  findFolderByName: function(name) {
    for (let folder of this._folders) {
      if (folder.name === name)
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
    const em  = $_ascp.Email.Tags;
    const asb = $_ascp.AirSyncBase.Tags;
    const asbEnum = $_ascp.AirSyncBase.Enums;

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
     .tag(em.Read, message.metaState.read ? '1' : '0')
     .stag(em.Flag)
       .tag(em.Status, message.metaState.flag || '0')
     .etag();

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
  },

  /**
   * Parse the WBXML for a client-side email change command.
   *
   * @param node the (fully-parsed) ApplicationData node and its children
   * @return an object enumerating the changes requested
   */
  _parseEmailChange: function(node) {
    const em = $_ascp.Email.Tags;
    let changes = {};

    for (let child of node.children) {
      switch (child.tag) {
      case em.Read:
        changes.read = child.children[0].textContent === '1';
        break;
      case em.Flag:
        for (let grandchild of child.children) {
          switch (grandchild.tag) {
          case em.Status:
            changes.flag = grandchild.children[0].textContent;
            break;
          }
        }
        break;
      }
    }

    return changes;
  },
};
