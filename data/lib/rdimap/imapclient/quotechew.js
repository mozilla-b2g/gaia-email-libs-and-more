/**
 * Process message bodies for quoting / signatures.
 *
 * We have two main goals in our processing:
 *
 * 1) Improve display by being able to automatically collapse excessively quoted
 * blocks and large/redundant signature blocks and hide them entirely from snippet
 * generation.
 *
 * 2) Allow us to reply to messages and provide automatically limited quoting.
 * Specifically, we want to provide one message's worth of context when replying
 * to a message.  We also want to avoid messages in a thread indefinitely
 * growing in size because all users keep replying and leaving default quoting
 * intact.
 *
 *
 **/

define(
  [
    'exports'
  ],
  function(
    exports
  ) {

////////////////////////////////////////////////////////////////////////////////
// Content Type Encoding
//
// We encode content type values as integers in an attempt to have the serialized
// form not be super huge and be pretty quick to check without generating garbage
// objects.
//
// The low-order nibble encodes the type for styling purposes; everything above
// that nibble is per-type and may encode integer values or use hot bits to
// indicate type.

/**
 * Actual content of the message written by the user.
 */
const CT_AUTHORED_CONTENT = 0x1;
/**
 * Niceties like greetings/thanking someone/etc.  These are things that we want to
 * show when displaying the message, but that arguably are of lower importance and
 * might want to be elided for snippet purposes, etc.
 */
const CT_AUTHORED_NICETIES = 0x11;
/**
 * The signature of the message author; might contain useful information in it.
 */
const CT_SIGNATURE = 0x2;

/**
 * The line that says "Blah wrote:" that precedes a quote.  It's not part of the
 * user content, but it's also not part of the quote.
 */
const CT_LEADIN_TO_QUOTE = 0x3;

/**
 * A quoted reply; eligible for collapsing.  Depth of quoting will also be
 * encoded in the actual integer value.
 */
const CT_QUOTED_REPLY = 0x14;
/**
 * A quoted forwarded message; we would guess that the user has not previously seen
 * the message and the quote wants to be displayed.
 */
const CT_QUOTED_FORWARD = 0x24;
/**
 * Quoted content that has not been pruned.
 */
const CT_QUOTED_IN_ENTIRETY = 0x40;
/**
 * The quote has been subjected to some level of manual intervention,
 */
const CT_QUOTED_GARDENED = 0x80;

const CT_QUOTE_DEPTH_MASK = 0xff00;

/**
 * Legal-ish boilerplate about how it's only for the recipient, etc. etc.
 * Generally going to be long and boring.
 */
const CT_BOILERPLATE_DISCLAIMER = 0x5;
/**
 * Boilerplate about the message coming from a mailing list, info about the
 * mailing list.
 */
const CT_BOILERPLATE_LIST_INFO = 0x6;
/**
 * Product branding boilerplate that may or may not indicate that the composing
 * device was a mobile device (which is useful).
 */
const CT_BOILERPLATE_PRODUCT = 0x7;
/**
 * Advertising automatically inserted by the mailing list or free e-mailing service,
 * etc.  This is assumed to be boring.
 */
const CT_BOILERPLATE_ADS = 0x8;

const CHARCODE_GT = ('>').charCodeAt(0),
      CHARCODE_SPACE = (' ').charCodeAt(0),
      CHARCODE_NBSP = ('\xa0').charCodeAt(0);

const RE_ORIG_MESAGE_DELIM = /^-{5} Original Message -{5}$/;

const RE_ALL_WS = /^\s+$/;

const RE_SECTION_DELIM = /^[_-]{6,}$/;

const RE_LIST_BOILER = /mailing list$/;

const RE_WROTE_LINE = /wrote/;

/**
 * The maximum number of lines that can be in a boilerplate chunk.  We expect
 * disclaimer boilerplate to be what drives this.
 */
const MAX_BOILERPLATE_LINES = 20;

/**
 * Catch various common well-known product branding lines:
 * - Sent from my iPhone/iPad/mobile device
 * - Sent from my Android ...
 * - Sent from Mobile/mobile device
 */
const RE_PRODUCT_BOILER = /^(?:Sent from (?:Mobile|my (?:iPhone|iPad|mobile device|Android.+)))$/;

const RE_LEGAL_BOILER_START = /^(?:This message|Este mensaje)/;

function indexOfDefault(string, search, startIndex, defVal) {
  var idx = string.indexOf(search, startIndex);
  if (idx === -1)
    return defVal;
  return idx;
}

/**
 * Process the contents of a text body for quoting purposes.
 *
 * Key behaviors:
 *
 * - Whitespace is trimmed at the boundaries of regions.  Our CSS styling will
 *   take care of making sure there is appropriate whitespace.  This is an
 *   intentional normalization that should cover both people who fail to put
 *   whitespace in their messages (jerks) and people who put whitespace in.
 *
 * - Newlines are maintained inside of blocks.
 *
 * - We look backwards for boilerplate blocks once we encounter the first quote
 *   block or the end of the message.  We keep incrementally looking backwards
 *   until we reach something that we don't think is boilerplate.
 */
exports.quoteProcessTextBody = function quoteProcessTextBody(fullBodyText) {
console.log('QUOTETECT:', JSON.stringify(fullBodyText));
  var contentRep = [];
  var line;
  /**
   * Count the number of '>' quoting characters in the line, mutating `line` to
   * not include the quoting characters.  Some clients will place a single space
   * between each '>' at higher depths, and we support that.  But any more spaces
   * than that and we decide we've reached the end of the quote marker.
   */
  function countQuoteDepthAndNormalize() {
    // We know that the first character is a '>' already.
    var count = 1;
    var lastStartOffset = 1, spaceOk = true;

    for (var i = 1; i < line.length; i++) {
      var c = line.charCodeAt(i);
      if (c === CHARCODE_GT) {
        lastStartOffset = ++count;
        spaceOk = true;
      }
      else if (c === CHARCODE_SPACE) {
        if (!spaceOk)
          break;
        lastStartOffset++;
        spaceOk = false;
      }
      else {
        break;
      }
    }
    if (lastStartOffset)
      line = line.substring(lastStartOffset);
    return count;
  }

  /**
   * Scan backwards line-by-line through a chunk of text looking for boilerplate
   * chunks.  We can stop once we determine we're not in boilerplate.
   *
   * - Product blurbs must be the first non-whitespace line seen to be detected;
   *   they do not have to be delimited by an ASCII line.
   *
   * - Legal boilerplate must be delimited by an ASCII line.
   */
  function lookBackwardsForBoilerplate(chunk) {
    var idxLineStart, idxLineEnd, line,
        idxRegionEnd = chunk.length,
        scanLinesLeft = MAX_BOILERPLATE_LINES,
        sawNonWhitespaceLine = false,
        lastContentLine = null,
        sawProduct = false,
        insertAt = contentRep.length;

    function pushBoilerplate(contentType) {
      var boilerChunk = chunk.substring(idxLineStart, idxRegionEnd);
      contentRep.splice(insertAt, 0, contentType, boilerChunk);

      chunk = chunk.substring(0, idxLineStart - 1).trimRight();
      idxRegionEnd = chunk.length;

      sawNonWhitespaceLine = false;
      scanLinesLeft = MAX_BOILERPLATE_LINES;
      lastContentLine = null;
    }

    for (idxLineStart = chunk.lastIndexOf('\n') + 1,
           idxLineEnd = chunk.length;
         idxLineEnd > 0 && scanLinesLeft;
         idxLineEnd = idxLineStart - 1,
           idxLineStart = chunk.lastIndexOf('\n', idxLineEnd - 1) + 1,
           scanLinesLeft--) {
console.log("  back", idxLineStart, idxLineEnd);

      line = chunk.substring(idxLineStart, idxLineEnd);

      // - Skip whitespace lines.
      if (!line.length ||
          (line.length === 1 && line.charCodeAt(0) === CHARCODE_NBSP))
        continue;

      // - Section delimiter; try and classify what lives in this section
      if (RE_SECTION_DELIM.test(line)) {
        if (lastContentLine) {
          // - Look for a legal disclaimer sequentially following the line.
          if (RE_LEGAL_BOILER_START.test(lastContentLine)) {
            pushBoilerplate(CT_BOILERPLATE_DISCLAIMER);
            continue;
          }
          // - Look for mailing list
          if (RE_LIST_BOILER.test(lastContentLine)) {
            pushBoilerplate(CT_BOILERPLATE_LIST_INFO);
            continue;
          }
        }
        // The section was not boilerplate, so thus ends the reign of
        // boilerplate.  Bail.
        return chunk;
      }
      // - A line with content!
      if (!sawNonWhitespaceLine) {
        // - Product boilerplate (must be first/only non-whitespace line)
        if (!sawProduct && RE_PRODUCT_BOILER.test(line)) {
          pushBoilerplate(CT_BOILERPLATE_PRODUCT);
          sawProduct = true;
          continue;
        }
        sawNonWhitespaceLine = true;
      }
      lastContentLine = line;
    }

    return chunk;
  }

  /**
   * Assume that we are in a content region and that all variables are proper.
   */
  function pushContent(considerForBoilerplate) {
    if (idxRegionStart === null)
      return;
console.log("content", idxRegionStart, idxLastNonWhitespaceLineEnd);
    var chunk = fullBodyText.substring(idxRegionStart,
                                       idxLastNonWhitespaceLineEnd);
    contentRep.push(CT_AUTHORED_CONTENT);
    var iChunk = contentRep.push(chunk) - 1;

    if (considerForBoilerplate)
      contentRep[iChunk] = lookBackwardsForBoilerplate(chunk);

    lastNonWhitespaceLine = null;
    idxLastNonWhitespaceLineEnd = null;
    idxPrevLastNonWhitespaceLineEnd = null;
  }

  function pushQuote(newQuoteDepth) {
    // Discard empty lines at the end.  We already skipped adding blank lines, so
    // no need to do the front side.
    while (quoteRunLines.length &&
           !quoteRunLines[quoteRunLines.length - 1]) {
      quoteRunLines.pop();
    }
    contentRep.push((inQuoteDepth << 8) | CT_QUOTED_REPLY);
    contentRep.push(quoteRunLines.join('\n'));
    inQuoteDepth = newQuoteDepth;
    if (inQuoteDepth)
      quoteRunLines = [];
    else
      quoteRunLines = null;

    generatedQuoteBlock = true;
  }

  // == On indices and newlines
  // Our line ends always point at the newline for the line; for the last line
  // in the body, there may be no newline, but that doesn't matter since substring
  // is fine with us asking for more than it has.


  var idxLineStart, idxLineEnd, bodyLength = fullBodyText.length,
      // null means we are looking for a non-whitespace line.
      idxRegionStart = null,
      curRegionType = null,
      lastNonWhitespaceLine = null,
      // The index of the last non-purely whitespace line.
      idxLastNonWhitespaceLineEnd = null,
      // value of idxLastNonWhitespaceLineEnd prior to its current value
      idxPrevLastNonWhitespaceLineEnd = null,
      //
      inQuoteDepth = 0,
      quoteRunLines = null,
      contentType = null,
      generatedQuoteBlock = false;
  for (idxLineStart = 0,
         idxLineEnd = fullBodyText.indexOf('\n', idxLineStart);
       idxLineStart < bodyLength;
       idxLineStart = idxLineEnd + 1,
         idxLineEnd = indexOfDefault(fullBodyText, '\n', idxLineStart,
                                     fullBodyText.length)) {
console.log("forward", idxLineStart, idxLineEnd);
    line = fullBodyText.substring(idxLineStart, idxLineEnd);

    // - Do not process purely whitespace lines.
    // Because our content runs are treated as regions, ignoring whitespace
    // lines simply means that we don't start or end content blocks on blank
    // lines.  Blank lines in the middle of a content block are maintained
    // because our slice will include them.
    if (!line.length ||
        (line.length === 1
         && line.charCodeAt(0) === CHARCODE_NBSP))
      continue;
console.log('  not just WS!', JSON.stringify(line));

    if (line.charCodeAt(0) === CHARCODE_GT) {
      var lineDepth = countQuoteDepthAndNormalize();
      // We are transitioning into a quote state...
      if (!inQuoteDepth) {
        // - Check for a "Blah wrote:" content line
        if (lastNonWhitespaceLine &&
            RE_WROTE_LINE.test(lastNonWhitespaceLine)) {

          idxLastNonWhitespaceLineEnd = idxPrevLastNonWhitespaceLineEnd;
          // Nuke the content region if the lead-in was the start of the region;
          // this can be inferred by there being no prior content line.
          if (idxLastNonWhitespaceLineEnd === null)
            idxRegionStart = null;

          var leadin = lastNonWhitespaceLine;
          pushContent(!generatedQuoteBlock);
          contentRep.push(CT_LEADIN_TO_QUOTE);
          contentRep.push(leadin);
        }
        else {
          pushContent(!generatedQuoteBlock);
        }
        quoteRunLines = [];
        inQuoteDepth = lineDepth;
      }
      // There is a change in quote depth
      else if (lineDepth !== inQuoteDepth) {
        pushQuote(lineDepth);
      }

      // Eat whitespace lines until we get a non-whitespace (quoted) line.
      if (quoteRunLines.length || line.length)
        quoteRunLines.push(line);
    }
    else {
      if (inQuoteDepth) {
        pushQuote(0);
        idxRegionStart = null;
        idxLastNonWhitespaceLineEnd = null;
      }
      if (idxRegionStart === null)
        idxRegionStart = idxLineStart;

      lastNonWhitespaceLine = line;
      idxPrevLastNonWhitespaceLineEnd = idxLastNonWhitespaceLineEnd;
      idxLastNonWhitespaceLineEnd = idxLineEnd;
    }
  }
  if (inQuoteDepth)
    pushQuote(0);
  else
    pushContent(true);

  console.log("::", JSON.stringify(contentRep));
  return contentRep;
};

}); // end define
