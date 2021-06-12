import { linkifyHTML } from './linkify';

const DEFAULT_STYLE_TAG =
  '<style type="text/css">\n' +
  // ## blockquote
  // blockquote per html5: before: 1em, after: 1em, start: 4rem, end: 4rem
  'blockquote {' +
  'margin: 0; ' +
  // so, this is quoting styling, which makes less sense to have in here.
  '-moz-border-start: 0.2rem solid gray; ' +
  // padding-start isn't a thing yet, somehow.
  'padding: 0; -moz-padding-start: 0.5rem; ' +
  '}\n' +
  // Give the layout engine an upper-bound on the width that's arguably
  // much wider than anyone should find reasonable, but might save us from
  // super pathological cases.
  'html, body { max-width: 120rem; word-wrap: break-word;' +
  // don't let the html/body grow the scrollable area.  Also, it's not clear
  // overflow: hidden actually works in either of these cases, but I did most of
  // the development and testing where things worked with the overflow: hidden
  // present and I'm worried about removing it now.
  ' overflow: hidden; padding: 0; margin: 0; font-size: 80%; }\n' +
  // pre messes up wrapping very badly if left to its own devices
  'pre { white-space: pre-wrap; word-wrap: break-word; }\n' +
  '.moz-external-link { color: #00aac5; cursor: pointer; }\n' +
  '</style>';


/**
 * Fetch the contents of the given sanitized text/html body and render it
 * into an inert sandboxed iframe.  Event handlers are added so that the
 * iframe acts as if "seamless" were a thing that browsers implemented.
 *
 * Note that this helper is intended for trivial desktop-style use where
 * pinch/zoom behaviour is not required.  If you need pinch/zoom, you need to
 * be handling this yourself at the current time.
 *
 * This function call is currently synchronous but the document loading
 * process is inherently asynchronous because we utilize the src mechanism.
 * This (hopefully) allows the document parsing to occur on a background
 * thread.  Note that this also means your CSP policy (if 1.1/2 or later) MUST
 * whitelist "blob" for child-src.  Probably.  I'm guessing.  I don't know.
 * Maybe "self" also works in some versions?  Somebody test and update this
 * documentation.  Or just file a bug when it breaks for you.  Yeah, that's
 * the ticket.
 *
 * @param {Blob} blob
 * @param {DOMElement} containerNode
 *   The container the iframe should be inserted into.  This should ideally be
 *   a DOM node for our exclusive use for symmetry with how embodyPlain works.
 *   (It is async and creates a bunch of nodes under the element you give it.)
 *
 *
 * @return {Object}
 *   Returns an object of the form { iframe, loadedPromise }.
 *   Note that because of how promise resolution works, the loaded promise is
 *   going to happen strictly after the "load" event you would receive if you
 *   added a listener to the iframe.
 */
export default function embodyHTML(blob, containerNode, clickHandler) {
  let ownerDoc = containerNode.ownerDocument;

  let iframe = document.createElement('iframe');
  iframe.setAttribute('sandbox', 'allow-same-origin');
  // Styling!
  iframe.setAttribute(
    'style',
    // no border! no padding/margins.
    'padding: 0; border-width: 0; margin: 0; ' +
    // The iframe does not want to process its own clicks!  that's what
    // bindSanitizedClickHandler is for!
    'pointer-events: none;');
  // try and size the iframe to a standard email width thing
  // XXX it'd be better to use the actual effective viewport here, if we could
  // have that accessible without forcing a reflow.
  iframe.style.width = '640px';

  let superBlob = new Blob(
    [
      '<!doctype html><html><head><meta charset="utf-8">',
      DEFAULT_STYLE_TAG,
      '</head><body>',
      blob,
      '</body>'
    ],
    { type: 'text/html'});
  let superBlobUrl = ownerDoc.defaultView.URL.createObjectURL(superBlob);
  iframe.setAttribute('src', superBlobUrl);
  containerNode.appendChild(iframe);

  let RESIZE_POLL_RATE = 200;

  let loadedPromise = new Promise((resolve, reject) => {
    let pollCount = 0;
    let pendingResize = null;

    // Check if we need to resize the iframe.  This is a self-rescheduling
    // thing.  Note that this widget currently has no UI for embedded or
    // external images, so that aspect isn't quite dealt with, but will need
    // this.
    // XXX implement external/embedded image disply
    let resizeIframe = () => {
      // if the iframe has been destroyed, stop trying to resize it
      if (!iframe.parentNode || !iframe.contentDocument) {
        return;
      }
      let iframeBody = iframe.contentDocument.body;

      let containerWidth = iframe.clientWidth;
      let containerHeight = iframe.clientHeight;

      let iframeWidth = iframeBody.scrollWidth;
      let iframeHeight = iframeBody.scrollHeight;

      let needPoll = (pollCount-- > 0);
      // enlarge width as needed.
      if (containerWidth < iframeWidth) {
        iframe.style.width = iframeWidth + 'px';
        // This will necessitate a reflow since we upped the width.  yuck, I
        // know.
        iframe.style.height = iframeBody.scrollHeight + 'px';
        needPoll = true;
      }
      else if (containerHeight !== iframeHeight) {
        iframe.style.height = iframeHeight + 'px';
        needPoll = true;
      }
      if (needPoll) {
        pendingResize = setTimeout(resizeIframe, RESIZE_POLL_RATE);
      } else {
        pendingResize = null;
      }
    };
    iframe.resizeIframe = resizeIframe;
    let pollForResize = (pollAtLeast) => {
      pollCount = Math.max(pollCount, pollAtLeast);
      if (!pendingResize) {
        resizeIframe();
      }
    };

    let initialLoadHandler = () => {
      iframe.removeEventListener('load', initialLoadHandler);
      ownerDoc.defaultView.URL.revokeObjectURL(superBlobUrl);
      resolve();
      // load implies any images were loaded, so really just once is okay,
      // but just in case there are some instabilities, ensure we check at
      // least once more.
      pollForResize(3);
      // Now listen as long as the iframe is alive for images showing up.  If
      // they show up, do a resize check.  (We use capturing since the event
      // does not bubble.)
      iframe.contentDocument.body.addEventListener('load', () => {
        pollForResize(2);
      }, true);
    };
    iframe.addEventListener('load', initialLoadHandler);
  });

  return { iframe, loadedPromise };
}

