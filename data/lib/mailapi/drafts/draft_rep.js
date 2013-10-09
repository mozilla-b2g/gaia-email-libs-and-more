/**
 * Back-end draft abstraction.
 *
 * Drafts are saved to folder storage and look almost exactly like received
 * messages.  The primary difference is that attachments that are in the
 * process of being attached are stored in an `attaching` field on the
 * `BodyInfo` instance and that they are discarded on load if still present
 * (indicating a crash/something like a crash during the save process).
 *
 **/

define(function(require) {

var mailRep = require('mailapi/db/mail_rep');

/**
 * Create a new header and body for a draft by extracting any useful state
 * from the previous draft's persisted header/body and the revised draft.
 *
 * @method mergeDraftStates
 * @param oldHeader {HeaderInfo}
 * @param oldBody {BodyInfo}
 * @param newDraftRep {DraftRep}
 * @param newDraftInfo {Object}
 * @param newDraftInfo.id {Number}
 * @param newDraftInfo.suid {SUID}
 * @param newDraftInfo.date {Number}
 */
function mergeDraftStates(oldHeader, oldBody,
                          newDraftRep, newDraftInfo,
                          universe) {

  var identity = universe.getIdentityForSenderIdentityId(newDraftRep.senderId);

  // -- convert from compose rep to header/body rep
  var newHeader = mailRep.makeHeaderInfo({
    id: newDraftInfo.id,
    srvid: null, // stays null
    suid: newDraftInfo.suid, // filled in by the job
    // we currently don't generate a message-id for drafts, but we'll need to
    // do this when we start appending to the server.
    guid: oldHeader ? oldHeader.guid : null,
    author: { name: identity.name, address: identity.address},
    to: newDraftRep.to,
    cc: newDraftRep.cc,
    bcc: newDraftRep.bcc,
    replyTo: identity.replyTo,
    date: newDraftInfo.date,
    flags: [],
    hasAttachments: oldHeader ? oldHeader.hasAttachments : false,
    subject: newDraftRep.subject,
    snippet: newDraftRep.body.text.substring(0, 100),
  });
  var newBody = mailRep.makeBodyInfo({
    date: newDraftInfo.date,
    size: 0,
    attachments: oldBody ? oldBody.attachments.concat() : [],
    relatedParts: oldBody ? oldBody.relatedParts.concat() : [],
    references: newDraftRep.referencesStr,
    bodyReps: []
  });
  newBody.bodyReps.push(mailRep.makeBodyPart({
    type: 'plain',
    part: null,
    sizeEstimate: newDraftRep.body.text.length,
    amountDownloaded: newDraftRep.body.text.length,
    isDownloaded: true,
    _partInfo: {},
    content: [0x1, newDraftRep.body.text]
  }));
  if (newDraftRep.body.html) {
    newBody.bodyReps.push(mailRep.makeBodyPart({
      type: 'html',
      part: null,
      sizeEstimate: newDraftRep.body.html.length,
      amountDownloaded: newDraftRep.body.html.length,
      isDownloaded: true,
      _partInfo: {},
      content: newDraftRep.body.html
    }));
  }

  return {
    header: newHeader,
    body: newBody
  };
}

function convertHeaderAndBodyToDraftRep(account, header, body) {
  var composeBody = {
    text: '',
    html: null,
  };

  // Body structure should be guaranteed, but add some checks.
  if (body.bodyReps.length >= 1 &&
      body.bodyReps[0].type === 'plain' &&
      body.bodyReps[0].content.length === 2 &&
      body.bodyReps[0].content[0] === 0x1) {
    composeBody.text = body.bodyReps[0].content[1];
  }
  // HTML is optional, but if present, should satisfy our guard
  if (body.bodyReps.length == 2 &&
      body.bodyReps[1].type === 'html') {
    composeBody.html = body.bodyReps[1].content;
  }

  var attachments = [];
  body.attachments.forEach(function(att) {
    attachments.push({
      name: att.name,
      blob: att.file
    });
  });

  var draftRep = {
    identity: account.identities[0],
    subject: header.subject,
    body: composeBody,
    to: header.to,
    cc: header.cc,
    bcc: header.bcc,
    referencesStr: body.references,
    attachments: attachments
  };
}


return {
  mergeDraftStates: mergeDraftStates,
  convertHeaderAndBodyToDraftRep: convertHeaderAndBodyToDraftRep,
};

}); // end define
