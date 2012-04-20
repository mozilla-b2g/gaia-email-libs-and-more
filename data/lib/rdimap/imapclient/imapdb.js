/**
 *
 **/

define(
  [
    'exports'
  ],
  function(
    exports
  ) {

const CUR_VERSION = 1;

/**
 * The configuration table contains configuration data that should persist
 * despite implementation changes. Global configuration data, and account login
 * info.  Things that would be annoying for us to have to re-type.
 */
const TBL_CONFIG = 'config',
      CONFIG_ROW_ROOT = 'config',
      CONFIG_ROWPREFIX_ACCOUNT_DEF = 'accountDef:';

/**
 * The folder-info table stores meta-data about the known folders for each
 * account.  This information may be blown away on upgrade.
 *
 * While we may eventually stash info like histograms of messages by date in
 * a folder, for now this is all about serving as a directory service for the
 * header and body blocks.
 */
const TBL_FOLDER_INFO = 'folderInfo';

/**
 * Stores time-clustered information about messages in folders.  Message bodies
 * and attachment names are not included, but initial snippets and the presence
 * of attachments are.
 *
 * We store headers separately from bodies because our access patterns are
 * different for each.  When we want headers, all we want is headers, and don't
 * need the bodies clogging up our IO.  Additionally, we expect better
 * compression for bodies if they are stored together.
 *
 * row id: `FolderId`:`BlockId`
 *
 * Each value is an object dictionary whose keys are either UIDs or a more
 * globally unique identifier (ex: gmail's X-GM-MSGID values).  The values are
 * the info on the message; see `ImapFolderStorage` for details.
 */
const TBL_HEADER_BLOCKS = 'headerBlocks';
/**
 * Stores time-clustered information about message bodies.  Body details include
 * the list of attachments, as well as the body payloads and the embedded inline
 * parts if they all met the sync heuristics.  (If we can't sync all the inline
 * images, for example, we won't sync any.)
 *
 * Note that body blocks are not paired with header blocks; their storage is
 * completely separate.
 *
 * row id: `FolderId`:`BlockId`
 *
 * Each value is an object dictionary whose keys are either UIDs or a more
 * globally unique identifier (ex: gmail's X-GM-MSGID values).  The values are
 * the info on the message; see `ImapFolderStorage` for details.
 */
const TBL_BODY_BLOCKS = 'bodyBlocks';

/**
 * == Useful tidbits on our IndexedDB implementation
 *
 * - SQLite page size is 32k
 * - The data persisted to the database (but not Blobs AFAICS) gets compressed
 *   using snappy on a per-value basis.
 * - Blobs/files are stored as files on the file-system that are referenced by
 *   the data row.  Since they are written in one go, they are highly unlikely
 *   to be fragmented.
 * - Blobs/files are clever once persisted.  Specifically, nsDOMFileFile
 *   instances are created with just the knowledge of the file-path.  This means
 *   the data does not have to be marshaled, and it means that it can be
 *   streamed off the disk.  This is primarily beneficial in that if there is
 *   data we don't need to mutate, we can feed it directly to the web browser
 *   engine without potentially creating JS string garbage.
 *
 * Given the page size and snappy compression, we probably only want to spill to
 * a blob for non-binary data that exceeds 64k by a fair margin, and less
 * compressible binary data that is at least 64k.
 *
 */
function ImapDB() {
  var openRequest = IndexedDB.open("b2gemail", CUR_VERSION);
  openRequest.onsuccess = function(event) {
  };
  openRequest.onupgradeneeded = function(event) {
    var db = dbOpenRequest.result;

    db.createObjectStore(TBL_FOLDER_INFO);
    db.createObjectStore(TBL_HEADER_CHUNKS);
    db.createObjectStore(TBL_BODY_BLOCKS);
  };
}
ImapDB.prototype = {
};

}); // end define
