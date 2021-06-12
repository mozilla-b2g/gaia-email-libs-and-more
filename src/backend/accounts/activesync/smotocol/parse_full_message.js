import mimetypes from 'mimetypes';
import { parse as parseAddresses } from 'addressparser';

import { encodeInt as encodeA64 } from 'shared/a64';

import * as mailRep from '../../../db/mail_rep';

import { Tags as asb, Enums as asbEnum }
  from 'activesync/codepages/AirSyncBase';
import { Tags as em } from 'activesync/codepages/Email';

/**
 * Parse the given WBXML server representation of a message into a GELAM backend
 * MessageInfo representation.
 *
 * Historical note: In v1 we had a single parsing function that operated in a
 * full parsing mode or a changed parsing mode and involved clever helper
 * functions.  It has been split into this function and parsedChangeMessage in
 * the interest of readability.
 *
 * @param {WBXML.Element} node
 */
export default function parseFullMessage(node, { messageId, umid, folderId }) {
  // The representation we mutate into shape.  This will eventually be passed
  // through `makeMessageInfo` in mail_rep.js.
  let scratchMsg = {
    id: messageId,
    umid,
    // ActiveSync does not/cannot tell us the Message-ID header unless we
    // fetch the entire MIME body
    guid: '',
    author: null,
    to: null,
    cc: null,
    bcc: null,
    replyTo: null,
    date: null,
    flags: [],
    folderIds: new Set([folderId]),
    hasAttachments: false,
    subject: null,
    snippet: null,
    attachments: [],
    relatedParts: [],
    references: [],
    bodyReps: null
  };

  let bodyType, bodySize;

  for (let child of node.children) {
    let childText = child.children.length ? child.children[0].textContent :
                                            null;

    switch (child.tag) {
      case em.Subject:
        scratchMsg.subject = childText;
        break;
      case em.From:
        scratchMsg.author = parseAddresses(childText)[0] || null;
        break;
      case em.To:
        scratchMsg.to = parseAddresses(childText);
        break;
      case em.Cc:
        scratchMsg.cc = parseAddresses(childText);
        break;
      case em.ReplyTo:
        scratchMsg.replyTo = parseAddresses(childText);
        break;
      case em.DateReceived:
        scratchMsg.date = new Date(childText).valueOf();
        break;
      case em.Read:
        if (childText === '1') {
          scratchMsg.flags.push('\\Seen');
        }
        break;
      case em.Flag:
        for (let grandchild of child.children) {
          if (grandchild.tag === em.Status &&
              grandchild.children[0].textContent !== '0') {
            scratchMsg.flags.push('\\Flagged');
          }
        }
        break;
      case asb.Body: // ActiveSync 12.0+
        for (let grandchild of child.children) {
          switch (grandchild.tag) {
            case asb.Type:
              var type = grandchild.children[0].textContent;
              if (type === asbEnum.Type.HTML) {
                bodyType = 'html';
              } else {
                // I've seen a handful of extra-weird messages with body types
                // that aren't plain or html. Let's assume they're plain,
                // though.
                if (type !== asbEnum.Type.PlainText) {
                  console.warn('A message had a strange body type:', type);
                }
                bodyType = 'plain';
              }
              break;
            case asb.EstimatedDataSize:
              bodySize = grandchild.children[0].textContent;
              break;
            default:
              // Ignore other tag types.
              break;
          }
        }
        break;
      case em.BodySize: // pre-ActiveSync 12.0
        bodyType = 'plain';
        bodySize = childText;
        break;
      case asb.Attachments: // ActiveSync 12.0+
      case em.Attachments:  // pre-ActiveSync 12.0
        for (let attachmentNode of child.children) {
          if (attachmentNode.tag !== asb.Attachment &&
              attachmentNode.tag !== em.Attachment) {
            continue;
          }

          let attachment = {
            relId: encodeA64(scratchMsg.attachments.length),
            name: null,
            contentId: null,
            type: null,
            part: null,
            encoding: null,
            sizeEstimate: null,
            downloadState: null,
            file: null,
          };

          let isInline = false;
          for (let attachData of attachmentNode.children) {
            let dot, ext;
            let attachDataText = attachData.children.length ?
                                 attachData.children[0].textContent : null;

            switch (attachData.tag) {
              case asb.DisplayName:
              case em.DisplayName:
                attachment.name = attachDataText;

                // Get the file's extension to look up a mimetype, but ignore it
                // if the filename is of the form '.bashrc'.
                dot = attachment.name.lastIndexOf('.');
                ext = dot > 0 ?
                        attachment.name.substring(dot + 1).toLowerCase() :
                        '';
                attachment.type = mimetypes.detectMimeType(ext);
                break;
              case asb.FileReference:
              case em.AttName:
              case em.Att0Id:
                attachment.part = attachDataText;
                break;
              case asb.EstimatedDataSize:
              case em.AttSize:
                attachment.sizeEstimate = parseInt(attachDataText, 10);
                break;
              case asb.ContentId:
                attachment.contentId = attachDataText;
                break;
              case asb.IsInline:
                isInline = (attachDataText === '1');
                break;
              default:
                // Ignore other tag types.
                break;
            }
          }

          if (isInline) {
            scratchMsg.relatedParts.push(
              mailRep.makeAttachmentPart(attachment));
          } else {
            scratchMsg.attachments.push(mailRep.makeAttachmentPart(attachment));
          }
        }
        scratchMsg.hasAttachments = scratchMsg.attachments.length > 0;
        break;
      default:
        // Ignore other tag types.
        break;
    }
  }

  scratchMsg.bodyReps = [
    mailRep.makeBodyPart({
      type: bodyType,
      sizeEstimate: bodySize,
      amountDownloaded: 0,
      isDownloaded: false
    })
  ];

  return mailRep.makeMessageInfo(scratchMsg);
}
