import { convIdFromMessageId, messageIdComponentFromUmid } from 'shared/id_conversions';

/**
 * Task helper to assist in establishing the conversation relationship for
 * a message given a BrowserBox-style raw message rep.
 */
export async function resolveConversationTaskHelper(ctx, msgOrHeaders, accountId, umid) {
  // -- Perform message-id header lookups
  let msgIdHeader = msgOrHeaders.guid;
  let references = msgOrHeaders.references;

  let headerIdLookupRequests = new Map();
  for (let ref of references) {
    headerIdLookupRequests.set([accountId, ref], null);
  }
  headerIdLookupRequests.set([accountId, msgIdHeader], null);

  let fromDb = await ctx.read({
    headerIdMaps: headerIdLookupRequests
  });

  // -- Check our results
  // Iterate over the results:
  // * keeping track of the conversation ids we find.  Ideally we find zero or
  //   one.  If we find multiple, we need to queue up a merge job.
  // TODO: implement the merge logic, etc.
  // * keeping track of the missing entries in the map.  We will issue writes to
  //   to these as part of this job,
  let conversationIds = new Set();
  let idsLackingEntries = [];
  let existingMessageEntry = null;
  for (let [[, headerId], result] of fromDb.headerIdMaps) {
    if (headerId === msgIdHeader) {
      existingMessageEntry = headerId;
    }
    if (!result) {
      if (headerId !== msgIdHeader) {
        idsLackingEntries.push(headerId);
      }
      continue;
    }

    // If it's an array then it's an array of MessageIds
    if (Array.isArray(result)) {
      conversationIds.add(convIdFromMessageId(result[0]));
    }
    else if (typeof(result) === 'string') {
      conversationIds.add(result);
    }
  }

  let convId;
  let existingConv;

  // If there isn't a conversation already, derive an id from our umid.
  if (conversationIds.size === 0) {
    convId = accountId + '.' + messageIdComponentFromUmid(umid);
    existingConv = false;
  }
  // If there's just one, then use it.
  else if (conversationIds.size === 1) {
    convId = Array.from(conversationIds)[0];
    existingConv = true;
  }
  // Otherwise we just arbitarily pick one and schedule a merge.
  else {
    convId = Array.from(conversationIds)[0];
    existingConv = true;
    // TODO: we want to merge it, merge it.  implement that.
  }

  // -- Generate our headerIdMaps writes
  // - Generate our full messageId.
  let messageId = convId + '.' + messageIdComponentFromUmid(umid);

  let headerIdWrites = new Map();
  // For the entries missing things, they just get the conversation id.
  for (let idLackingEntry of idsLackingEntries) {
    headerIdWrites.set([accountId, idLackingEntry], convId);
  }
  if (Array.isArray(existingMessageEntry)) {
    existingMessageEntry.push(messageId);
    headerIdWrites.set([accountId, msgIdHeader], existingMessageEntry);
  } else {
    headerIdWrites.set([accountId, msgIdHeader], [messageId]);
  }

  return {
    convId, existingConv, messageId, headerIdWrites,
    // when merging happens, this may end up being a list with that task in it:
    extraTasks: null
  };
}
