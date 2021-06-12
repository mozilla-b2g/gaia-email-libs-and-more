export default function normalizeFolderType(box, path, namespaces) {
  var attribs = (box.flags || []).map(function(flag) {
    return flag.substr(1).toUpperCase(); // Map "\\Noselect" => "NOSELECT"
  });

  var type = null;
  // NoSelect trumps everything.
  if (attribs.indexOf('NOSELECT') !== -1) {
    type = 'nomail';
  }
  else {
    // Standards-ish:
    // - special-use: http://tools.ietf.org/html/rfc6154
    //   IANA registrations:
    //   http://www.iana.org/assignments/imap4-list-extended
    // - xlist:
    //   https://developers.google.com/google-apps/gmail/imap_extensions

    // Process the attribs for goodness.
    for (var i = 0; i < attribs.length; i++) {
      switch (attribs[i]) {
        case 'ALL': // special-use
        case 'ALLMAIL': // xlist
          type = 'all';
          break;
        case 'ARCHIVE': // special-use
          type = 'archive';
          break;
        case 'DRAFTS': // special-use xlist
          type = 'drafts';
          break;
        case 'FLAGGED': // special-use
          type = 'starred';
          break;
        case 'IMPORTANT': // (undocumented) xlist
          type = 'important';
          break;
        case 'INBOX': // xlist
          type = 'inbox';
          break;
        case 'JUNK': // special-use
          type = 'junk';
          break;
        case 'SENT': // special-use xlist
          type = 'sent';
          break;
        case 'SPAM': // xlist
          type = 'junk';
          break;
        case 'STARRED': // xlist
          type = 'starred';
          break;

        case 'TRASH': // special-use xlist
          type = 'trash';
          break;

        case 'HASCHILDREN': // 3348
        case 'HASNOCHILDREN': // 3348
          break;

        // - standard bits we don't care about
        case 'MARKED': // 3501
        case 'UNMARKED': // 3501
        case 'NOINFERIORS': // 3501
          // XXX use noinferiors to prohibit folder creation under it.
        // NOSELECT
          break;

        default:
      }
    }

    // heuristic based type assignment based on the name
    if (!type) {
      // ensure that we treat folders at the root, see bug 854128
      var prefix = namespaces.personal[0] &&
            namespaces.personal[0].prefix;
      var isAtNamespaceRoot = path === (prefix + box.name);
      // If our name is our path, we are at the absolute root of the tree.
      // This will be the case for INBOX even if there is a namespace.
      if (isAtNamespaceRoot || path === box.name) {
        switch (box.name.toUpperCase()) {
          case 'DRAFT':
          case 'DRAFTS':
            type = 'drafts';
            break;
          case 'INBOX':
            // Inbox is special; the path needs to case-insensitively match.
            if (path.toUpperCase() === 'INBOX') {
              type = 'inbox';
            }
            break;
          // Yahoo provides "Bulk Mail" for yahoo.fr.
          case 'BULK MAIL':
          case 'JUNK':
          case 'SPAM':
            type = 'junk';
            break;
          case 'SENT':
            type = 'sent';
            break;
          case 'TRASH':
            type = 'trash';
            break;
          // This currently only exists for consistency with Thunderbird, but
          // may become useful in the future when we need an outbox.
          case 'UNSENT MESSAGES':
            type = 'queue';
            break;
          default:
            break;
        }
      }
    }

    if (!type) {
      type = 'normal';
    }
  }
  return type;
}
