define(function(require) {
'use strict';

/**
 * The heart of the download task, with each engine providing their own download
 * protocol stuff.
 *
 * ## Task Granularity, Multiple Downloads But Only One Overlay ##
 *
 * Attachments are not first-class.  We assign them their own id's for sanity,
 * but they live on the message that owns them and their life-cycles are bounded
 * by the message's lifetime, etc.
 *
 * For reasons of locality for us and for the server (especially for
 * multipart/related HTML with embedded images), we cluster all download
 * requests by their message.  This, unsurprisingly, is important for overlay
 * purposes too, since only messages can report overlays (unless we fancy things
 * up.)
 *
 * We provide our overlay as a Map from attachment relId to a dictionary of
 *
 */
return {

};
});
