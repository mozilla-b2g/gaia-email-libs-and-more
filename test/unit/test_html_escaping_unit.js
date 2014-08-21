define(['rdcommon/testcontext', 'htmlchew', 'exports'],
       function($tc, $htmlchew, exports) {

var TD = exports.TD = $tc.defineTestsFor(
  { id: 'test_html_escaping_unit' }, null, [], ['app']);

/**
 * Ensure htmlchew's wrapTextIntoSafeHTMLString returns a properly-escaped string.
 */
TD.commonSimple('html escaping', function(eLazy) {
  // vectors from the test-cases in bleach.js test/ dir
  var vectors = [
    "<abbr title='evil\" bad=\"moohaha'></abbr>",
    '<abbr title=evil"lessbad></abbr>',
    '<style>disappear </style>should <b>be</b> present' +'<style> disappear2</style>',
    '<style>color: red;\ncolor: blue;\ncolor: green;</style>foo',
    'an <strong>allowed</strong> tag',
    'another <strong>good</strong> tag',
    'a <em>fixed tag',
    'a <br/><span style="color:red">test</span>',
    '<a href="http://xx.com" rel="alternate">xx.com</a>',
    'a <script>alert(1);</script> test',
    'a <style>body{}</style> test',
    '<em href="fail">no link</em>',
    'an & entity',
    'an < entity',
    'tag < <em>and</em> entity',
    '&amp;',
    '&lt;em&gt;strong&lt;/em&gt;',
    '<table></table>',
    '<p>test</p>',
    '<a name="anchor">x</a>',
    '</3',
    'a test <em>with</em> <b>html</b> tags',
    'a test <em>with</em> <img src="http://example.com/"> <b>html</b> tags',
    '<p><a href="http://example.com/">link text</a></p>',
    '<p><span>multiply <span>nested <span>text</span></span></span></p>',
    '<p><a href="http://example.com/"><img src="http://example.com/"></a></p>',
    '<b style=" color: blue;"></b>',
    '<b style="top:0"></b>',
    '<b style="top: 0; color: blue;"></b>',
    '<span>invalid & </span> < extra http://link.com<em>',
    '<EM CLASS="FOO">BAR</EM>',
    'both <em id="foo" style="color: black">can</em> have <img id="bar" src="foo"/>',
    'before <style>p { color: red; }</style>after',
    '<svg><g>foo</g></svg>',
    '<g:svg><g:g>foo</g></svg>',
    '<prune><bogus><prune><bogus></prune></prune>' +'foo <b>bar</b>',
  ]; // end vectors

  var expected = [
    '<div>&lt;abbr title=&apos;evil&quot; bad=&quot;moohaha&apos;&gt;&lt;&#47;abbr&gt;</div>',
    '<div>&lt;abbr title=evil&quot;lessbad&gt;&lt;&#47;abbr&gt;</div>',
    '<div>&lt;style&gt;disappear &lt;&#47;style&gt;should &lt;b&gt;be&lt;&#47;b&gt; present&lt;style&gt; disappear2&lt;&#47;style&gt;</div>',
    '<div>&lt;style&gt;color: red;<br/>color: blue;<br/>color: green;&lt;&#47;style&gt;foo</div>',
    '<div>an &lt;strong&gt;allowed&lt;&#47;strong&gt; tag</div>',
    '<div>another &lt;strong&gt;good&lt;&#47;strong&gt; tag</div>',
    '<div>a &lt;em&gt;fixed tag</div>',
    '<div>a &lt;br&#47;&gt;&lt;span style=&quot;color:red&quot;&gt;test&lt;&#47;span&gt;</div>',
    '<div>&lt;a href=&quot;http:&#47;&#47;xx.com&quot; rel=&quot;alternate&quot;&gt;xx.com&lt;&#47;a&gt;</div>',
    '<div>a &lt;script&gt;alert(1);&lt;&#47;script&gt; test</div>',
    '<div>a &lt;style&gt;body{}&lt;&#47;style&gt; test</div>',
    '<div>&lt;em href=&quot;fail&quot;&gt;no link&lt;&#47;em&gt;</div>',
    '<div>an &amp; entity</div>',
    '<div>an &lt; entity</div>',
    '<div>tag &lt; &lt;em&gt;and&lt;&#47;em&gt; entity</div>',
    '<div>&amp;amp;</div>',
    '<div>&amp;lt;em&amp;gt;strong&amp;lt;&#47;em&amp;gt;</div>',
    '<div>&lt;table&gt;&lt;&#47;table&gt;</div>',
    '<div>&lt;p&gt;test&lt;&#47;p&gt;</div>',
    '<div>&lt;a name=&quot;anchor&quot;&gt;x&lt;&#47;a&gt;</div>',
    '<div>&lt;&#47;3</div>',
    '<div>a test &lt;em&gt;with&lt;&#47;em&gt; &lt;b&gt;html&lt;&#47;b&gt; tags</div>',
    '<div>a test &lt;em&gt;with&lt;&#47;em&gt; &lt;img src=&quot;http:&#47;&#47;example.com&#47;&quot;&gt; &lt;b&gt;html&lt;&#47;b&gt; tags</div>',
    '<div>&lt;p&gt;&lt;a href=&quot;http:&#47;&#47;example.com&#47;&quot;&gt;link text&lt;&#47;a&gt;&lt;&#47;p&gt;</div>',
    '<div>&lt;p&gt;&lt;span&gt;multiply &lt;span&gt;nested &lt;span&gt;text&lt;&#47;span&gt;&lt;&#47;span&gt;&lt;&#47;span&gt;&lt;&#47;p&gt;</div>',
    '<div>&lt;p&gt;&lt;a href=&quot;http:&#47;&#47;example.com&#47;&quot;&gt;&lt;img src=&quot;http:&#47;&#47;example.com&#47;&quot;&gt;&lt;&#47;a&gt;&lt;&#47;p&gt;</div>',
    '<div>&lt;b style=&quot; color: blue;&quot;&gt;&lt;&#47;b&gt;</div>',
    '<div>&lt;b style=&quot;top:0&quot;&gt;&lt;&#47;b&gt;</div>',
    '<div>&lt;b style=&quot;top: 0; color: blue;&quot;&gt;&lt;&#47;b&gt;</div>',
    '<div>&lt;span&gt;invalid &amp; &lt;&#47;span&gt; &lt; extra http:&#47;&#47;link.com&lt;em&gt;</div>',
    '<div>&lt;EM CLASS=&quot;FOO&quot;&gt;BAR&lt;&#47;EM&gt;</div>',
    '<div>both &lt;em id=&quot;foo&quot; style=&quot;color: black&quot;&gt;can&lt;&#47;em&gt; have &lt;img id=&quot;bar&quot; src=&quot;foo&quot;&#47;&gt;</div>',
    '<div>before &lt;style&gt;p { color: red; }&lt;&#47;style&gt;after</div>',
    '<div>&lt;svg&gt;&lt;g&gt;foo&lt;&#47;g&gt;&lt;&#47;svg&gt;</div>',
    '<div>&lt;g:svg&gt;&lt;g:g&gt;foo&lt;&#47;g&gt;&lt;&#47;svg&gt;</div>',
    '<div>&lt;prune&gt;&lt;bogus&gt;&lt;prune&gt;&lt;bogus&gt;&lt;&#47;prune&gt;&lt;&#47;prune&gt;foo &lt;b&gt;bar&lt;&#47;b&gt;</div>',
  ];
  
  var i;
  for (i = 0; i < expected.length; i++) {
    eLazy.expect_namedValue('vectors[' + i + ']', expected[i]);
  }
  for (i = 0; i < vectors.length; i++) {
    eLazy.namedValue('vectors[' + i + ']',
                     $htmlchew.wrapTextIntoSafeHTMLString(vectors[i]));
  }
  
  // ensure quote characters are escaped within attributes
  eLazy.expect_namedValue('escaped-attrs', '<div class="&quot;&quot;"></div>');
  eLazy.namedValue('escaped-attrs',
                   $htmlchew.wrapTextIntoSafeHTMLString(
                     '', 'div', true, ['class','""']));
});

}); // end define
