define(
  [
    'rdcommon/log',
    'mailparser/mailparser',
    '../a64',
    '../allback',
    '../util',
    './imapchew',
    'module',
    'exports'
  ],
  function(
    $log,
    $mailparser,
    $a64,
    $allback,
    $util,
    $imapchew,
    $module,
    exports
  ) {
const allbackMaker = $allback.allbackMaker,
      bsearchForInsert = $util.bsearchForInsert,
      bsearchMaybeExists = $util.bsearchMaybeExists,
      cmpHeaderYoungToOld = $util.cmpHeaderYoungToOld;

/**
 * Compact an array in-place with nulls so that the nulls are removed.  This
 * is done by a scan with an adjustment delta and a final splice to remove
 * the spares.
 */
function compactArray(arr) {
  // this could also be done with a write pointer.
  var delta = 0, len = arr.length;
  for (var i = 0; i < len; i++) {
    var obj = arr[i];
    if (obj === null) {
      delta++;
      continue;
    }
    if (delta)
      arr[i - delta] = obj;
  }
  if (delta)
    arr.splice(len - delta, delta);
  return arr;
}

/**
 * We don't care about deleted messages, it's best that we're not aware of them.
 * However, it's important to keep in mind that this means that EXISTS provides
 * us with an upper bound on the messages in the folder since we are blinding
 * ourselves to deleted messages.
 */
const BASELINE_SEARCH_OPTIONS = ['!DELETED'];

/**
 * Fetch parameters to get the headers / bodystructure; exists to reuse the
 * object since every fetch is the same.  Note that imap.js always gives us
 * FLAGS and INTERNALDATE so we don't need to ask for that.
 *
 * We are intentionally not using ENVELOPE because Thunderbird intentionally
 * defaults to to not using ENVELOPE.  Per bienvenu in
 * https://bugzilla.mozilla.org/show_bug.cgi?id=402594#c33 "We stopped using it
 * by default because servers often had issues with it so it was more trouble
 * than it was worth."
 *
 * Of course, imap.js doesn't really support ENVELOPE outside of bodystructure
 * right now either, but that's a lesser issue.  We probably don't want to trust
 * that data, however, if we don't want to trust normal ENVELOPE.
 */
const INITIAL_FETCH_PARAMS = {
  request: {
    headers: ['FROM', 'TO', 'CC', 'BCC', 'SUBJECT', 'REPLY-TO', 'MESSAGE-ID',
              'REFERENCES'],
    struct: true
  },
};

/**
 * Fetch parameters to just get the flags, which is no parameters because
 * imap.js always fetches them right now.
 */
const FLAG_FETCH_PARAMS = {
  request: {
  },
};


/**
 * Folder connections do the actual synchronization logic.  They are associated
 * with one or more `ImapSlice` instances that issue the requests that trigger
 * synchronization.  Storage is handled by `ImapFolderStorage` or
 * `GmailMessageStorage` instances.
 *
 * == IMAP Protocol Connection Management
 *
 * We request IMAP protocol connections from the account.  There is currently no
 * way for us to surrender our connection or indicate to the account that we
 * are capable of surrending the connection.  That might be a good idea, though.
 *
 * All accesses to a folder's connection should be done through an
 * `ImapFolderConn`, even if the actual mutation logic is being driven by code
 * living in the account.
 *
 * == IDLE
 *
 * We plan to IDLE in folders that we have active slices in.  We are assuming
 * the most basic IDLE implementation where it will tell us when the number
 * of messages increases (EXISTS), or decreases (EXPUNGE and EXISTS), with no
 * notifications when flags change.  (This is my current understanding of how
 * gmail operates from internet searches; we're not quite yet to protocol
 * experimentation yet.)
 *
 * The idea is accordingly that we will use IDLE notifications as a hint that
 * we should do a SEARCH for new messages.  It is that search that will update
 * our accuracy information and only that.
 */
function ImapFolderConn(account, storage, _parentLog) {
  this._account = account;
  this._storage = storage;
  this._LOG = LOGFAB.ImapFolderConn(this, _parentLog, storage.folderId);

  this._conn = null;
  this.box = null;
}
exports.ImapFolderConn = ImapFolderConn;
ImapFolderConn.prototype = {
  get totalMessages() {
    return this.box && this.box.messages.total;
  },

  /**
   * Acquire a connection and invoke the callback once we have it and we have
   * entered the folder.
   *
   * XXX This is inherently dangerous in the face of concurrent attempts to
   * call this method or check whether it has completed.  We need to move to
   * our queue of operations on the folder, or ensure that a higher level layer
   * is enforcing this.  To be done with proper mutation logic impl.
   */
  acquireConn: function(callback) {
    var self = this;
    this._account.__folderDemandsConnection(
      this._storage.folderId,
      function(conn) {
        self._conn = conn;
        // Now we have a connection, but it's not in the folder.
        // (If we were doing fancier sync like QRESYNC, we would not enter
        // in such a blase fashion.)
        self._conn.openBox(self._storage.folderMeta.path,
                           function openedBox(err, box) {
            if (err) {
              console.error('Problem entering folder',
                            self._storage.folderMeta.path);
              return;
            }
            self.box = box;
            callback(self);
          });
      });
  },

  relinquishConn: function() {
    if (!this._conn)
      return;

    this._account.__folderDoneWithConnection(this._storage.folderId,
                                             this._conn);
    this._conn = null;
  },

  /**
   * Wrap the search command and shirk the errors for now.  I was thinking we
   * might have this do automatic connection re-establishment, etc., but I think
   * it makes more sense to have the IMAP protocol connection object do that
   * under the hood or in participation with the account class via another
   * interface since it already handles command queueing.
   *
   * This also conveniently hides the connection acquisition asynchrony.
   */
  _reliaSearch: function(searchOptions, callback) {
    // If we don't have a connection, get one, then re-call.
    if (!this._conn) {
      this.acquireConn(this._reliaSearch.bind(this, searchOptions, callback));
      return;
    }

    this._conn.search(searchOptions, function(err, uids) {
        if (err) {
          console.error('Search error on', searchOptions, 'err:', err);
          return;
        }
        callback(uids);
      });
  },

  /**
   * Perform a search to find all the messages in the given date range.
   * Meanwhile, load the set of messages from storage.  Infer deletion of the
   * messages we already know about that should exist in the search results but
   * do not.  Retrieve information on the messages we don't know anything about
   * and update the metadata on the messages we do know about.
   *
   * An alternate way to accomplish the new/modified/deleted detection for a
   * range might be to do a search over the UID range of new-to-us UIDs and
   * then perform retrieval on what we get back.  We would do a flag fetch for
   * all the UIDs we already know about and use that to both get updated
   * flags and infer deletions from UIDs that don't report back.  Except that
   * might not work because the standard doesn't seem to say that if we
   * specify gibberish UIDs that it should keep going for the UIDs that are
   * not gibberish.  Also, it's not clear what the performance impact of the
   * additional search constraint might be on server performance.  (Of course,
   * if the server does not have an index on internaldate, these queries are
   * going to be very expensive and the UID limitation would probably be a
   * mercy to the server.)
   */
  syncDateRange: function(startTS, endTS, accuracyStamp, useBisectLimit,
                          doneCallback) {
console.log("syncDateRange:", startTS, endTS);
    var searchOptions = BASELINE_SEARCH_OPTIONS.concat(), self = this,
      storage = self._storage;
    if (!useBisectLimit)
      useBisectLimit = SYNC_BISECT_DATE_AT_N_MESSAGES;
    if (startTS)
      searchOptions.push(['SINCE', startTS]);
    if (endTS)
      searchOptions.push(['BEFORE', endTS]);

    var callbacks = allbackMaker(
      ['search', 'db'],
      function syncDateRangeLogic(results) {
        var serverUIDs = results.search, headers = results.db,
            knownUIDs = [], uid, numDeleted = 0,
            modseq = self._conn._state.box.highestModSeq || '';

console.log('SERVER UIDS', serverUIDs.length, useBisectLimit);
        if (serverUIDs.length > useBisectLimit) {
          var effEndTS = endTS || FUTURE_TIME_WARPED_NOW ||
                           quantizeDate(Date.now() + DAY_MILLIS),
              curDaysDelta = (effEndTS - startTS) / DAY_MILLIS;
          // We are searching more than one day, we can shrink our search.

console.log('BISECT CASE', serverUIDs.length, 'curDaysDelta', curDaysDelta);
          if (curDaysDelta > 1) {
            // Sanity check the time delta; if we grew the bounds to the dawn
            // of time, then our interpolation is useless and it's better for
            // us to crank things way down, even if it's erroneously so.
            if (curDaysDelta > 1000)
              curDaysDelta = 30;

            // - Interpolate better time bounds.
            // Assume a linear distribution of messages, but overestimated by
            // a factor of two so we undershoot.
            var shrinkScale = SYNC_BISECT_DATE_AT_N_MESSAGES /
                                (serverUIDs.length * 2),
                backDays = Math.max(1,
                                    Math.ceil(shrinkScale * curDaysDelta));
            // mark the bisection abort...
            self._LOG.syncDateRange_end(null, null, null, startTS, endTS);
            var bisectInfo = {
              oldStartTS: startTS,
              dayStep: backDays,
              newStartTS: makeDaysBefore(effEndTS, backDays),
            };
            startTS = bisectInfo.newStartTS;
            // If we were being used for a refresh, they may want us to stop
            // and change their sync strategy.
            if (doneCallback(bisectInfo, null) === 'abort') {
              doneCallback('aborted', null);
              return null;
            }
console.log("backoff! had", serverUIDs.length, "from", curDaysDelta,
            "startTS", startTS, "endTS", endTS, "backDays", backDays);
            return self.syncDateRange(startTS, endTS, accuracyStamp, null,
                                      doneCallback);
          }
        }

        // -- infer deletion, flag to distinguish known messages
        // rather than splicing lists and causing shifts, we null out values.
        for (var iMsg = 0; iMsg < headers.length; iMsg++) {
          var header = headers[iMsg];
          var idxUid = serverUIDs.indexOf(header.id);
          // deleted!
          if (idxUid === -1) {
            storage.deleteMessageHeaderAndBody(header);
            numDeleted++;
            headers[iMsg] = null;
            continue;
          }
          // null out the UID so the non-null values in the search are the
          // new messages to us.
          serverUIDs[idxUid] = null;
          // but save the UID so we can do a flag-check.
          knownUIDs.push(header.id);
        }

        var newUIDs = compactArray(serverUIDs); // (re-labeling, same array)
        if (numDeleted)
          compactArray(headers);

        return self._commonSync(
          newUIDs, knownUIDs, headers,
          function(newCount, knownCount) {
            self._LOG.syncDateRange_end(newCount, knownCount, numDeleted,
                                        startTS, endTS);
            self._storage.markSyncRange(startTS, endTS, modseq,
                                        accuracyStamp);
            doneCallback(null, newCount + knownCount);
          });
      });

    this._LOG.syncDateRange_begin(null, null, null, startTS, endTS);
    this._reliaSearch(searchOptions, callbacks.search);
    this._storage.getAllMessagesInImapDateRange(startTS, endTS, callbacks.db);
  },

  searchDateRange: function(endTS, startTS, searchParams,
                            slice) {
    var searchOptions = BASELINE_SEARCH_OPTIONS.concat(searchParams);
    if (startTS)
      searchOptions.push(['SINCE', startTS]);
    if (endTS)
      searchOptions.push(['BEFORE', endTS]);
  },

  /**
   * Given a list of new-to-us UIDs and known-to-us UIDs and their corresponding
   * headers, synchronize the flags for the known UIDs' headers and fetch and
   * create the header and body objects for the new UIDS.
   *
   * First we fetch the headers/bodystructures for the new UIDs all in one go;
   * all of these headers are going to end up in-memory at the same time, so
   * batching won't let us reduce the overhead right now.  We process them
   * to determine the body parts we should fetch as the results come in.  Once
   * we have them all, we sort them by date, endTS-to-startTS for the third
   * step and start issuing/pipelining the requests.
   *
   * Second, we issue the flag update requests for the known-to-us UIDs.  This
   * is done second so it can help avoid wasting the latency of the round-trip
   * that would otherwise result between steps one and three.  (Although we
   * could also mitigate that by issuing some step three requests even as
   * the step one requests are coming in; our sorting doesn't have to be
   * perfect and may already be reasonably well ordered if UIDs correlate
   * with internal date well.)
   *
   * Third, we fetch the body parts in our newest-to-startTS order, adding
   * finalized headers and bodies as we go.
   */
  _commonSync: function(newUIDs, knownUIDs, knownHeaders, doneCallback) {
    var conn = this._conn, storage = this._storage;
console.log("_commonSync", 'newUIDs', newUIDs.length, 'knownUIDs',
            knownUIDs.length, 'knownHeaders', knownHeaders.length);
    var callbacks = allbackMaker(
      ['newMsgs', 'knownMsgs'],
      function() {
        // It is possible that async I/O will be required to add a header or a
        // body, so we need to defer declaring the synchronization done until
        // after all of the storage's deferred calls have run because the
        // header/body affecting calls will have been deferred.
        storage.runAfterDeferredCalls(
          doneCallback.bind(null, newUIDs.length, knownUIDs.length));
      });

    // -- Fetch headers/bodystructures for new UIDs
    var newChewReps = [];
    if (newUIDs.length) {
      var newFetcher = this._conn.fetch(newUIDs, INITIAL_FETCH_PARAMS);
      newFetcher.on('message', function onNewMessage(msg) {
          msg.on('end', function onNewMsgEnd() {
console.log('  new fetched, header processing');
            newChewReps.push($imapchew.chewHeaderAndBodyStructure(msg));
console.log('   header processed');
          });
        });
      newFetcher.on('error', function onNewFetchError(err) {
          // XXX the UID might have disappeared already?  we might need to have
          // our initiating command re-do whatever it's up to.  Alternatively,
          // we could drop back from a bulk fetch to a one-by-one fetch.
          console.warn('New UIDs fetch error, ideally harmless:', err);
        });
      newFetcher.on('end', function onNewFetchEnd() {
          // sort the messages, endTS to startTS (aka numerically descending)
          newChewReps.sort(function(a, b) {
              return b.msg.date - a.msg.date;
            });

          // - issue the bodypart fetches.
          // Use mailparser's body parsing capabilities, albeit not entirely in
          // the way it was intended to be used since it wants to parse full
          // messages.
          var mparser = new $mailparser.MailParser();
          function setupBodyParser(partDef) {
            mparser._state = 0x2; // body
            mparser._remainder = '';
            mparser._currentNode = null;
            mparser._currentNode = mparser._createMimeNode(null);
            // nb: mparser._multipartTree is an empty list (always)
            mparser._currentNode.meta.contentType =
              partDef.type.toLowerCase() + '/' +
              partDef.subtype.toLowerCase();
            mparser._currentNode.meta.charset =
              partDef.params && partDef.params.charset &&
              partDef.params.charset.toLowerCase();
            mparser._currentNode.meta.transferEncoding =
              partDef.encoding && partDef.encoding.toLowerCase();
            mparser._currentNode.meta.textFormat =
              partDef.params && partDef.params.format &&
              partDef.params.format.toLowerCase();
          }
          function bodyParseBuffer(buffer) {
            process.immediate = true;
            mparser.write(buffer);
            process.immediate = false;
          }
          function finishBodyParsing() {
            process.immediate = true;
            mparser._process(true);
            process.immediate = false;
            // We end up having provided an extra newline that we don't
            // want, so let's cut it off if it exists.
            var content = mparser._currentNode.content;
            if (content.charCodeAt(content.length - 1) === 10)
              content = content.substring(0, content.length - 1);
            return content;
          }

          // XXX imap.js is currently not capable of issuing/parsing multiple
          // literal results from a single fetch result line.  It's not a
          // fundamentally hard problem, but I'd rather defer messing with its
          // parse loop (and internal state tracking) until a future time when
          // I can do some other cleanup at the same time.  (The subsequent
          // literals are just on their own lines with an initial space and then
          // the named literal.  Ex: " BODY[1.2] {2463}".)
          //
          // So let's issue one fetch per body part and then be happy when we've
          // got them all.
          var pendingFetches = 0;
          newChewReps.forEach(function(chewRep, iChewRep) {
            var partsReceived = [];
            // If there are no parts to process, consume it now.
            if (chewRep.bodyParts.length === 0) {
              if ($imapchew.chewBodyParts(chewRep, partsReceived,
                                          storage.folderId)) {
                storage.addMessageHeader(chewRep.header);
                storage.addMessageBody(chewRep.header, chewRep.bodyInfo);
              }
            }

            chewRep.bodyParts.forEach(function(bodyPart) {
              var opts = { request: { body: bodyPart.partID } };
              pendingFetches++;

console.log('  fetching for', chewRep.msg.id, bodyPart.partID);
              var fetcher;
try {
              fetcher = conn.fetch(chewRep.msg.id, opts);
} catch (ex) {
  console.warn('!failure fetching', ex);
  return;
}
              setupBodyParser(bodyPart);
              fetcher.on('error', function(err) {
                console.warn('body fetch error', err);
                if (--pendingFetches === 0)
                  callbacks.newMsgs();
              });
              fetcher.on('message', function(msg) {
                setupBodyParser(bodyPart);
                msg.on('data', bodyParseBuffer);
                msg.on('end', function() {
                  partsReceived.push(finishBodyParsing());
console.log('  !fetched body part for', chewRep.msg.id, bodyPart.partID,
            partsReceived.length, chewRep.bodyParts.length);

                  // -- Process
                  if (partsReceived.length === chewRep.bodyParts.length) {
                    if ($imapchew.chewBodyParts(chewRep, partsReceived,
                                                storage.folderId)) {
                      storage.addMessageHeader(chewRep.header);
                      storage.addMessageBody(chewRep.header, chewRep.bodyInfo);
                    }
else { console.warn("failure to parse body!!!"); }
                  }
                  // If this is the last chew rep, then use its completion
                  // to report our completion.
                  if (--pendingFetches === 0)
                    callbacks.newMsgs();
                });
              });
            });
          });
console.log('  pending fetches', pendingFetches);
          if (pendingFetches === 0)
            callbacks.newMsgs();
        });
    }
    else {
      callbacks.newMsgs();
    }

    // -- Fetch updated flags for known UIDs
    if (knownUIDs.length) {
      var knownFetcher = this._conn.fetch(knownUIDs, FLAG_FETCH_PARAMS);
      var numFetched = 0;
      knownFetcher.on('message', function onKnownMessage(msg) {
          // (Since we aren't requesting headers, we should be able to get
          // away without registering this next event handler and just process
          // msg right now, but let's wait on an optimization pass.)
          msg.on('end', function onKnownMsgEnd() {
            var i = numFetched++;
            // RFC 3501 doesn't seem to require that we get results in the order
            // we request them, so use indexOf if things don't line up.
            if (knownHeaders[i].id !== msg.id) {
              i = knownUIDs.indexOf(msg.id);
              // If it's telling us about a message we don't know about, run away.
              if (i === -1) {
                console.warn("Server fetch reports unexpected message:", msg.id);
                return;
              }
            }
            var header = knownHeaders[i];
            // (msg.flags comes sorted and we maintain that invariant)
            if (header.flags.toString() !== msg.flags.toString()) {
              header.flags = msg.flags;
              storage.updateMessageHeader(header.date, header.id, true, header);
            }
            else {
              storage.unchangedMessageHeader(header);
            }
          });
        });
      knownFetcher.on('error', function onKnownFetchError(err) {
          // XXX the UID might have disappeared already?  we might need to have
          // our initiating command re-do whatever it's up to.  Alternatively,
          // we could drop back from a bulk fetch to a one-by-one fetch.
          console.warn('Known UIDs fetch error, ideally harmless:', err);
        });
      knownFetcher.on('end', function() {
        callbacks.knownMsgs();
      });
    }
    else {
      callbacks.knownMsgs();
    }
  },

  downloadMessageAttachments: function(uid, partInfos, callback) {
    var conn = this._conn;
    var mparser = new $mailparser.MailParser();

    // I actually implemented a usable shim for the checksum purposes, but we
    // don't actually care about the checksum, so why bother doing the work?
    var dummyChecksummer = {
      update: function() {},
      digest: function() { return null; },
    };

    function setupBodyParser(partInfo) {
      mparser._state = 0x2; // body
      mparser._remainder = '';
      mparser._currentNode = null;
      mparser._currentNode = mparser._createMimeNode(null);
      mparser._currentNode.attachment = true;
      mparser._currentNode.checksum = dummyChecksummer;
      mparser._currentNode.content = undefined;
      // nb: mparser._multipartTree is an empty list (always)
      mparser._currentNode.meta.contentType = partInfo.type;
      mparser._currentNode.meta.transferEncoding = partInfo.encoding;
      mparser._currentNode.meta.charset = null; //partInfo.charset;
      mparser._currentNode.meta.textFormat = null; //partInfo.textFormat;
    }
    function bodyParseBuffer(buffer) {
      process.immediate = true;
      mparser.write(buffer);
      process.immediate = false;
    }
    function finishBodyParsing() {
      process.immediate = true;
      mparser._process(true);
      process.immediate = false;
      // this is a Buffer!
      return mparser._currentNode.content;
    }

    var anyError = null, pendingFetches = 0, bodies = [];
    partInfos.forEach(function(partInfo) {
      var opts = { request: { body: partInfo.part } };
      pendingFetches++;
      var fetcher = conn.fetch(uid, opts);

      setupBodyParser(partInfo);
      fetcher.on('error', function(err) {
        if (!anyError)
          anyError = err;
        if (--pendingFetches === 0)
          callback(anyError, bodies);
      });
      fetcher.on('message', function(msg) {
        setupBodyParser(partInfo);
        msg.on('data', bodyParseBuffer);
        msg.on('end', function() {
          bodies.push(finishBodyParsing());

          if (--pendingFetches === 0)
            callback(anyError, bodies);
        });
      });
    });
  },

  shutdown: function() {
    this._LOG.__die();
  },
};

/**
 * ALL SPECULATIVE RIGHT NOW.
 *
 * Like ImapFolderStorage, but with only one folder and messages named by their
 * X-GM-MSGID value rather than their UID(s).
 *
 * Deletion processing operates slightly differently than for normal IMAP
 * because a message can be removed from one of the folders we synchronize on,
 * but not all of them.  We don't want to be overly deletionary in that case,
 * so we maintain a list of folder id's that are keeping each message alive.
 */
function GmailMessageStorage() {
}
GmailMessageStorage.prototype = {
};

var LOGFAB = exports.LOGFAB = $log.register($module, {
  ImapFolderConn: {
    type: $log.CONNECTION,
    subtype: $log.CLIENT,
    events: {
    },
    TEST_ONLY_events: {
    },
    asyncJobs: {
      syncDateRange: {
        newMessages: true, existingMessages: true, deletedMessages: true,
        start: false, end: false,
      },
    },
  },
}); // end LOGFAB

}); // end define
