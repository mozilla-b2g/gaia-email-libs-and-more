import { generateSearchableTextVersion } from '../../../bodies/htmlchew';

/**
 * Fetch the contents of the body part Blobs as strings, also normalizing HTML
 * to plaintext for search purposes.  We exist to allow the filters to
 * synchronously execute without waiting for the Blobs to fetch.  It is our
 * current assumption that message body sizes are manageable.  The body parts
 * are stored as Blobs primarily for I/O and SQLite page size reasons
 * (especially if Gecko's IndexedDB implementation ever adopts use of WITHOUT
 * ROWID).
 *
 * @param {Object} args
 * @param {Boolean} [args.includeQuotes=false]
 *   For HTML body parts, should the contents of (known) quotes be included.
 *   This has no impact on the quotechewed representation since it uses a rich
 *   markup.
 */
export default function GatherMessageBodies(ignoredParams, args) {
  this.includeQuotes = args ? (args.includeQuotes || false) : false;
}
GatherMessageBodies.prototype = {
  async gather(gathered) {
    let message = gathered.message;
    let bodyPromises = message.bodyReps.map((part) => {
      // They body part may not have been fetched yet.
      if (!part.contentBlob) {
        return null;
      }
      return part.contentBlob.text();
    });
    let fetchedBodies = await Promise.all(bodyPromises);

    // List of the type-tagged body contents.  If a part was not downloaded,
    // we omit it from the list.  At this time there are no filters that would
    // care about establishing part correspondence, etc. and it simplifies
    // things if they don't have to worry about null values, etc.  We can change
    // this later.
    let bodyResults = [];

    for (let i=0; i < message.bodyReps.length; i++) {
      // This is a string, but for 'plain' parts it will have a JSON payload
      // that will still need to be parsed.
      let bodyObj = fetchedBodies[i];
      if (!bodyObj) {
        continue;
      }
      let bodyRep = message.bodyReps[i];
      if (bodyRep.type === 'html') {
        bodyResults.push({
          type: bodyRep.type,
          textBody: generateSearchableTextVersion(bodyObj, this.includeQuotes)
        });
      } else {
        bodyResults.push({
          type: bodyRep.type,
          // Parse the JSON back into objects!
          rep: JSON.parse(bodyObj)
        });
      }
    }

    return bodyResults;
  }
};
