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
 * Tags that we are opting not to include will be commented with a reason tag:
 * - annoying: This thing is ruled out currently because it only allows annoying
 *   things to happen.
 * - scripty: This thing requires scripting to make anything happen, and we do
 *   not allow scripting.
 * - implicitly-nuked: killed as part of the parse process because we assign
 *   to innerHTML rather than creating a document with the string in it.
 * - inline-style-only:
 */
var LEGAL_TAGS = [
  'a', 'abbr', 'acronym', 'area', 'article', 'aside',
  // annoying: 'audio',
  'b', 'bdi', 'bdo', 'big', 'blockquote',
  // implicitly-nuked: 'body'
  'br', 'button',
  // scripty: canvas
  'caption', 'center', 'cite', 'code', 'col', 'colgroup', 'command',
  'datalist', 'dd', 'del', 'details', 'dfn', 'dir', 'div', 'dl', 'dt',
  'em', 'fieldset', 'figcaption', 'figure', 'font', 'footer', 'form',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  // implicitly-nuked: head
  'header', 'hgroup', 'hr',
  // implicitly-nuked: html
  'i', 'img', 'input', 'ins',
  'kbd',
  'label', 'legend', 'li', 'link', 'listing',
  'map', 'mark', 'menu', 'meta', 'meter',
  'nav', 'nobr', 'noscript',
  'ol', 'optgroup', 'option', 'output',
  'p', 'pre', 'progress', 'q', 'rp', 'rt', 'ruby',
  's', 'samp', 'section', 'select', 'small',
  // annoying?: 'source',
  'span', 'strike', 'strong',
  // inline-style-only: 'style'
  'sub', 'summary', 'sup',
  'table', 'tbody', 'td', 'textarea', 'tfoot', 'th', 'thead', 'time',
  'title', // XXX does this mean anything outside head?
  'tr',
  // annoying?: 'track'
  'tt',
  'u', 'ul', 'var',
  // annoying: 'video',
  'wbr'
];

var LEGAL_ATTR_MAP = {
  '*': ['style'],
  'img': ['alt'],

};

var LEGAL_STYLES = [
  'background-color',
  'color',
];


var BLEACH_SETTINGS = {
  tags: LEGAL_TAGS,
  attributes: LEGAL_ATTR_MAP,
  styles: LEGAL_STYLES,
},

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

};

/**
 * Derive snippet text from the already-sanitized HTML representation.
 */
exports.generateSnippet = function generateSnippet(sanitizedHtmlNode) {
};

}); // end define
