/**
 * Message processing logic that deals with message representations at a higher
 * level than just text/plain processing (`quotechew.js`) or text/html
 * (`htmlchew.js`) parsing.  We are particularly concerned with replying to
 * messages and forwarding messages, and use the aforementioned libs to do the
 * gruntwork.
 *
 * For replying and forwarding, we synthesize messages so that there is always
 * a text part that is the area where the user can enter text which may be
 * followed by a read-only editable HTML block.  If replying to a text/plain
 * message, the quoted text is placed in the text area.  If replying to a
 * message with any text/html parts, we generate an HTML block for all parts.
 **/

import logic from 'logic';

import { formatAddresses } from 'shared/util';
import * as $mailchewStrings from './mailchew_strings';
import * as $quotechew from './quotechew';
import * as $htmlchew from './htmlchew';

import { DESIRED_SNIPPET_LENGTH } from '../syncbase';

import { makeBodyPart } from '../db/mail_rep';

const scope = logic.scope('MailChew');

/**
 * Generate the default compose body for a new e-mail
 * @param  {MailSenderIdentity} identity The current composer identity
 * @return {String} The text to be inserted into the body
 */
export function generateBagenerateBaseComposePartsseComposeBody(identity) {
  let textMsg;
  if (identity.signatureEnabled &&
      identity.signature &&
      identity.signature.length > 0) {
    textMsg = '\n\n--\n' + identity.signature;
  } else {
    textMsg = '';
  }

  return makeBodyPartsFromTextAndHTML(textMsg, null);
}


var RE_RE = /^[Rr][Ee]:/;

/**
 * Generate the reply subject for a message given the prior subject.  This is
 * simply prepending "Re: " to the message if it does not already have an
 * "Re:" equivalent.
 *
 * Note, some clients/gateways (ex: I think the google groups web client? at
 * least whatever has a user-agent of G2/1.0) will structure mailing list
 * replies so they look like "[list] Re: blah" rather than the "Re: [list] blah"
 * that Thunderbird would produce.  Thunderbird (and other clients) pretend like
 * that inner "Re:" does not exist, and so do we.
 *
 * We _always_ use the exact string "Re: " when prepending and do not localize.
 * This is done primarily for consistency with Thunderbird, but it also is
 * friendly to other e-mail applications out there.
 *
 * Thunderbird does support recognizing a
 * mail/chrome/messenger-region/region.properties property,
 * "mailnews.localizedRe" for letting locales specify other strings used by
 * clients that do attempt to localize "Re:".  Thunderbird also supports a
 * weird "Re(###):" or "Re[###]:" idiom; see
 * http://mxr.mozilla.org/comm-central/ident?i=NS_MsgStripRE for more details.
 */
export function generateReplySubject(origSubject) {
  var re = 'Re: ';
  if (origSubject) {
    if (RE_RE.test(origSubject)) {
      return origSubject;
    }

    return re + origSubject;
  }
  return re;
}

var RE_FWD = /^[Ff][Ww][Dd]:/;

/**
 * Generate the forward subject for a message given the prior subject.  This is
 * simply prepending "Fwd: " to the message if it does not already have an
 * "Fwd:" equivalent.
 */
export function generateForwardSubject(origSubject) {
  var fwd = 'Fwd: ';
  if (origSubject) {
    if (RE_FWD.test(origSubject)) {
      return origSubject;
    }

    return fwd + origSubject;
  }
  return fwd;
}

/**
 * Create an unquoted message-id header (no arrow braces!).
 */
export function generateMessageIdHeaderValue() {
  // We previously used Date.now() for the first part of the string as part of
  // an intentional anti-collision technique, but at that time we were always
  // generating the id at send time, which meant that there was also no
  // privacy leakage from including a timestamp.  Since we now generate the id
  // when we create the draft, including a date could leak when the user first
  // created the draft and thereby some level of inference about how long they
  // spent on the message, unless we reissue it.  (Which we probably will
  // do anyways on each draft update since we know GMail has somewhat aggressive
  // anti-duplication heuristics and it would be horrible for the drafts to not
  // reliably update.  But why take any risks with privacy?)
  return Math.random().toString(16).substr(2) +
         Math.random().toString(16).substr(1) + '@mozgaia';
}

var l10n_wroteString = '{name} wrote',
    l10n_originalMessageString = 'Original Message';

