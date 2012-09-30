/**
 * Searchfilters provide for local searching by checking each message against
 * one or more tests.  This is similar to Thunderbird's non-global search
 * mechanism.  Although searching in this fashion could be posed as a
 * decorated slice, the point of local search is fast local search, so we
 * don't want to use real synchronized slices.  Instead, we interact directly
 * with a `FolderStorage` to retrieve known headers in an iterative fashion.  We
 * expose this data as a slice and therefore are capable of listening for
 * changes from the server.  We do end up in a possible situation where we have
 * stale local information that we display to the user, but presumably that's
 * an okay thing.
 *
 * The main fancy/unusual thing we do is that all search predicates contribute
 * to a match representation that allows us to know which predicates in an 'or'
 * configuration actually fired and can provide us with the relevant snippets.
 * In order to be a little bit future proof, wherever we provide a matching
 * snippet, we actually provide an object of the following type.  (We could
 * provide a list of the objects, but the reality is that our UI right now
 * doesn't have the space to display more than one match per filter, so it
 * would just complicate things and generate bloat to do more work than
 * providing one match, especially because we provide a boolean match, not a
 * weighted score.
 *
 * @typedef[FilterMatchItem @dict[
 *   @key[text String]{
 *     The string we think is appropriate for display purposes.  For short
 *     things, this might be the entire strings.  For longer things like a
 *     message subject or the message body, this will be a snippet.
 *   }
 *   @key[offset Number]{
 *     If this is a snippet, the offset of the `text` within the greater whole,
 *     which may be zero.  In the event this is not a snippet, the value will
 *     be zero, but you can't use that to disambiguate; use the length of the
 *     `text` for that.
 *   }
 *   @key[matchRuns @listof[@dict[
 *     @key[start]{
 *       An offset relative to the snippet provided in `text` that identifies
 *       the index of the first JS character deemed to be matching.  If you
 *       want to generate highlights from the raw body, you need to add this
 *       offset to the offset of the `FilterMatchItem`.
 *     }
 *     @key[length]{
 *       The length in JS characters of what we deem to be the match.  In the
 *       even there is some horrible multi-JS-character stuff, assume we are
 *       doing the right thing.  If we are not, patch us, not your code.
 *     }
 *   ]]]{
 *     A list of the offsets within the snippet where matches occurred.  We
 *     do this so that in the future if we support any type of stemming or the
 *     like, the front-end doesn't find itself needing to duplicate the logic.
 *     We provide offsets and lengths rather than pre-splitting the strings so
 *     that a complicated UI could merge search results from searches for
 *     different phrases without having to do a ton of reverse engineering.
 *   }
 *   @key[path #:optional Array]{
 *     Identifies the piece in an aggregate where the match occurred by
 *     providing a traversal path to get to the origin of the string.  For
 *     example, if the display name of the 3rd recipient, the path would be
 *     [2 'name'].  If the e-mail address matched, the path would be
 *     [2 'address'].
 *
 *     This is intended to allow the match information to allow the integration
 *     of the matched data in their context.  For example, the recipients list
 *     in the message reader could be re-ordered so that matching addresses
 *     show up first (especially if some are elided), and are not duplicated in
 *     their original position in the list.
 *   }
 * ]
 *
 * We implement filters for the following:
 * - Author
 * - Recipients
 * - Subject
 * - Body, allows ignoring quoted bits
 **/

