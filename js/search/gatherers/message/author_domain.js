const RE_DOMAIN = /@(.+)$/;

/**
 * Extract the author's email domain, favoring their reply-to domain over their
 * actual sending domain.  That choice is currently arbitrary.
 */
export default function AuthorDomain(/* params, args */) {
}
AuthorDomain.prototype = {
  gather: function(gathered) {
    const { message } = gathered;

    const address = message.replyTo ? message.replyTo[0].address :
      message.author.address;
    const match = RE_DOMAIN.exec(address);

    return Promise.resolve(match && match[1].toLowerCase());
  }
};