/*
 * L10n strings for forward headers.  In Thunderbird, these come from
 * mime.properties:
 * http://mxr.mozilla.org/comm-central/source/mail/locales/en-US/chrome/messenger/mime.properties
 *
 * The libmime logic that injects them is mime_insert_normal_headers:
 * http://mxr.mozilla.org/comm-central/source/mailnews/mime/src/mimedrft.cpp#791
 *
 * Our dictionary maps from the lowercased header name to the human-readable
 * string.
 *
 * The front-end tells us the locale-appropriate strings at startup and as
 * needed via a mechanism that eventually calls our `setLocalizedStrings`
 * function.  (See the mailchew-strings module too.)
 */
var l10n_forward_header_labels = {
  subject: 'Subject',
  date: 'Date',
  from: 'From',
  replyTo: 'Reply-To',
  to: 'To',
  cc: 'CC'
};

export function setLocalizedStrings(strings) {
  l10n_wroteString = strings.wrote;
  l10n_originalMessageString = strings.originalMessage;

  l10n_forward_header_labels = strings.forwardHeaderLabels;
}

// Grab the localized strings, if not available, listen for the event that
// sets them.
if ($mailchewStrings.strings) {
  setLocalizedStrings($mailchewStrings.strings);
}
$mailchewStrings.events.on('strings', function(strings) {
  setLocalizedStrings(strings);
});

function makeBodyPartsFromTextAndHTML(textMsg, htmlMsg) {
  let bodyReps = [];

  // - Text part
  bodyReps.push(makeBodyPart({
    type: 'plain',
    part: null,
    sizeEstimate: textMsg.length,
    amountDownloaded: textMsg.length,
    isDownloaded: true,
    _partInfo: {},
    contentBlob: new Blob([JSON.stringify([0x1, textMsg])],
                           { type: 'application/json' })
  }));

  // - HTML Party (maybe)
  if (htmlMsg) {
    bodyReps.push(makeBodyPart({
      type: 'html',
      part: null,
      sizeEstimate: htmlMsg.length,
      amountDownloaded: htmlMsg.length,
      isDownloaded: true,
      _partInfo: {},
      contentBlob: new Blob([htmlMsg], { type: 'text/html' })
    }));
  }

  return bodyReps;
}

/**
 * Generate the reply body representation given info about the message we are
 * replying to.  Right now this generates one or two body reps, but in the
 * future relatedParts and attachments could also end up involved as we start
 * doing a better job of replying to and forwarding HTML content.
 *
 * Note that this is an asynchronous generator because we need to load the
 * content of the blobs.  We also wrap our results into a Blob so they're valid
 * body rep structures.
 *
 * This does not include potentially required work such as propagating embedded
 * attachments or de-sanitizing links/embedded images/external images.
 */
export async function generateReplyParts(reps, authorPair, msgDate, identity,
                                        refGuid) {
  var useName = authorPair.name ? authorPair.name.trim() : authorPair.address;

  // TODO: clean up the l10n manipulation here; this manipulation is okay
  // (except potentially for the colon?), but we want to use the l20n lib or
  // some other normalized helper.
  var textMsg = '\n\n' +
                l10n_wroteString.replace('{name}', useName) + ':\n',
      htmlMsg = null;

  for (let i = 0; i < reps.length; i++) {
    let repType = reps[i].type;
    let repBlob = reps[i].contentBlob;

    let rep;
    if (repType === 'plain') {
      rep = JSON.parse(await repBlob.text());
      var replyText = $quotechew.generateReplyText(rep);
      // If we've gone HTML, this needs to get concatenated onto the HTML.
      if (htmlMsg) {
        htmlMsg += $htmlchew.wrapTextIntoSafeHTMLString(replyText) + '\n';
      }
      // We haven't gone HTML yet, so this can all still be text.
      else {
        textMsg += replyText;
      }
    }
    else if (repType === 'html') {
      rep = await repBlob.text();
      if (!htmlMsg) {
        htmlMsg = '';
        // slice off the trailing newline of textMsg
        if (textMsg.slice(-1) === '\n') {
          textMsg = textMsg.slice(0, -1);
        }
      }
      // rep has already been sanitized and therefore all HTML tags are balanced
      // and so there should be no rude surprises from this simplistic looking
      // HTML creation.  The message-id of the message never got sanitized,
      // however, so it needs to be escaped.  Also, in some cases (Activesync),
      // we won't have the message-id so we can't cite it.
      htmlMsg += '<blockquote ';
      if (refGuid) {
        htmlMsg += 'cite="mid:' + $htmlchew.escapeAttrValue(refGuid) + '" ';
      }
      htmlMsg += 'type="cite">' + rep + '</blockquote>';
    }
  }

  // Thunderbird's default is to put the signature after the quote, so us too.
  // (It also has complete control over all of this, but not us too.)
  if (identity.signature && identity.signatureEnabled) {
    // Thunderbird wraps its signature in a:
    // <pre class="moz-signature" cols="72"> construct and so we do too.
    if (htmlMsg) {
      htmlMsg += $htmlchew.wrapTextIntoSafeHTMLString(
                   identity.signature, 'pre', false,
                   ['class', 'moz-signature', 'cols', '72']);
    } else {
      textMsg += '\n\n-- \n' + identity.signature;
    }
  }

  return makeBodyPartsFromTextAndHTML(textMsg, htmlMsg);
}

