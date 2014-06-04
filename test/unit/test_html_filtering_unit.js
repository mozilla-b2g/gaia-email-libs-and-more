define(['rdcommon/testcontext', 'mailapi/htmlchew', 'exports'],
       function($tc, $htmlchew, exports) {

var TD = exports.TD = $tc.defineTestsFor(
  { id: 'test_html_filtering' }, null, [], ['app']);

/**
 * Ensure htmlchew's sanitizeAndNormalizeHtml does its job.
 */
TD.commonSimple('html attribute sanitizing', function(eLazy) {
  // For now, I am only testing img src filtering
  var vectors = [
    "<img src='http://thisisatest.com'></img>",
    "<img src='cid:CONTENT_ID_HERE'/>",
    "<img src='data:image/png;base64,IMAGEDATAHERE'></img>",
    "<img src=\"someothersrc\"></img>",
    "<img src='data:image/svg;base64,IMAGEDATAHERE'>",
    "<img src='data:;base64,IMAGEDATAHERE'>"
  ]; // end vectors

  var expected = [
    "<img ext-src=\"http://thisisatest.com\" class=\"moz-external-image\"/>",
    "<img cid-src=\"CONTENT_ID_HERE\" class=\"moz-embedded-image\"/>",
    "<img src=\"data:image/png;base64,IMAGEDATAHERE\"/>",
    "<img/>",
    "<img/>",
    "<img/>"
  ];
  
  var i;
  for (i = 0; i < expected.length; i++) {
    eLazy.expect_namedValue('vectors[' + i + ']', expected[i]);
  }
  for (i = 0; i < vectors.length; i++) {
    eLazy.namedValue('vectors[' + i + ']',
                     $htmlchew.sanitizeAndNormalizeHtml(vectors[i]));
  }
  
});

}); // end define
