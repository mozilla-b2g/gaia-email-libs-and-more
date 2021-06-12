export function revokeImageSrc() {
  // see showBlobInImg below for the rationale for useWin.
  var useWin = this.ownerDocument.defaultView || window;
  useWin.URL.revokeObjectURL(this.src);
}
export function showBlobInImg(imgNode, blob) {
  // We need to look at the image node because object URLs are scoped per
  // document, and for HTML e-mails, we use an iframe that lives in a different
  // document than us.
  //
  // the "|| window" is for our shimmed testing environment and should not
  // happen in production.
  var useWin = imgNode.ownerDocument.defaultView || window;
  imgNode.src = useWin.URL.createObjectURL(blob);
  // We can revoke the URL after we are 100% sure the image has resolved the URL
  // to get at the underlying blob.  Once autorevoke URLs are supported, we can
  // stop doing this.
  imgNode.addEventListener('load', revokeImageSrc);
}