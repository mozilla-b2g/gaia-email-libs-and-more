import evt from 'evt';

import { showBlobInImg } from './blob_helpers';


/**
 * See `identities.md`.
 */
export default function MailPeep(name, address, contactId, thumbnailBlob) {
  evt.Emitter.call(this);

  this.name = name;
  this.address = address;
  this.contactId = contactId;
  this._thumbnailBlob = thumbnailBlob;

  // peeps are usually one of: from, to, cc, bcc
  this.type = null;
}
MailPeep.prototype = evt.mix({
  get isContact() {
    return this.contactId !== null;
  },

  toString: function() {
    return '[MailPeep: ' + this.address + ']';
  },
  toJSON: function() {
    return {
      name: this.name,
      address: this.address,
      contactId: this.contactId
    };
  },
  toWireRep: function() {
    return {
      name: this.name,
      address: this.address
    };
  },

  get hasPicture() {
    return this._thumbnailBlob !== null;
  },
  /**
   * Display the contact's thumbnail on the given image node, abstracting away
   * the issue of Blob URL life-cycle management.
   */
  displayPictureInImageTag: function(imgNode) {
    if (this._thumbnailBlob) {
      showBlobInImg(imgNode, this._thumbnailBlob);
    }
  },
});
