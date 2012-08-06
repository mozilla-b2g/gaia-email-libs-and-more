/**
 * Process text/html for message body purposes.  Specifically:
 *
 * - sanitize HTML (using bleach.js): discard illegal markup entirely, render
 *   legal but 'regulated' markup inert (ex: links to external content).
 * - TODO: perform normalization of quote markup from different clients into
 *   blockquotes, like how Thunderbird conversations does it.
 * - snippet generation: Try and generate a usable snippet string from something
 *   that is not a quote.  In cases of complicated HTML, probably just fail.
 *
 * We may eventually try and perform more detailed analysis like `quotechew.js`
 * does with structured markup, potentially by calling out to quotechew, but
 * that's a tall order to get right, so it's mightily postponed.
 **/

define(
  [
    'exports',
    'bleach'
  ],
  function(
    exports,
    $bleach
  ) {

/**
 * Whitelisted HTML tags list. Currently from nsTreeSanitizer.cpp which credits
 * Mark Pilgrim and Sam Ruby for its own initial whitelist.
 *
 * Some things are just not in the list at all:
 * - SVG: Thunderbird nukes these itself because it forces
 *   SanitizerCidEmbedsOnly which causes flattening of everything in the SVG
 *   namespace.
 *
 * Tags that we are opting not to include will be commented with a reason tag:
 * - annoying: This thing is ruled out currently because it only allows annoying
 *   things to happen *given our current capabilities*.
 * - scripty: This thing requires scripting to make anything happen, and we do
 *   not allow scripting.
 * - forms: Thunderbird explicitly and unconditionally forbids forms, presumably
 *   because they are useless locally without scripting, and their target is
 *   is not reflected in the UI like hyperlinks are or at least should be.
 * - implicitly-nuked: killed as part of the parse process because we assign
 *   to innerHTML rather than creating a document with the string in it.
 * - inline-style-only: Styles have to be included in the document itself,
 *   and for now, on the elements themselves.  We'll support <style> tags at
 *   some point.
 * - dangerous: The semantics of the tag are intentionally at odds with our
 *   goals and/or are extensible.  (ex: link tag.)
 * - interactive-ui: A cross between scripty and forms, things like (HTML5)
 *   menu and command imply some type of mutation that requires scripting.
 *   They also are frequently very attribute-heavy.
 * - non-css-presentation: It's a styling thing that's not CSS.  Apparently
 *   Thunderbird's original sanitizer didn't let this kind of stuff through.
 *   Now that nsTreeSanitizer is used, SanitizerDropNonCSSPresentation is
 *   specified by default.
 */
var LEGAL_TAGS = [
  'a', 'abbr', 'acronym', 'area', 'article', 'aside',
  // annoying: 'audio',
  'b',
  'bdi', 'bdo', // (bidirectional markup stuff)
  'big', 'blockquote',
  // implicitly-nuked: 'body'
  'br',
  // forms: 'button',
  // scripty: canvas
  'caption',
  // non-css-presentation: 'center',
  'cite', 'code', 'col', 'colgroup',
  // interactive-ui: 'command',
  // forms: 'datalist',
  'dd', 'del', 'details', 'dfn', 'dir', 'div', 'dl', 'dt',
  'em',
  // forms: 'fieldset' (but allowed by nsTreeSanitizer)
  'figcaption', 'figure',
  // non-css-presentation: 'font',
  'footer',
  // forms: 'form',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  // implicitly-nuked: head
  'header', 'hgroup', 'hr',
  // implicitly-nuked: html
  'i', 'img',
  // forms: 'input',
  'ins', // ("represents a range of text that has been inserted to a document")
  'kbd', // ("The kbd element represents user input")
  'label', 'legend', 'li',
  // dangerous, inline-style-only: link
  /* link supports many types, none of which we want, some of which are
   * risky: http://dev.w3.org/html5/spec/links.html#linkTypes. Specifics:
   * - "stylesheet": This would be okay for cid links, but there's no clear
   *   advantage over inline styles, so we forbid it, especially as supporting
   *   it might encourage other implementations to dangerously support link.
   * - "prefetch": Its whole point is de facto information leakage.
   */
  'listing', // (deprecated, like "pre")
  'map', 'mark',
  // interactive-ui: 'menu', 'meta', 'meter',
  'nav',
  'nobr', // (deprecated "white-space:nowrap" equivalent)
  'noscript',
  'ol',
  // forms: 'optgroup',
  // forms: 'option',
  'output', // (HTML5 draft: "result of a calculation in a form")
  'p', 'pre',
  // interactive-ui: 'progress',
  'q',
  /* http://www.w3.org/TR/ruby/ is a pronounciation markup that is not directly
   * supported by gecko at this time (although there is a Firefox extension).
   * All of 'rp', 'rt', and 'ruby' are ruby tags.  The spec also defines 'rb'
   * and 'rbc' tags that nsTreeSanitizer does not whitelist, however.
   */
  'rp', 'rt', 'ruby',
  's', 'samp', 'section',
  // forms: 'select',
  'small',
  // annoying?: 'source',
  'span', 'strike', 'strong',
  // inline-style-only: 'style'
  'sub', 'summary', 'sup',
  'table', 'tbody', 'td',
  // forms: 'textarea',
  'tfoot', 'th', 'thead', 'time',
  'title', // XXX does this mean anything outside head?
  'tr',
  // annoying?: 'track'
  'tt',
  'u', 'ul', 'var',
  // annoying: 'video',
  'wbr' // (HTML5 draft: line break opportunity)
];

/**
 * Tags whose children should be removed along with the tag itself, rather than
 * splicing the children into the position originally occupied by the parent.
 *
 * We do this for:
 * - forms; see `LEGAL_TAGS` for the rationale.  Note that we don't bother
 *   including children that should already be nuked by PRUNE_TAGS.  For
 *   example, 'option' and 'optgroup' only make sense under 'select' or
 *   'datalist', so we need not include them.  This means that if the tags
 *   are used in nonsensical positions, they will have their contents
 *   merged into the document text, but that's not a major concern.
 * - 'script': no one wants to read the ignored JS code!
 * - 'style': no one wants to read the CSS we are (currently) ignoring
 */
var PRUNE_TAGS = [
  'button',
  'datalist',
  'select',
];

/**
 * What attributes to allow globally and on specific tags.
 */
var LEGAL_ATTR_MAP = {
  '*': ['style'],
  'a': ['ext-href'],
  'area': ['ext-href'],
  'img': ['alt', 'cid-src', 'ext-src'],
};

var LEGAL_STYLES = [
  'background-color',
  'color',
];

/**
 * The regular expression to detect nodes that should be passed to stashLinks.
 *
 * ignore-case is not required; the value is checked against the lower-cased tag.
 */
const RE_NODE_NEEDS_TRANSFORM = /^(?:a|area|img)$/;

const RE_CID_URL = /^cid:/i;
const RE_HTTP_URL = /^http(?:s)?/i;

const RE_IMG_TAG = /^img$/;

/**
 * Transforms src tags, ensure that links are http and transform them too so
 * that they don't actually navigate when clicked on but we can hook them.  (The
 * HTML display iframe is not intended to navigate; we just want to trigger the
 * browser.
 */
function stashLinks(node, lowerTag) {
  // - img: src
  if (RE_IMG_TAG.test(lowerTag)) {
    var src = node.getAttribute('src');
    if (RE_CID_URL.test(src)) {
      node.classList.add('moz-embedded-image');
      node.setAttribute('cid-src', src);
      // 'src' attribute will be removed by whitelist
    }
    else if (RE_HTTP_URL.test(src)) {
      node.classList.add('moz-external-image');
      node.setAttribute('ext-src', src);
      // 'src' attribute will be removed by whitelist
    }
    else {
      // paranoia; no known benefit if this got through
      node.removeAttribute('cid-src');
      node.removeAttribute('ext-src');
    }
  }
  // - a, area: href
  else {
    var link = node.getAttribute('href');
    if (RE_HTTP_URL.test(link)) {
      node.classList.add('moz-external-link');
      node.setAttribute('ext-href', link);
      // 'href' attribute will be removed by whitelist
    }
    else {
      // paranoia; no known benefit if this got through
      node.removeAttribute('ext-href');
    }
  }
}

var BLEACH_SETTINGS = {
  tags: LEGAL_TAGS,
  strip: true,
  prune: PRUNE_TAGS,
  attributes: LEGAL_ATTR_MAP,
  styles: LEGAL_STYLES,
  asNode: true,
  callbackRegexp: RE_NODE_NEEDS_TRANSFORM,
  callback: stashLinks
};

/**
 * @args[
 *   @param[htmlString String]{
 *     An unsanitized HTML string.  The HTML content can be a fully valid HTML
 *     document with 'html' and 'body' tags and such, but most of that extra
 *     structure will currently be discarded.
 *
 *     In the future we may try and process the body and such correctly, but for
 *     now we don't.  This is consistent with many webmail clients who ignore
 *     style tags in the head, etc.
 *   }
 * ]
 * @return[HtmlElement]{
 *   The sanitized HTML content wrapped in a div container.
 * }
 */
exports.sanitizeAndNormalizeHtml = function sanitizeAndNormalize(htmlString) {
  var sanitizedNode = $bleach.clean(htmlString, BLEACH_SETTINGS);
  return sanitizedNode;
};

/**
 * Derive snippet text from the already-sanitized HTML representation.
 */
exports.generateSnippet = function generateSnippet(sanitizedHtmlNode,
                                                   desiredLength) {
  // XXX this is not efficient to get the entire textContent and then substring
  // it.
  // XXX we really should ignore things that we believe to be quoting.
  var text = sanitizedHtmlNode.textContent;
  return text.substring(0, desiredLength);
};

}); // end define