/**
 * Generate the body parts of an inline forward message.
 *
 * XXX the l10n string building here screws up when RTL enters the picture.
 * See https://bugzilla.mozilla.org/show_bug.cgi?id=1177350
 */
export async function generateForwardParts(sourceMessage, identity) {
  var textMsg = '\n\n', htmlMsg = null;

  if (identity.signature && identity.signatureEnabled) {
    textMsg += '-- \n' + identity.signature + '\n\n';
  }
  textMsg += '-------- ' + l10n_originalMessageString + ' --------\n';
  // XXX l10n! l10n! l10n!

  // Add the headers in the same order libmime adds them in
  // mime_insert_normal_headers so that any automated attempt to re-derive
  // the headers has a little bit of a chance (since the strings are
  // localized.)

  // : subject
  textMsg += l10n_forward_header_labels['subject'] + ': ' +
               sourceMessage.subject + '\n';

  // We do not track or remotely care about the 'resent' headers
  // : resent-comments
  // : resent-date
  // : resent-from
  // : resent-to
  // : resent-cc
  // : date
  textMsg += l10n_forward_header_labels['date'] + ': ' +
    new Date(sourceMessage.date) + '\n';
  // : from
  textMsg += l10n_forward_header_labels['from'] + ': ' +
               formatAddresses([sourceMessage.author]) + '\n';
  // : reply-to
  if (sourceMessage.replyTo) {
    textMsg += l10n_forward_header_labels['replyTo'] + ': ' +
                 formatAddresses([sourceMessage.replyTo]) + '\n';
  }
  // : organization
  // : to
  if (sourceMessage.to && sourceMessage.to.length) {
    textMsg += l10n_forward_header_labels['to'] + ': ' +
                 formatAddresses(sourceMessage.to) + '\n';
  }
  // : cc
  if (sourceMessage.cc && sourceMessage.cc.length) {
    textMsg += l10n_forward_header_labels['cc'] + ': ' +
                 formatAddresses(sourceMessage.cc) + '\n';
  }
  // (bcc should never be forwarded)
  // : newsgroups
  // : followup-to
  // : references (only for newsgroups)

  textMsg += '\n';

  let reps = sourceMessage.bodyReps;
  for (let i = 0; i < reps.length; i++) {
    let repType = reps[i].type;
    let repBlob = reps[i].contentBlob;

    let rep;
    if (repType === 'plain') {
      rep = JSON.parse(await repBlob.text());
      let forwardText = $quotechew.generateForwardBodyText(rep);
      // If we've gone HTML, this needs to get concatenated onto the HTML.
      if (htmlMsg) {
        htmlMsg += $htmlchew.wrapTextIntoSafeHTMLString(forwardText) + '\n';
      }
      // We haven't gone HTML yet, so this can all still be text.
      else {
        textMsg += forwardText;
      }
    } else if (repType === 'html') {
      rep = await repBlob.text();
      if (!htmlMsg) {
        htmlMsg = '';
        // slice off the trailing newline of textMsg
        if (textMsg.slice(-1) === '\n') {
          textMsg = textMsg.slice(0, -1);
        }
      }
      htmlMsg += rep;
    }
  }

  return makeBodyPartsFromTextAndHTML(textMsg, htmlMsg);
}

