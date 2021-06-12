# IMAP Handler

UMD module that parses and compiles IMAP commands.

[![Build Status](https://travis-ci.org/whiteout-io/imap-handler.png?branch=master)](https://travis-ci.org/whiteout-io/imap-handler)

## Install

### [npm](https://www.npmjs.org/):

    npm install wo-imap-handler

## Usage

### Parse IMAP commands

To parse a command you need to have the command as one complete string (including all literals) without the ending &lt;CR&gt;&lt;LF&gt;

    imapHandler.parser(imapCommand);

Where

  * **imapCommand** is an IMAP string without the final line break

The function returns an object in the following form:

```
{
    tag: "TAG",
    command: "COMMAND",
    attributes: [
        {type: "SEQUENCE", value: "sequence-set"},
        {type: "ATOM", value: "atom", section:[section_elements], partial: [start, end]},
        {type: "STRING", value: "string"},
        {type: "LITERAL", value: "literal"},
        [list_elements]
    ]
}
```

Where

  * **tag** is a string containing the tag
  * **command** is the first element after tag
  * **attributes** (if present) is an array of next elements

If section or partial values are not specified in the command, the values are also missing from the ATOM element

**NB!** Sequence numbers are identified as ATOM values if the value contains only numbers.
**NB!** NIL atoms are always identified as `null` values, even though in some cases it might be an ATOM with value `"NIL"`

For example

```javascript
var imapHandler = require("imap-handler");

imapHandler.parser("A1 FETCH *:4 (BODY[HEADER.FIELDS ({4}\r\nDate Subject)]<12.45> UID)");
```

Results in the following value:

```json
{
    "tag": "A1",
    "command": "FETCH",
    "attributes": [
        [
            {
                "type": "SEQUENCE",
                "value": "*:4"
            },
            {
                "type": "ATOM",
                "value": "BODY",
                "section": [
                    {
                        "type": "ATOM",
                        "value": "HEADER.FIELDS"
                    },
                    [
                        {
                            "type": "LITERAL",
                            "value": "Date"
                        },
                        {
                            "type": "ATOM",
                            "value": "Subject"
                        }
                    ]
                ],
                "partial": [
                    12,
                    45
                ]
            },
            {
                "type": "ATOM",
                "value": "UID"
            }
        ]
    ]
}
```

### Compile command objects into IMAP commands

You can "compile" parsed or self generated IMAP command obejcts to IMAP command strings with

    imapHandler.compiler(commandObject, asArray);

Where

  * **commandObject** is an object parsed with `imapHandler.parser()` or self generated
  * **asArray** if set to `true` return the value as an array instead of a string where the command is split on LITERAL notions
  * **isLogging** if set to true, do not include literals and long strings, useful when logging stuff and do not want to include message bodies etc. Additionally nodes with `sensitive: true` options are also not displayed (useful with logging passwords) if `logging` is used.

The function returns a string or if `asArray` is set to true, as an array which is split on LITERAL notions, eg. "{4}\r\nabcde" becomes ["{4}\r\n", "abcde"]. This is useful if you need to wait for "+" response from the server before you can transmit the literal data.

The input object differs from the parsed object with the following aspects:

  * **string**, **number** and **null** (null values are all non-number and non-string falsy values) are allowed to use directly - `{type: "STRING", value: "hello"}` can be replaced with `"hello"`
  * Additional types are used: `SECTION` which is an alias for `ATOM` and `TEXT` which returns the input string as given with no modification (useful for server messages).

For example

```javascript
var command = {
    tag: "*",
    command: "OK",
    attributes: [
        {
            type: "SECTION",
            section: [
                {type: "ATOM", value: "ALERT"}
            ]
        },
        {type:"TEXT", value: "NB! The server is shutting down"}
    ]
};

imapHandler.compiler(command);
// * OK [ALERT] NB! The server is shutting down
```

## License

```
Copyright (c) 2013 Andris Reinman

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```
