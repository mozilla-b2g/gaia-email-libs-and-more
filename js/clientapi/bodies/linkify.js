// Common idioms:
//
// Lead-in (URL and email):
// (                     Capture because we need to know if there was a lead-in
//                       character so we can include it as part of the text
//                       preceding the match.  We lack look-behind matching.
//  ^|                   The URL/email can start at the beginninf of the string.
//  [\s(,;]              Or whitespace or some punctuation that does not imply
//                       a context which would preclude a URL.
// )
//
// We do not need a trailing look-ahead because our regex's will terminate
// because they run out of characters they can eat.

// What we do not attempt to have the regexp do:
// - Avoid trailing '.' and ')' characters.  We let our greedy match absorb
//   these, but have a separate regex for extra characters to leave off at the
//   end.
//
// The Regex (apart from lead-in/lead-out):
// (                     Begin capture of the URL
//  (?:                  (potential detect beginnings)
//   https?:\/\/|        Start with "http" or "https"
//   www\d{0,3}[.][a-z0-9.\-]{2,249}|
//                      Start with "www", up to 3 numbers, then "." then
//                       something that looks domain-namey.  We differ from the
//                       next case in that we do not constrain the top-level
//                       domain as tightly and do not require a trailing path
//                       indicator of "/".  This is IDN root compatible.
//   [a-z0-9.\-]{2,250}[.][a-z]{2,4}\/
//                       Detect a non-www domain, but requiring a trailing "/"
//                       to indicate a path.  This only detects IDN domains
//                       with a non-IDN root.  This is reasonable in cases where
//                       there is no explicit http/https start us out, but
//                       unreasonable where there is.  Our real fix is the bug
//                       to port the Thunderbird/gecko linkification logic.
//
//                       Domain names can be up to 253 characters long, and are
//                       limited to a-zA-Z0-9 and '-'.  The roots don't have
//                       hyphens unless they are IDN roots.  Root zones can be
//                       found here: http://www.iana.org/domains/root/db
//  )
//  [-\w.!~*'();,/?:@&=+$#%]*
//                       path onwards. We allow the set of characters that
//                       encodeURI does not escape plus the result of escaping
//                       (so also '%')
// )
var RE_URL =
  /(^|[\s(,;])((?:https?:\/\/|www\d{0,3}[.][-a-z0-9.]{2,249}|[-a-z0-9.]{2,250}[.][a-z]{2,4}\/)[-\w.!~*'();,/?:@&=+$#%]*)/im;
// Set of terminators that are likely to have been part of the context rather
// than part of the URL and so should be uneaten.  This is the same as our
// mirror lead-in set (so '(', ',', ';') plus question end-ing punctuation and
// the potential permutations with parentheses (english-specific)
var RE_UNEAT_LAST_URL_CHARS = /(?:[),;.!?]|[.!?]\)|\)[.!?])$/;
// Don't require the trailing slashes here for pre-pending purposes, although
// our above regex currently requires them.
var RE_HTTP = /^https?:/i;
// Note: the [^\s] is fairly international friendly, but might be too friendly.
//
// Note: We've added support for IDN domains in the e-mail regexp.  We would
// expect optimal presentation of IDN-based e-mail addresses to be using HTML
// mails with an 'a' tag so that the human-readable address is present/visible,
// but we can't be sure of that.
//
// Brief analysis:
//   [a-z0-9.\-]{2,250}[.][a-z0-9\-]{2,32}
//                       Domain portion.  We have looser constraints on the
//                       root in terms of size since we already have the '@'
//                       giving us a high probability of an e-mail address.
//                       Otherwise we use the same base regexp from our URL
//                       logic.
var RE_MAIL =
  /(^|[\s(,;<>])([^(,;<>@\s]+@[-a-z0-9.]{2,250}[.][-a-z0-9]{2,32})/im;
var RE_MAILTO = /^mailto:/i;

/**
 * Linkify the given plaintext, producing an Array of HTML nodes as a result.
 */
export function linkifyPlain(body, doc) {
  var nodes = [];
  var contentStart;
  for (;;) {
    var url = RE_URL.exec(body);
    var email = RE_MAIL.exec(body);
    var link, text;
    // Pick the regexp with the earlier content; index will always be zero.
    if (url &&
        (!email || url.index < email.index)) {
      contentStart = url.index + url[1].length;
      if (contentStart > 0) {
        nodes.push(doc.createTextNode(body.substring(0, contentStart)));
      }

      // There are some final characters for a URL that are much more likely
      // to have been part of the enclosing text rather than the end of the
      // URL.
      var useUrl = url[2];
      var uneat = RE_UNEAT_LAST_URL_CHARS.exec(useUrl);
      if (uneat) {
        useUrl = useUrl.substring(0, uneat.index);
      }

      link = doc.createElement('a');
      link.className = 'moz-external-link';
      // the browser app needs us to put a protocol on the front
      if (RE_HTTP.test(url[2])) {
        link.setAttribute('ext-href', useUrl);
      } else {
        link.setAttribute('ext-href', 'http://' + useUrl);
      }
      text = doc.createTextNode(useUrl);
      link.appendChild(text);
      nodes.push(link);

      body = body.substring(url.index + url[1].length + useUrl.length);
    }
    else if (email) {
      contentStart = email.index + email[1].length;
      if (contentStart > 0) {
        nodes.push(doc.createTextNode(body.substring(0, contentStart)));
      }

      link = doc.createElement('a');
      link.className = 'moz-external-link';
      if (RE_MAILTO.test(email[2])) {
        link.setAttribute('ext-href', email[2]);
      } else {
        link.setAttribute('ext-href', 'mailto:' + email[2]);
      }
      text = doc.createTextNode(email[2]);
      link.appendChild(text);
      nodes.push(link);

      body = body.substring(email.index + email[0].length);
    }
    else {
      break;
    }
  }

  if (body.length > 0) {
    nodes.push(doc.createTextNode(body));
  }

  return nodes;
}

/**
 * Process the document of an HTML iframe to linkify the text portions of the
 * HTML document.  'A' tags and their descendants are not linkified, nor
 * are the attributes of HTML nodes.
 */
export function linkifyHTML (doc) {
  function linkElem(elem) {
    var children = elem.childNodes;
    for (var i in children) {
      var sub = children[i];
      if (sub.nodeName === '#text') {
        var nodes = linkifyPlain(sub.nodeValue, doc);

        elem.replaceChild(nodes[nodes.length-1], sub);
        for (var iNode = nodes.length-2; iNode >= 0; --iNode) {
          elem.insertBefore(nodes[iNode], nodes[iNode+1]);
        }
      }
      else if (sub.nodeName !== 'A') {
        linkElem(sub);
      }
    }
  }

  linkElem(doc.body);
}
