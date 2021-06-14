// NB: We could consider being case-insensitive where appropriate.  (Or even
// where potentially not appropriate.)

export function addressMatches(a, b) {
  return a.address === b.address;
}

export function cloneRecipients(recipients) {
  return {
    to: recipients.to ? recipients.to.slice() : null,
    cc: recipients.cc ? recipients.cc.slice() : null,
    bcc: recipients.bcc ? recipients.bcc.slice : null
  };
}

/**
 * Given the author of a message as an address-pair and the potentially existing
 * replyTo address-pair, compute the effective author of the message for reply
 * purposes.
 */
export function effectiveAuthorGivenReplyTo(fromAddressPair, replyToAddressPair) {
  return {
    name: fromAddressPair.name,
    address: (replyToAddressPair && replyToAddressPair.address) ||
             fromAddressPair.address
  };
}

/**
 * Return true if the address list contains an entry containing the address in
 * the given address pair.
 */
export function checkIfAddressListContainsAddress(list, addrPair) {
  if (!list) {
    return false;
  }
  let checkAddress = addrPair.address;
  for (var i = 0; i < list.length; i++) {
    if (list[i].address === checkAddress) {
      return true;
    }
  }
  return false;
}

/**
 * Filter anything matching the provided identity from the provided address list
 * (using the )
 */
export function filterOutIdentity(list, identity) {
  return list.filter(addressPair => addressPair.address !== identity.address);
}

// ====== Identity man

/**
 * Given an identity, extract and return { name, address }.
 */
export function addressPairFromIdentity(identity) {
  return {
    name: identity.name,
    address: identity.address
  };
}

/**
 * Given an identity, extract and return the replyTo.
 */
export function replyToFromIdentity(identity) {
  return { address: identity.replyTo };
}
