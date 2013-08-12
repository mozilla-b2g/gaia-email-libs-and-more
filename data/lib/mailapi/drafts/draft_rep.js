/**
 * Back-end draft abstraction.
 *
 * Drafts are saved to folder storage and look almost exactly like received
 * messages.  The primary difference is that attachments that are in the
 * process of being attached are stored in an `attaching` field on the
 * `BodyInfo` instance.
 *
 *
 **/

define(function(require) {

/**
 * Update the given header and body reps to integrate the contents of the given
 * draft wire rep.  Attachments are not handled by this mechanism!
 */
function updateHeaderAndBodyWithDraftRep(header, body, draftWireRep) {
}

function convertHeaderAndBodyToDraftWireRep(header, body) {
}

return {
  updateHeaderAndBodyWithDraftRep: updateHeaderAndBodyWithDraftRep,
  convertHeaderAndBodyToDraftWireRep: convertHeaderAndBodyToDraftWireRep,
};

}); // end define