var HTML_WRAP_TOP =
  '<html><body><body bgcolor="#FFFFFF" text="#000000">';
var HTML_WRAP_BOTTOM =
  '</body></html>';

/**
 * Combine the user's plaintext composition with the read-only HTML we provided
 * them into a final HTML representation.
 */
export function mergeUserTextWithHTML(text, html) {
  return HTML_WRAP_TOP +
         $htmlchew.wrapTextIntoSafeHTMLString(text, 'div') +
         html +
         HTML_WRAP_BOTTOM;
}

/**
 * Generate the snippet and parsed body from the message body's content.  This
 * is currently a synchronous process that can take a while.
 *
 * TODO: Consider making async and (much further out) even farming this out to
 * sub-workers.  This may be addressed by the conversion to a streaming
 * implementation.
 *
 * @param {String} content
 *   The decoded contents of the body.  (This means both transport encoding and
 *   the character set encoding have been decoded.)  In the future this may
 *   become a stream.
 * @param {'plain'|'html'} type
 *   The body type, so we know what to do.
 * @param {Boolean} isDownloaded
 *   Has this body part been fully downloaded?  We only try and create the final
 *   body payload if it's been fully downloaded.  (Otherwise, we're limited to
 *   generating a snippet.)
 * @param {Boolean} generateSnippet
 *   Should we try and generate a snippet from however much content we have
 *   here.
 * @return {{ contentBlob, snippet, authoredBodySize }}
 */
export function processMessageContent(
    content, type, isDownloaded, generateSnippet) {
  // Strip any trailing newline.
  if (content.slice(-1) === '\n') {
    content = content.slice(0, -1);
  }

  let parsedContent, contentBlob, snippet;
  let authoredBodySize = 0;
  switch (type) {
    case 'plain':
      try {
        parsedContent = $quotechew.quoteProcessTextBody(content);
        authoredBodySize = $quotechew.estimateAuthoredBodySize(parsedContent);
      }
      catch (ex) {
        logic(scope, 'textChewError', { ex: ex });
        // An empty content rep is better than nothing.
        parsedContent = [];
      }

      if (generateSnippet) {
        try {
          snippet = $quotechew.generateSnippet(
            parsedContent, DESIRED_SNIPPET_LENGTH
          );
        }
        catch (ex) {
          logic(scope, 'textSnippetError', { ex: ex });
          snippet = '';
        }
      }
      contentBlob = new Blob([JSON.stringify(parsedContent)],
                             { type: 'application/json' });
      break;
    case 'html':
      if (generateSnippet) {
        try {
          snippet = $htmlchew.generateSnippet(content);
        }
        catch (ex) {
          logic(scope, 'htmlSnippetError', { ex: ex });
          snippet = '';
        }
      }
      if (isDownloaded) {
        try {
          parsedContent = $htmlchew.sanitizeAndNormalizeHtml(content);
          // TODO: Should we use a MIME type to convey this is sanitized HTML?
          // (Possibly also including our sanitizer version as a parameter?)
          contentBlob = new Blob([parsedContent], { type: 'text/html' });
          // bleach.js explicitly normalizes whitespace as part of its chars()
          // method, although
          authoredBodySize =
            $htmlchew.generateSearchableTextVersion(
              parsedContent, /* include quotes */ false).length;
        }
        catch (ex) {
          logic(scope, 'htmlParseError', { ex: ex });
          parsedContent = '';
        }
      }
      break;

    default: {
      throw new Error('unpossible!');
    }
  }

  return { contentBlob, snippet, authoredBodySize };
}

/**
 * Given an attribute data structure, encode it into JSON and wrap it in a Blob
 * so that it can be treated as a body part.
 *
 * The object is expected to have the following keys and values:
 * - schema: 'phabricator' for now, but this could include 'bugzilla' in the
 *   future.
 * - attrs: An array of objects where each object has the following keys/values:
 *   - name: The name of the attribute.
 *
 */
export function processAttributeContent(attrData) {
  const contentBlob = new Blob([JSON.stringify(attrData)],
                               { type: 'application/json' });
  return {
    contentBlob,
    snippet: '',
    authoredBodySize: contentBlob.size,
  };
}
