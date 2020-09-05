/**
 * A helper for the situation where we have some parent rep (like a MailMessage)
 * that has explicitly owned children (like MailAttachments) where we want to
 * maintain object identity.  This requires that the wireReps and rich reps
 * both expose a (sufficiently-unique) id.
 *
 * @return {MailAttachment[]}
 *   A freshly updated list of MailAttachment instances.  If consumers would
 *   really prefer the Array to be mutated in place, we could do that, but it's
 *   a little simpler and more sane to create a new Array each time.  Obviously
 *   if the memory profiler says to mutate (or only fork to create a new Array
 *   on divergence), we can do that.
 */
export default function keyedListHelper({
    wireReps, existingRichReps, constructor, owner, idKey, addEvent,
    changeEvent, removeEvent }) {
  // Map of existing rich reps that we haven't processed yet.  By removing them
  // as we go we can use it to infer deletion.
  let pendingRichMap = new Map();
  for (let richRep of existingRichReps) {
    pendingRichMap.set(richRep[idKey], richRep);
  }

  let updatedList = [];
  for (let wireRep of wireReps) {
    let richRep = pendingRichMap.get(wireRep[idKey]);
    if (richRep) {
      richRep.__update(wireRep);
      pendingRichMap.delete(wireRep[idKey]);
      richRep.emit('change', richRep);
      if (changeEvent) {
        owner.emit(changeEvent, richRep);
      }
    } else {
      richRep = new constructor(owner, wireRep);
      if (addEvent) {
        owner.emit(addEvent, richRep);
      }
    }
    updatedList.push(richRep);
  }

  for (let richRep of existingRichReps) {
    richRep.emit('remove', richRep);
    if (removeEvent) {
      owner.emit(removeEvent, richRep);
    }
  }

  return updatedList;
}

