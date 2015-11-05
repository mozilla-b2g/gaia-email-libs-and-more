define(function(require) {

var GelamTest = require('./resources/gelamtest');
var AccountHelpers = require('./resources/account_helpers');
var assert = require('./resources/assert');
var quotechew = require('quotechew');
var help;

return new GelamTest('reply text generation', { noApi: true }, function*() {
  var messagesAndReplies = [
    {
      name: 'simple message',
      message: `Dearest test case,

This is some gibberish I am writing.  I know you deserve better.
You deserve to be the best test case ever.  And yet I find I cannot
bring myself to write the profound statements you merit.

Trailing gibberish.`,
      reply: `> Dearest test case,
>
> This is some gibberish I am writing.  I know you deserve better.
> You deserve to be the best test case ever.  And yet I find I cannot
> bring myself to write the profound statements you merit.
>
> Trailing gibberish.`
    },
    // --- Top-posting (No cleanup necessary)!
    {
      name: 'top-post nesting base case',
      message: `Foo One

Foo Two`,
      reply: `> Foo One
>
> Foo Two`
    },
    {
      name: 'top-post nesting level 1',
      message: `Bar One

Bar Two

Author wrote:
> Foo One
>
> Foo Two`,
      reply: `> Bar One
>
> Bar Two
>
> Author wrote:
>> Foo One
>>
>> Foo Two`
    },
    {
      name: 'top-post nesting level 2',
      message: `Baz One

Baz Two

Writer-person wrote:
> Bar One
>
> Bar Two
>
> Author wrote:
>> Foo One
>>
>> Foo Two`,
      reply: `> Baz One
>
> Baz Two
>
> Writer-person wrote:
>> Bar One
>>
>> Bar Two
>>
>> Author wrote:
>>> Foo One
>>>
>>> Foo Two`
    },
    // --- Interleaved quoting with whitespace padding.
    {
      name: 'interleaved quoting level 1',
      message: `Bob wrote:
> I am right about A.

No, you are wrong about A.

> I am right about B because:
>
> Dance pants!

You are right about dance pants!`,
      reply: `> Bob wrote:
>> I am right about A.
>
> No, you are wrong about A.
>
>> I am right about B because:
>>
>> Dance pants!
>
> You are right about dance pants!`
    },
    // -- Normalization of jerky whitespace and quoting and stuff.
    {
      name: 'normalize jerky whitespace and quoting',
      message: `

I don't care how much whitespace I use!

Ziggy wrote:

>
>
> I too am a quoting monster.
>
> As in, I am bad at quoting.
>

Ziggy also wrote:
>
> So bad at quoting.
>
>
> People wrote:
>
>>
>> And I'm a top-poster, but you can't tell that.
>>


Moohoohahahahahaha


`,
      // Our failure in this case is that since we didn't detect that
      // "People wrote:" was a lead-in, we had to assume the whitespace between
      // the content above it was significant, rather than whitespace between
      // blocks that could be gobbled and normalized.

      reply: `> I don't care how much whitespace I use!
>
> Ziggy wrote:
>> I too am a quoting monster.
>>
>> As in, I am bad at quoting.
>
> Ziggy also wrote:
>> So bad at quoting.
>>
>>
>> People wrote:
>>> And I'm a top-poster, but you can't tell that.
>>
> Moohoohahahahahaha`
    }
  ];

  // -- create the account, get the inbox
  for (var iMessage = 0; iMessage < messagesAndReplies.length; iMessage++) {
    var messageDef = messagesAndReplies[iMessage];

    this.group(messageDef.name);

    var rep = quotechew.quoteProcessTextBody(messageDef.message);
    console.log('rep:', rep);
    var replyText = quotechew.generateReplyText(rep);

    console.log('=== ACTUAL:\n' + replyText);
    console.log('=== EXPECTED:\n' + messageDef.reply);

    var shorter = Math.min(replyText.length, messageDef.reply.length);
    var line = 0, col = 0;
    for (var i = 0; i < shorter; i++) {
      if (replyText.charCodeAt(i) == 10) {
        line++;
        col = 1;
      } else {
        col++;
      }
      if (replyText.charCodeAt(i) !== messageDef.reply.charCodeAt(i)) {
        console.warn(
          'first difference at offset', i, 'line', line, 'col', col,
          'actual:', replyText.charCodeAt(i),
          JSON.stringify(replyText[i]), 'expected:',
          messageDef.reply.charCodeAt(i), JSON.stringify(messageDef.reply[i]));
        break;
      }
    }

    assert.equal(replyText, messageDef.reply);
  }
});

});