define(
  [
    'rdcommon/log',
    './syncbase',
    './date',
    'module',
    'exports'
  ],
  function(
    $log,
    $syncbase,
    $date,
    $module,
    exports
  ) {

/**
 * Match a single phrase against the author's display name or e-mail address.
 * Match results are stored in the 'author' attribute of the match object as a
 * `FilterMatchItem`.
 *
 * We will favor matches on the display name over the e-mail address.
 */
function AuthorFilter(phrase) {
  this.phrase = phrase;
}
exports.AuthorFilter = AuthorFilter;
AuthorFilter.prototype = {
  needsBody: false,

  testMessage: function(header, body, match) {
    var author = header.author, phrase = this.phrase, idx;
    if (author.name && (idx = author.name.indexOf(phrase)) !== -1) {
      match.author = {
        text: author.name,
        offset: 0,
        matchRuns: [{ start: idx, length: phrase.length }],
        path: null,
      };
      return true;
    }
    if (author.address && (idx = author.address.indexOf(phrase)) !== -1) {
      match.author = {
        text: author.address,
        offset: 0,
        matchRuns: [{ start: idx, length: phrase.length }],
        path: null,
      };
      return true;
    }
    match.author = null;
    return false;
  },
};

/**
 * Checks any combination of the recipients lists.  Match results are stored
 * as a list of `FilterMatchItem` instances in the 'recipients' attribute with
 * 'to' matches before 'cc' matches before 'bcc' matches.
 *
 * We will stop trying to match after the configured number of matches.  If your
 * UI doesn't have the room for a lot of matches, just pass 1.
 *
 * For a given recipient, if both the display name and e-mail address both
 * match, we will still only report the display name.
 */
function RecipientFilter(phrase, stopAfterNMatches,
                         checkTo, checkCc, checkBcc) {
  this.phrase = phrase;
  this.stopAfter = stopAfterNMatches;
  this.checkTo = checkTo;
  this.checkCc = checkCc;
  this.checkBcc = checkBcc;
}
exports.RecipientFilter = RecipientFilter;
RecipientFilter.prototype = {
  needsBody: true,

  testMessage: function(header, body, match) {
    const phrase = this.phrase, stopAfter = this.stopAfter;
    var matches = [];
    function checkRecipList(list) {
      var idx;
      for (var i = 0; i < list.length; i++) {
        var recip = list[i];
        if (recip.name && (idx = recip.name.indexOf(phrase)) !== -1) {
          matches.push({
            text: recip.name,
            offset: 0,
            matchRuns: [{ start: idx, length: phrase.length }],
            path: null,
          });
          if (matches.length < stopAfter)
            continue;
          return;
        }
        if (recip.address && (idx = recip.address.indexOf(phrase)) !== -1) {
          matches.push({
            text: recip.address,
            offset: 0,
            matchRuns: [{ start: idx, length: phrase.length }],
            path: null,
          });
          if (matches.length >= stopAfter)
            return;
        }
      }
    }

    if (this.checkTo && body.to)
      checkRecipList(body.to);
    if (this.checkCc && body.cc && matches.length < stopAfter)
      checkRecipList(body.cc);
    if (this.checkBcc && body.bcc && matches.length < stopAfter)
      checkRecipList(body.bcc);

    if (matches.length) {
      match.recipients = matches;
      return true;
    }
    else {
      match.recipients = null;
      return false;
    }
  },

};

/**
 * Assists in generating a `FilterMatchItem` for a substring that is part of a
 * much longer string where we expect we need to reduce things down to a
 * snippet.
 *
 * Context generating is whitespace-aware and tries to avoid leaving partial
 * words.  In the event our truncation would leave us without any context
 * whatsoever, we will leave partial words.  This is also important for us not
 * being rude to CJK languages (although the number used for contextBefore may
 * be too high for CJK, we may want to have them 'cost' more.)
 *
 * We don't pursue any whitespace normalization here because we want our offsets
 * to line up properly with the real data, but also because we can depend on
 * HTML to help us out and normalize everything anyways.
 */
function snippetMatchHelper(str, start, length, contextBefore, contextAfter,
                            path) {
  var offset = str.lastIndexOf(' ', start - 1);
  if (offset < start - contextBefore)
    offset = start - contextBefore;
  var endIdx = str.indexOf(' ', start + length);
  if (endIdx === -1 || endIdx > start + length + contextAfter)
    endIdx = start + length + contextAfter;
  var snippet = str.substring(offset, endIdx);

  return {
    text: snippet,
    offset: offset,
    matchRuns: [{ start: start - offset, length: length }],
    path: path
  };
}

/**
 * Searches the subject for a phrase.  Provides snippeting functionality in case
 * of non-trivial subject lengths.   Multiple matches are supported, but
 * subsequent matches will never overlap with previous strings.  (So if you
 * search for 'bob', and the subject is 'bobobob', you will get 2 matches, not
 * 3.)
 *
 * For details on snippet generation, see `snippetMatchHelper`.
 */
function SubjectFilter(phrase, stopAfterNMatches, contextBefore, contextAfter) {
  this.phrase = phrase;
  this.stopAfter = stopAfterNMatches;
  this.contextBefore = contextBefore;
  this.contextAfter = contextAfter;
}
exports.Subjectfilter = SubjectFilter;
SubjectFilter.prototype = {
  needsBody: false,
  testMessage: function(header, body, match) {
    const phrase = this.phrase, phrlen = phrase.length,
          subject = header.subject, slen = subject.length,
          stopAfter = this.stopAfter,
          contextBefore = this.contextBefore, contextAfter = this.contextAfter,
          matches = [];
    var idx = 0;

    while (idx < slen && matches.length < stopAfter) {
      idx = subject.indexOf(phrase, idx);
      if (idx === -1)
        break;

      matches.push(snippetMatchHelper(subject, idx, phrlen,
                                      contextBefore, contextAfter, null));
      idx += phrlen;
    }

    if (matches.length) {
      match.subject = matches;
      return true;
    }
    else {
      match.subject = null;
      return false;
    }
  },
};

// stable value from quotechew.js; full export regime not currently required.
const CT_AUTHORED_CONTENT = 0x1;
// HTML DOM constants
const ELEMENT_NODE = 1, TEXT_NODE = 3;

/**
 * Searches the body of the message, it can ignore quoted stuff or not.
 * Provides snippeting functionality.  Multiple matches are supported, but
 * subsequent matches will never overlap with previous strings.  (So if you
 * search for 'bob', and the subject is 'bobobob', you will get 2 matches, not
 * 3.)
 *
 * For details on snippet generation, see `snippetMatchHelper`.
 */
function BodyFilter(phrase, matchQuotes, stopAfterNMatches,
                    contextBefore, contextAfter) {
  this.phrase = phrase;
  this.stopAfter = stopAfterNMatches;
  this.contextBefore = contextBefore;
  this.contextAfter = contextAfter;
  this.matchQuotes = matchQuotes;
}
exports.BodyFilter = BodyFilter;
BodyFilter.prototype = {
  needsBody: true,
  testMessage: function(header, body, match) {
    const phrase = this.phrase, phrlen = phrase.length,
          subject = header.subject, slen = subject.length,
          stopAfter = this.stopAfter,
          contextBefore = this.contextBefore, contextAfter = this.contextAfter,
          matches = [],
          matchQuotes = this.matchQuotes;
    var idx;

    for (var iBodyRep = 0; iBodyRep < body.bodyReps.length; iBodyRep += 2) {
      var bodyType = body.bodyReps[iBodyRep],
          bodyRep = body.bodyReps[iBodyRep + 1];

      if (bodyType === 'plain') {
        for (var iRep = 0; iRep < bodyRep.length && matches.length < stopAfter;
             iRep += 2) {
          var etype = bodyRep[iRep]&0xf, block = bodyRep[iRep + 1],
              repPath = null;

          // Ignore blocks that are not message-author authored unless we are
          // told to match quotes.
          if (!matchQuotes && etype !== CT_AUTHORED_CONTENT)
            continue;

          for (idx = 0; idx < block.length && matches.length < stopAfter;) {
            idx = block.indexOf(phrase, idx);
            if (idx === -1)
              break;
            if (repPath === null)
              repPath = [iBodyRep, iRep];
            matches.push(snippetMatchHelper(subject, idx, phrlen,
                                            contextBefore, contextAfter,
                                            repPath));
            idx += phrlen;
          }
        }
      }
      else if (bodyType === 'html') {
        // NB: this code is derived from htmlchew.js' generateSnippet
        // functionality.

        // - convert the HMTL into a DOM tree
        // We don't want our indexOf to run afoul of presentation logic.
        var htmlPath = [iBodyRep, 0];
        var htmlDoc = document.implementation.createHTMLDocument(''),
            rootNode = htmlDoc.createElement('div');
        rootNode.innerHTML = bodyRep;

        var node = rootNode.firstChild, done = false;
        while (!done) {
          if (node.nodeType === ELEMENT_NODE) {
            switch (node.tagName.toLowerCase()) {
              // - Things that can't contain useful text.
              // The style does not belong in the snippet!
              case 'style':
                break;

              case 'blockquote':
                // fall-through if matchQuotes
                if (!matchQuotes)
                  break;
              default:
                if (node.firstChild) {
                  node = node.firstChild;
                  htmlPath.push(0);
                  continue;
                }
                break;
            }
          }
          else if (node.nodeType === TEXT_NODE) {
            // XXX the snippet generator normalizes whitespace here to avoid
            // being overwhelmed by ridiculous whitespace.  This is not quite
            // as much a problem for us, but it would be useful if the
            // sanitizer layer normalized whitespace so neither of us has to
            // worry about it.
            var nodeText = node.data;

            idx = nodeText.indexOf(phrase);
            if (idx !== -1) {
              matches.push(
                snippetMatchHelper(nodeText, idx, phrlen,
                                   contextBefore, contextAfter,
                                   htmlPath.concat()));
              if (matches.length >= stopAfter)
                break;
            }
          }

          while (!node.nextSibling) {
            node = node.parentNode;
            htmlPath.pop();
            if (node === rootNode) {
              done = true;
              break;
            }
          }
          if (!done) {
            node = node.nextSibling;
            htmlPath[htmlPath.length - 1]++;
          }
        }
      }
    }

    if (matches.length) {
      match.subject = matches;
      return true;
    }
    else {
      match.subject = null;
      return false;
    }
  },
};

/**
 * Filters messages using the 'OR' of all specified filters.  We don't need
 * 'AND' right now, but we are not opposed to its inclusion.
 */
function MessageFilterer(filters) {
  this.filters = filters;
  this.bodiesNeeded = false;

  for (var i = 0; i < filters.length; i++) {
    var filter = filters[i];
    if (filter.needsBody)
      this.bodiesNeeded = true;
  }
}
exports.MessageFilterer = MessageFilterer;
MessageFilterer.prototype = {
  /**
   * Check if the message matches the filter.  If it does not, false is
   * returned.  If it does match, a match object is returned whose attributes
   * are defined by the filterers in use.
   */
  testMessage: function(header, body) {
    var matched = false, matchObj = {};
    const filters = this.filters;
    for (var i = 0; i < filters.length; i++) {
      var filter = filters[i];
      if (filter.testMessage(header, body))
        matched = true;
    }
    if (matched)
      return matchObj;
    else
      return false;
  },
};

const CONTEXT_CHARS_BEFORE = 16;
const CONTEXT_CHARS_AFTER = 40;

/**
 *
 */
function SearchSlice(bridgeHandle, storage, phrase, whatToSearch, _parentLog) {
  this._bridgeHandle = bridgeHandle;
  bridgeHandle.__listener = this;
  // this mechanism never allows triggering synchronization.
  bridgeHandle.userCanGrowDownwards = false;

  this._storage = storage;
  this._LOG = LOGFAB.SearchSlice(this, _parentLog, bridgeHandle._handle);

  // These correspond to the range of headers that we have searched to generate
  // the current set of matched headers.  Our matches will always be fully
  // contained by this range.
  this.searchStartTS = null;
  this.searchStartUID = null;
  this.searchEndTS = null;
  this.searchEndUID = null;

  var filters = [];
  if (whatToSearch.author)
    filters.push(new AuthorFilter(phrase));
  if (whatToSearch.recipients)
    filters.push(new RecipientFilter(phrase, 1, true, true, true));
  if (whatToSearch.subject)
    filters.push(new SubjectFilter(
                   phrase, 1, CONTEXT_CHARS_BEFORE, CONTEXT_CHARS_AFTER));
  if (whatToSearch.body)
    filters.push(new BodyFilter(
                   phrase, whatToSearch.body === 'yes-quotes',
                   1, CONTEXT_CHARS_BEFORE, CONTEXT_CHARS_AFTER));

  this.filterer = new MessageFilterer(filters);

  this._bound_gotOlderMessages = this._gotMessages.bind(this, 1);
  this._bound_gotNewerMessages = this._gotMessages.bind(this, -1);

  this.headers = [];
  this.desiredHeaders = $syncbase.INITIAL_FILL_SIZE;
  // Fetch as many headers as we want in our results; we probably will have
  // less than a 100% hit-rate, but there isn't much savings from getting the
  // extra headers now, so punt on those.
  this.getMessagesInImapDateRange(0, $date.FUTURE(),
                                  this.desiredHeaders,
                                  this.desiredHeaders);
}
exports.SearchSlice = SearchSlice;
SearchSlice.prototype = {
  set atTop(val) {
    this._bridgeHandle.atTop = val;
  },
  set atBottom(val) {
    this._bridgeHandle.atBottom = val;
  },

  _getMoreMessages: function(dir, howMany) {
  },

  _gotMessages: function(dir, headers, moreMessagesComing) {
    // update the range of what we have seen and searched
    if (dir === -1) {
      this.searchEndTS = headers[0].date;
      this.searchEndUID = headers[0].id;
    }
    else {
      var lastHeader = headers[headers.length - 1];
      this.searchStartTS = lastHeader.date;
      this.searchStartUID = lastHeader.id;
    }
  },

  refresh: function() {
  },

  reqNoteRanges: function(firstIndex, firstSuid, lastIndex, lastSuid) {
    // when shrinking our range, we could try and be clever and use the values
    // of the first thing we are updating to adjust our range, but it's safest/
    // easiest right now to just use what we are left with.

  },

  reqGrow: function(dirMagnitude, userRequestsGrowth) {
    if (dirMagnitude === -1)
      dirMagnitude = -$syncbase.INITIAL_FILL_SIZE;
    else if (dirMagnitude === 1)
      dirMagnitude = $syncbase.INITIAL_FILL_SIZE;
    this._storage.growSlice(this, dirMagnitude, userRequestsGrowth);
  },

  die: function() {
    this._bridgeHandle = null;
    this._LOG.__die();
  },
};

var LOGFAB = exports.LOGFAB = $log.register($module, {
  SearchSlice: {
    type: $log.QUERY,
    events: {
    },
    TEST_ONLY_events: {
    },
  },
}); // end LOGFAB


}); // end define
