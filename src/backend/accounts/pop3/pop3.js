  import logic from 'logic';
  import * as tcpSocket from 'tcp-socket';
  import md5 from 'md5';
  import * as transport from './transport';
  import * as imapchew from '../imap/imapchew';
  import { POP3_SNIPPET_SIZE_GOAL, POP3_INFER_ATTACHMENTS_SIZE } from '../../syncbase';
  import mimefuncs from 'mimefuncs';
  import { makeEventTarget } from 'shared/util';
  import allback from 'shared/allback';

  import PartBuilder from '../../mime/part_builder';

  import ByteCounterTransformStream
    from '../../streamy/byte_counter_transform_stream';
  import MimeNodeTransformStream
    from '../../streamy/mime_node_transform_stream';

  // TODO: Finish updating this file; there are some uses of this that use
  // pre-convoy logic, and this is effectively a poison pill for them to throw
  // when that code gets reached.
  const mimeStreams = null;

  /**
   * The Pop3Client modules and classes are organized according to
   * their function, as follows, from low-level to high-level:
   *
   *      [Pop3Parser] parses raw protocol data from the server.
   *      [Pop3Protocol] handles the request/response semantics
   *                     along with the Request and Response classes,
   *                     which are mostly for internal use. Pop3Protocol
   *                     does not deal with I/O at all.
   *      [Pop3Client] hooks together the Protocol and a socket, and
   *                   handles high-level details like listing messages.
   *
   * In general, this tries to share as much code as possible with
   * IMAP/ActiveSync. We reuse imapchew.js to normalize POP3 MIME
   * messages in the same way as IMAP, to avoid spurious errors trying
   * to write yet another translation layer. All of the MIME parsing
   * happens in this file; transport.js contains purely wire-level
   * logic.
   *
   * Each Pop3Client is responsible for one connection only;
   * Pop3Account in GELAM is responsible for managing connection lifetime.
   *
   * As of this writing (Nov 2013), there was only one other
   * reasonably complete POP3 JavaScript implementation, available at
   * <https://github.com/ditesh/node-poplib>. It would have probably
   * worked, but since the protocol is simple, it seemed like a better
   * idea to avoid patching over Node-isms more than necessary (e.g.
   * avoiding Buffers, node socket-isms, etc.). Additionally, that
   * library only contained protocol-level details, so we would have
   * only really saved some code in transport.js.
   *
   * For error conditions, this class always normalizes errors into
   * the format as documented in the constructor below.
   * All external callbacks get passed node-style (err, ...).
   */

  // Allow setTimeout and clearTimeout to be shimmed for unit tests.
  var setTimeout = globalThis.setTimeout.bind(window);
  var clearTimeout = globalThis.clearTimeout.bind(window);

  /***************************************************************************
   * Pop3Client
   *
   * Connect to a POP3 server. `cb` is always invoked, with (err) if
   * the connction attempt failed. Options are as follows:
   *
   * @param {string} host
   * @param {string} username
   * @param {string} password
   * @param {string} port
   * @param {boolean|'plain'|'ssl'|'starttls'} crypto
   * @param {int} connTimeout optional connection timeout
   * @param {'apop'|'sasl'|'user-pass'} preferredAuthMethod first method to try
   * @param {boolean} debug True to dump the protocol to the console.
   *
   * The connection's current state is available at `.state`, with the
   * following values:
   *
   *   'disconnected', 'greeting', 'starttls', 'authorization', 'ready'
   *
   * All callback errors are normalized to the following form:
   *
   *    var err = {
   *      scope: 'connection|authentication|mailbox|message',
   *      name: '...',
   *      message: '...',
   *      request: Pop3Client.Request (if applicable),
   *      exception: (A socket error, if available),
   *    };
   *
   */
  function Pop3Client(options, cb) {
    // for clarity, list the available options:
    this.options = options = options || {};
    options.host = options.host || null;
    options.username = options.username || null;
    options.password = options.password || null;
    options.port = options.port || null;
    options.crypto = options.crypto || false;
    options.connTimeout = options.connTimeout || 30000;
    options.debug = options.debug || false;
    options.authMethods = ['apop', 'sasl', 'user-pass'];

    logic.defineScope(this, 'Pop3Client', {});

    if (options.preferredAuthMethod) {
      // if we prefer a certain auth method, try that first.
      var idx = options.authMethods.indexOf(options.preferredAuthMethod);
      if (idx !== -1) {
        options.authMethods.splice(idx, 1);
      }
      options.authMethods.unshift(options.preferredAuthMethod);
    }

    // Normalize the crypto option:
    if (options.crypto === true) {
      options.crypto = 'ssl';
    } else if (!options.crypto) {
      options.crypto = 'plain';
    }

    if (!options.port) {
      options.port = {
        'plain': 110,
        'starttls': 110,
        'ssl': 995
      }[options.crypto];
      if (!options.port) {
        throw new Error('Invalid crypto option for Pop3Client: ' +
                        options.crypto);
      }
    }

    // The public state of the connection (the only one we really care
    // about is 'disconnected')
    this.state = 'disconnected';
    this.authMethod = null; // Upon successful login, the method that worked.

    // Keep track of the message IDs and UIDLs the server has reported
    // during this session (these values could change in each
    // session, though they probably won't):
    this.idToUidl = {};
    this.uidlToId = {};
    this.idToSize = {};
    // An array of {uidl: "", size: 0, number: } for each message
    // retrieved as a result of calling LIST
    this._messageList = null;
    this._greetingLine = null; // contains APOP auth info, if available

    this.socket = makeEventTarget(
      tcpSocket.open(options.host, options.port, {
        useSecureTransport: (options.crypto === 'ssl' ||
                             options.crypto === true)
      })
    );

    var connectTimeout = setTimeout(() => {
      this.state = 'disconnected';
      if (connectTimeout) {
        clearTimeout(connectTimeout);
        connectTimeout = null;
      }
      cb && cb({
        scope: 'connection',
        request: null,
        name: 'unresponsive-server',
        message: 'Could not connect to ' + options.host + ':' + options.port +
          ' with ' + options.crypto + ' encryption.',
      });
    }, options.connTimeout);

    this.socket.addEventListener('open', function() {
      console.log('pop3:onopen');
      if (connectTimeout) {
        clearTimeout(connectTimeout);
        connectTimeout = null;
      }
      this.state = 'greeting';
      // No further processing is needed here. We wait for the server
      // to send a +OK greeting before we try to authenticate.
    }.bind(this));

    this.socket.addEventListener('error', function(evt) {
      var err = evt && evt.data || evt;
      console.log('pop3:onerror', err);
      if (connectTimeout) {
        clearTimeout(connectTimeout);
        connectTimeout = null;
      }
      // XXX improve connection life-cycle management.  What we want this to do
      // is:
      // - if there is an active call using us, have us reject that request
      //   with an error.
      // - remove the connection from the parent.
      //
      // What's notably happening right now is we aren't actively using the
      // connection and then it generates an error.  But we don't really care.
      // XXX investigate better why an error is being generated if it's just a
      // timeout?
      if (this.state !== 'disconnected') {
        console.log('pop3:ignoring-error', 'we were connected');
        return;
      }
      cb && cb({
        scope: 'connection',
        request: null,
        name: 'unresponsive-server',
        message: 'Socket exception: ' + JSON.stringify(err),
        exception: err,
      });
    }.bind(this));

    // sync cares about listening for us closing; it has no way to be informed
    // by disaster recovery otherwise
    this.onclose = null;
    this.socket.addEventListener('close', function() {
      console.log('pop3:onclose');
      this.close();
      if (this.onclose) {
        this.onclose();
      }
    }.bind(this));

    // Our request/response matching logic will pair the server's greeting with
    // this request.
    var greetingRequest = new transport.Request(null);
    greetingRequest.then(() => {
      // Store the greeting line, it might be needed in authentication
      this._greetingLine = greetingRequest.getStatusLine();
      this._maybeUpgradeConnection(function(err) {
        if (err) { cb && cb(err); return; }
        this._thenAuthorize(function(err) {
          if (!err) {
            this.state = 'ready';
          }
          cb && cb(err);
        });
      }.bind(this));
    }, (err) => {
      cb && cb({
        scope: 'connection',
        request: null,
        name: 'unresponsive-server',
        message: err.statusLine,
        response: err,
      });
    });

    this.requestStream =
      new transport.Pop3RequestStream(this.socket, greetingRequest);
  }

  /**
   * Disconnect from the server forcibly. Do not issue a QUIT command.
   */
  Pop3Client.prototype.close =
  Pop3Client.prototype.die = function() {
    if (this.state !== 'disconnected') {
      this.state = 'disconnected';
      if (this.socket.readyState !== 'closing' &&
          this.socket.readyState !== 'closed') {
        this.socket.close();
      }
    }
  };

  Pop3Client.prototype.sendRequest = function(command, args, isMultiline) {
    return new Promise((resolve, reject) => {
      var request = new transport.Request(command, args, isMultiline);
      request.then((dataLines) => {
        var statusLine = request.getStatusLine();
        if (statusLine[0] === '+') {
          resolve({
            request: request,
            statusLine: statusLine,
            dataLines: dataLines.map(line => mimefuncs.fromTypedArray(line))
          });
        } else {
          reject({
            request: request,
            statusLine: statusLine
          });
        }
      }, (err) => {
        reject({
          request: request,
          statusLine: '-ERR [synthetic] ' + (err.statusLine || err)
        });
      });
      if (this.socket.readyState !== 'closed') {
        this.requestStream.write(request);
      } else {
        request._respondWithError('closed');
      }
    });
  };


  Pop3Client.prototype.beginRequest = function(command, args, isMultiline) {
    var request = new transport.Request(command, args, isMultiline);
    if (this.socket.readyState !== 'closed') {
      this.requestStream.write(request);
    } else {
      request._respondWithError('closed');
    }
    return request;
  };

  /**
   * If we're trying to use TLS, upgrade now.
   *
   * This is followed by ._thenAuthorize().
   */
  Pop3Client.prototype._maybeUpgradeConnection = function(cb) {
    if (this.options.crypto === 'starttls') {
      this.state = 'starttls';
      this.sendRequest('STLS', [], false)
        .then(() => {
          this.socket.upgradeToSecure();
          cb();
        }, (err) => {
          cb && cb({
            scope: 'connection',
            request: err.request,
            name: 'bad-security',
            message: err.statusLine,
            response: err,
          });
        });
    } else {
      cb();
    }
  };

  /**
   * Set the current state to 'authorization' and attempts to
   * authenticate the user with any available authentication method.
   * We try APOP first if the server supports it, since we can avoid
   * replay attacks and authenticate in one roundtrip. Otherwise, we
   * try SASL AUTH PLAIN, which POP3 servers are (in theory) required
   * to support if they support SASL at all. Lastly, we fall back to
   * plain-old USER/PASS authentication if that's all we have left.
   *
   * Presently, if one authentication method fails for any reason, we
   * simply try the next. We could be smarter and drop out on
   * detecting a bad-user-or-pass error.
   */
  Pop3Client.prototype._thenAuthorize = function(cb) {
    this.state = 'authorization';

    this.authMethod = this.options.authMethods.shift();

    var user = this.options.username;
    var pass = this.options.password;
    var secret;
    switch(this.authMethod) {
    case 'apop':
      var match = /<.*?>/.exec(this._greetingLine || '');
      var apopTimestamp = match && match[0];
      if (!apopTimestamp) {
        // if the server doesn't support APOP, try the next method.
        this._thenAuthorize(cb);
      } else {
        secret = md5(apopTimestamp + pass).toLowerCase();
        this.sendRequest('APOP', [user, secret], false)
          .then(() => {
            cb(); // ready!
          }, (err) => {
            this._greetingLine = null; // try without APOP
            this._thenAuthorize(cb);
          });
      }
      break;
    case 'sasl':
      secret = btoa(user + '\x00' + user + '\x00' + pass);
      this.sendRequest('AUTH', ['PLAIN', secret], false)
        .then(() => {
          cb(); // ready!
        }, (err) => {
          this._thenAuthorize(cb);
        });
      break;
    case 'user-pass':
    default:
      this.sendRequest('USER', [user], false)
        .then(() => {
          this.sendRequest('PASS', [pass], false)
            .then(() => {
              cb();
            }, (err) => {
              cb && cb({
                scope: 'authentication',
                request: null, // No request logging here; may leak password.
                name: 'bad-user-or-pass',
                message: err.statusLine,
                response: err,
              });
            });
        }, (err) => {
          cb && cb({
            scope: 'authentication',
            request: err.request,
            name: 'bad-user-or-pass',
            message: err.statusLine,
            response: err,
          });
        });
      break;
    }
  };

  /*********************************************************************
   * MESSAGE FETCHING
   *
   * POP3 does not support granular partial retrieval; we can only
   * download a given number of _lines_ of the message (including
   * headers). Thus, in order to download snippets of messages (rather
   * than just the entire body), we have to guess at how many lines
   * it'll take to get enough MIME data to be able to parse out a
   * text/plain snippet.
   *
   * For now, we'll try to download a few KB of the message, which
   * should give plenty of data to form a snippet. We're aiming for a
   * sweet spot, because if the message is small enough, we can just
   * download the whole thing and be done.
   */

  /**
   * Issue a QUIT command to the server, persisting any DELE message
   * deletions you've enqueued. This also closes the connection.
   */
  Pop3Client.prototype.quit = function(cb) {
    this.state = 'disconnected';
    this.sendRequest('QUIT', [], false)
      .then(() => {
        this.close();
        cb && cb();
      }, (err) => {
        this.close();
        cb && cb({
          scope: 'mailbox',
          request: err.request,
          name: 'server-problem',
          message: err.statusLine,
          response: err,
        });
      });
  };

  /**
   * Load a mapping of server message numbers to UIDLs, so that we
   * can interact with messages stably across sessions. Additionally,
   * this fetches a LIST of the messages so that we have a list of
   * message sizes in addition to their UIDLs.
   */
  Pop3Client.prototype._loadMessageList = function() {
    // if we've already loaded IDs this session, we don't need to
    // compute them again, because POP3 shows a frozen state of your
    // mailbox until you disconnect.
    if (this._messageList) {
      return Promise.resolve(this._messageList);
    }
    return new Promise((resolve, reject) => {
      // First, get UIDLs for each message. Because POP3 servers process requests
      // serially, the next LIST will not run until after this completes.
      this.sendRequest('UIDL', [], true)
        .then(({ dataLines }) => {
          for (var i = 0; i < dataLines.length; i++) {
            var words = dataLines[i].split(' ');
            var number = words[0];
            var uidl = words[1];
            this.idToUidl[number] = uidl;
            this.uidlToId[uidl] = number;
          }
        }, (err) => {
          reject({
            scope: 'mailbox',
            request: err.request,
            name: 'server-problem',
            message: err.statusLine,
            response: err,
          });
        });

      // Then, get a list of messages so that we can track their size.
      this.sendRequest('LIST', [], true)
        .then(({ dataLines }) => {
          var allMessages = [];
          for (var i = 0; i < dataLines.length; i++) {
            var words = dataLines[i].split(' ');
            var number = words[0];
            var size = parseInt(words[1], 10);
            this.idToSize[number] = size;
            // Push the message onto the front, so that the last line
            // becomes the first message in allMessages. Most POP3 servers
            // seem to return messages in ascending date order, so we want
            // to process the newest messages first. (Tested with Dovecot,
            // Gmail, and AOL.) The resulting list here contains the most
            // recent message first.
            allMessages.unshift({
              uidl: this.idToUidl[number],
              size: size,
              number: number
            });
          }
          this._messageList = allMessages;
          resolve(allMessages);
        }, (err) => {
          reject({
            scope: 'mailbox',
            request: err.request,
            name: 'server-problem',
            message: err.statusLine,
            response: err,
          });
        });
    });
  };

  /**
   * XXX MOOT!  Being migrated into SyncStateHelper and sync_* tasks.
   *
   * Fetch the headers and snippets for all messages. Only retrieves
   * messages for which filterFunc(uidl) returns true.
   *
   * @param {object} opts
   * @param {function(uidl)} opts.filter Only store messages matching filter
   * @param {function(evt)} opts.progress Progress callback
   * @param {int} opts.checkpointInterval Call `checkpoint` every N messages
   * @param {int} opts.maxMessages Download _at most_ this many
   *   messages during this listMessages invocation. If we find that
   *   we would have to download more than this many messages, mark
   *   the rest as "overflow" messages that could be downloaded in a
   *   future sync iteration. (Default is infinite.)
   * @param {function(next)} opts.checkpoint Callback to periodically save state
   * @param {function(err, numSynced, overflowMessages)} cb
   *   Upon completion, returns the following data:
   *
   *   numSynced: The number of messages synced.
   *
   *   overflowMessages: An array of objects with the following structure:
   *
   *       { uidl: "", size: 0 }
   *
   *     Each message in overflowMessages was NOT downloaded. Instead,
   *     you should store those UIDLs for future retrieval as part of
   *     a "Download More Messages" operation.
   */
  Pop3Client.prototype.listMessages = function(opts, cb) {
    var filterFunc = opts.filter;
    var progressCb = opts.progress;
    var checkpointInterval = opts.checkpointInterval || null;
    var maxMessages = opts.maxMessages || Infinity;
    var checkpoint = opts.checkpoint;
    var overflowMessages = [];

    // Get a mapping of number->UIDL.
    this._loadMessageList().then((unfilteredMessages) => {
      // Calculate which messages we would need to download.
      var totalBytes = 0;
      var bytesFetched = 0;
      var messages = [];
      var seenCount = 0;
      // Filter out unwanted messages.
      for (var i = 0; i < unfilteredMessages.length; i++) {
        var msgInfo = unfilteredMessages[i];
        if (!filterFunc || filterFunc(msgInfo.uidl)) {
          if (messages.length < maxMessages) {
            totalBytes += msgInfo.size;
            messages.push(msgInfo);
          } else {
            overflowMessages.push(msgInfo);
          }
        } else {
          seenCount++;
        }
      }

      console.log('POP3: listMessages found ' +
                  messages.length + ' new, ' +
                  overflowMessages.length + ' overflow, and ' +
                  seenCount + ' seen messages. New UIDLs:');

      messages.forEach(function(m) {
        console.log('POP3: ' + m.size + ' bytes: ' + m.uidl);
      });

      var totalMessages = messages.length;
      // If we don't provide a checkpoint interval, just do all
      // messages at once.
      if (!checkpointInterval) {
        checkpointInterval = totalMessages;
      }

      var firstErr = null;
      // Download all of the messages in batches.
      var nextBatch = function() {
        console.log('POP3: Next batch. Messages left: ' + messages.length);
        // If there are no more messages or our connection died, we're done.
        if (!messages.length || this.socket.readyState === 'closed') {
          console.log('POP3: Sync complete. ' +
                      totalMessages + ' messages synced, ' +
                      overflowMessages.length + ' overflow messages.');
          cb && cb(firstErr, totalMessages, overflowMessages);
          return;
        }

        var batch = messages.splice(0, checkpointInterval);
        var latch = allback.latch();

        // Trigger a download for every message in the batch.
        batch.forEach((m, idx) => {
          var messageDone = latch.defer(m.number);
          this.downloadMessage(this.idToUidl[m.number], {
            snippetOnly: true,
          }).then(({ header, body }) => {
            bytesFetched += m.size;
            progressCb && progressCb({
              totalBytes: totalBytes,
              bytesFetched: bytesFetched,
              size: m.size,
              message: { header: header, bodyInfo: body }
            });
            messageDone();
          }, (err) => {
            if (!firstErr) {
              firstErr = err;
            }
            messageDone(err);
          });
        });

        // When all messages in this batch have completed, trigger the
        // next batch to begin download. If `checkpoint` is provided,
        // we'll wait for it to tell us to continue (so that we can
        // save the database periodically or perform other
        // housekeeping during sync).
        latch.then(function(results) {
          // figure out if we actually did work so we actually need to save.
          var anySaved = false;
          for (var num in results) {
            console.log('result', num, results[num]);
            if (!results[num][0]) {
              anySaved = true;
              break;
            }
          }
          if (checkpoint && anySaved) {
            console.log('POP3: Checkpoint.');
            checkpoint(nextBatch);
          } else {
            nextBatch();
          }
        });
      }.bind(this);

      // Kick it off, maestro.
      nextBatch();
    }, (err) => { cb && cb(err); });
  };

  // 1. Obtain the root message header. From here, we have enough data to
  // produce a basic message that we can save to disk.
  //
  // 2. Obtain nested headers and bodies. Each part comes back as a stream.
  //
  // 3. As each stream arrives, store it; update the database as appropriate.

  /**
   * Retrieve a message in its entirety, given a server-centric number.
   *
   * @param {string} uidl
   * @param {object} [handlers]
   * @param {function(bodyInfo) => Promise} handlers.flushBodyInfo
   */
  Pop3Client.prototype.downloadMessage = async function(uidl, handlers) {
    handlers = handlers || {};
    var snippetOnly = handlers.snippetOnly;
    // Ensure we've downloaded UIDLs.
    await this._loadMessageList();
    var number = this.uidlToId[uidl];

    // Begin fetching the message, streaming back MimeNode/BodyStream pairs.
    var request;
    if (snippetOnly) {
      // Based on SNIPPET_SIZE_GOAL, calculate approximately how many
      // lines we'll need to fetch in order to roughly retrieve
      // SNIPPET_SIZE_GOAL bytes.
      var numLines = Math.floor(POP3_SNIPPET_SIZE_GOAL / 80);
      request = this.beginRequest('TOP', [number, numLines], true);
    } else {
      request = this.beginRequest('RETR', [number], true);
    }

    try {
      var ret = await this.parseMessageFromLineStream(
        request.dataLineStream, uidl, this.idToSize[number], handlers);
    } catch(e) {
      console.error('Parsing Error:', e, e.stack);
      throw e;
    }

    return ret;
  };

  // via MimeParser
  function unfoldFormatFlowed(content, delsp) {
    var delSp = /^yes$/i.test(delsp);

    return content.split('\n')
    // remove soft linebreaks
    // soft linebreaks are added after space symbols
    .reduce(function(previousValue, currentValue, index) {
        var body = previousValue;
        if (delSp) {
            // delsp adds spaces to text to be able to fold it
            // these spaces can be removed once the text is unfolded
            body = body.replace(/[ ]+$/, '');
        }
        if (/ $/.test(previousValue) && !/(^|\n)\-\- $/.test(previousValue)) {
            return body + currentValue;
        } else {
            return body + '\n' + currentValue;
        }
    })
    // remove whitespace stuffing
    // http://tools.ietf.org/html/rfc3676#section-4.4
    .replace(/^ /gm, '');
  }

  Pop3Client.prototype.parseMessageFromLineStream =
  async function(lineStream, srvid, totalExpectedSize, handlers) {
    handlers = handlers || {};
    var countingTransform = new ByteCounterTransformStream();
    var mimeReader = lineStream
      .pipeThrough(countingTransform)
      .pipeThrough(new MimeNodeTransformStream())
      .getReader();

    var partBuilder;
    for(;;) {
      // For every MIME header, we'll see the corresponding MimeNode here,
      // along with a Stream that represents the in-progress body download.
      var { value, done } = await mimeReader.read();
      if (!done) {
        var { partNum, headers, bodyStream } = value;

        // The first node is the root node; use it to build a header and body.
        if (!partBuilder) {
          partBuilder = new PartBuilder(headers, {
            srvid: srvid,
            size: totalExpectedSize
          });
        }

        // Go through each bodyRep/attachment/part, deciding what to handle.
        var { type, rep, index } = partBuilder.addNode(partNum, headers);
        // If it's an attachment, flush each chunk to IndexedDB as a blob and
        // read it back, so that the backing store comes from disk rather than
        // memory.
        if (type === 'attachment' || type === 'related') {
          rep.sizeEstimate = 0;

          // XXX broked; need to mesh streaming logic and pre-existing convoy
          // changes.
          rep.file = await mimeStreams.readAttachmentStreamWithChunkFlushing(
            headers.contentType,
            bodyStream,
            async function(file) {
              rep.file = file;
              if (handlers.flushBodyInfo) {
                partBuilder.body =
                  await handlers.flushBodyInfo(partBuilder.body);
              }
              if (type === 'attachment') {
                return partBuilder.body.attachments[index].file;
              } else {
                return partBuilder.body.relatedParts[index].file;
              }
            }
          );
          rep.sizeEstimate = rep.file.size;
        }
        // For now, if it's a body, we just concatenate everything to a string.
        else if (type === 'body') {
          var blobChunks = await mimeStreams.readAllChunks(bodyStream);

          rep.content =
            mimefuncs.charset.decode(
              new FileReaderSync().readAsArrayBuffer(new Blob(blobChunks)),
              headers.charset);

          // XXX: Our previous MIME parser ate '\r\n' and spit out '\n'.
          // We've made a lot of assumptions that lines will be delimited by
          // only '\n' (e.g. in quotechew.js). The right way to do this would
          // be to convert everything else to use '\r\n'; that would require
          // a lot of work to change. The only real downside to this hack is
          // bloating memory doing this transformation:
          rep.content = rep.content.replace(/\r\n/g, '\n');

          // MimeParser used to do this for us; jsmime does not. (We still use
          // MimeParser to parse IMAP/ActiveSync bodies.)
          if (headers.format === 'flowed') {
            rep.content = unfoldFormatFlowed(rep.content, headers.delsp);
          }

          rep.sizeEstimate = rep.content.length;
          rep.amountDownloaded = rep.content.length;
          rep.isDownloaded = true;
        }
        // Some parts we don't do anything with.
        else if (type === 'ignore') {
          // nothing
        }
      } else {
        // We're done downloading everything! Now we must infer a few things
        // if we don't have the whole message.
        var { header, rootHeaders, body } = partBuilder.finalize();

        // in testing:
        if (totalExpectedSize === undefined) {
          totalExpectedSize = countingTransform.totalBytesRead;
        }

        var bytesLeft = totalExpectedSize - countingTransform.totalBytesRead;
        var partiallyDownloaded = bytesLeft > 0;

        // Infer whether or not we have attachments.
        if (partiallyDownloaded &&
            (rootHeaders.getStringHeader('x-ms-has-attach') ||
             rootHeaders.contentType === 'multipart/mixed' ||
             totalExpectedSize > POP3_INFER_ATTACHMENTS_SIZE)) {
          header.hasAttachments = true;
        }

        // If we haven't downloaded the entire message, we need to have
        // some way to tell the UI that we actually haven't downloaded all
        // of the bodyReps yet. We add this fake bodyRep here, indicating
        // that it isn't fully downloaded, so that when the user triggers
        // downloadBodyReps, we actually try to fetch the message. In
        // POP3, we _don't_ know that we have all bodyReps until we've
        // downloaded the whole thing. There could be parts hidden in the
        // data we haven't downloaded yet.
        body.bodyReps.push({
          type: 'fake', // not 'text' nor 'html', so it won't be rendered
          part: 'fake',
          sizeEstimate: 0,
          amountDownloaded: 0,
          isDownloaded: !partiallyDownloaded,
          content: null,
          size: 0,
        });

        // POP3 can't display the completely-downloaded-body until we've
        // downloaded the entire message, including attachments. So
        // unfortunately, no matter how much we've already downloaded, if
        // we haven't downloaded the whole thing, we can't start from the
        // middle.
        header.bytesToDownloadForBodyDisplay =
          (partiallyDownloaded ? totalExpectedSize : 0);

        var bodyRepIdx = imapchew.selectSnippetBodyRep(header, body);

        for (var i = 0; i < body.bodyReps.length; i++) {
          var bodyRep = body.bodyReps[i];
          if (bodyRep.content === null) {
            continue;
          }

          var content = bodyRep.content;
          //bodyRep.size = partSizes[bodyRep.part];
          imapchew.updateMessageWithFetch(
            header,
            body,
            {
              // If bytes is null, imapchew.updateMessageWithFetch knows
              // that we've fetched the entire thing. Passing in [-1, -1] as a
              // range tells imapchew that we're not done downloading it yet.
              bytes: (bodyRep.isDownloaded ? null : [-1, -1]),
              bodyRepIndex: i,
              createSnippet: i === bodyRepIdx,
            },
            {
              bytesFetched: content.length,
              text: content
            });
        }

        return { header, body };
      }
    } // end for
  };

  function setTimeoutFunctions(set, clear) {
    setTimeout = set;
    clearTimeout = clear;
  }

  export {
    Pop3Client,
    setTimeoutFunctions,
  };

