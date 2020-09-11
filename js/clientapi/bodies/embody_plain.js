import { linkifyPlain } from './linkify';

let CONTENT_TYPES_TO_CLASS_NAMES = [
    null,
    'msg-body-content',
    'msg-body-signature',
    'msg-body-leadin',
    null,
    'msg-body-disclaimer',
    'msg-body-list',
    'msg-body-product',
    'msg-body-ads'
  ];
let CONTENT_QUOTE_CLASS_NAMES = [
    'msg-body-q1',
    'msg-body-q2',
    'msg-body-q3',
    'msg-body-q4',
    'msg-body-q5',
    'msg-body-q6',
    'msg-body-q7',
    'msg-body-q8',
    'msg-body-q9'
  ];
let MAX_QUOTE_CLASS_NAME = 'msg-body-qmax';

/**
 * Fetch the contents of the given quotechew'd text/plain body, and render them
 * to be children of the provided body node.
 */
export default async function embodyPlain(blob, bodyNode) {
  var doc = bodyNode.ownerDocument;
  var rep = JSON.parse(await blob.text());

  for (var i = 0; i < rep.length; i += 2) {
    var node = doc.createElement('div'), cname;

    var etype = rep[i] & 0xf;
    if (etype === 0x4) {
      var qdepth = (((rep[i] >> 8) & 0xff) + 1);
      if (qdepth > 8) {
        cname = MAX_QUOTE_CLASS_NAME;
      } else {
        cname = CONTENT_QUOTE_CLASS_NAMES[qdepth];
      }
    } else {
      cname = CONTENT_TYPES_TO_CLASS_NAMES[etype];
    }
    if (cname) {
      node.setAttribute('class', cname);
    }

    var subnodes = linkifyPlain(rep[i + 1], doc);
    for (var iNode = 0; iNode < subnodes.length; iNode++) {
      node.appendChild(subnodes[iNode]);
    }

    bodyNode.appendChild(node);
  }

  return;
}
