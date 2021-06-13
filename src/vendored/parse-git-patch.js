/*
 * This is a modified version of the MIT licensed
   https://github.com/dherault/parse-git-patch that has been modified in order
   to deal with the lack of the presence of the expected patch metadata that
   would be provided by the From, Subject, and Date lines.  The original version
   was version 1.0.7.

   The license is included below:

MIT License

Copyright (c) 2020 David Hérault

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
 */

// changed: this regex was missing a "$" and the whitespace between the 'a' and
// 'b' clauses wasn't required.  really this would be better to use the
// dedicated "---" and "+++" lines to supersede this.
const fileNameRegex = /^diff --git "?a\/(.*)"?\s+"?b\/(.*)"?$/
const fileLinesRegex = /^@@ -([0-9]*),?\S* \+([0-9]*),?/
const similarityIndexRegex = /^similarity index /
const addedFileModeRegex = /^new file mode /
const deletedFileModeRegex = /^deleted file mode /

export default function parseGitPatch(patch) {
  if (typeof patch !== 'string') {
    throw new Error('Expected first argument (patch) to be a string')
  }

  const lines = patch.split('\n')

  const parsedPatch = {
    files: [],
  }

  splitIntoParts(lines, 'diff --git').forEach(diff => {
    const fileNameLine = diff.shift()
    const [, a, b] = fileNameLine.match(fileNameRegex)
    const metaLine = diff.shift()

    const fileData = {
      added: false,
      deleted: false,
      beforeName: a.trim(),
      afterName: b.trim(),
      modifiedLines: [],
    }

    parsedPatch.files.push(fileData)

    if (addedFileModeRegex.test(metaLine)) {
      fileData.added = true
    }
    if (deletedFileModeRegex.test(metaLine)) {
      fileData.deleted = true
    }
    if (similarityIndexRegex.test(metaLine)) {
      return
    }

    splitIntoParts(diff, '@@ ').forEach(lines => {
      const fileLinesLine = lines.shift()
      const [, a, b] = fileLinesLine.match(fileLinesRegex)

      let nA = parseInt(a)
      let nB = parseInt(b)

      lines.forEach(line => {
        nA++
        nB++

        if (line.startsWith('-- ')) {
          return
        }
        if (line.startsWith('+')) {
          nA--

          fileData.modifiedLines.push({
            added: true,
            lineNumber: nB,
            line: line.substr(1),
          })
        }
        else if (line.startsWith('-')) {
          nB--

          fileData.modifiedLines.push({
            added: false,
            lineNumber: nA,
            line: line.substr(1),
          })
        }
      })
    })
  })

  return parsedPatch
}

function splitIntoParts(lines, separator) {
  const parts = []
  let currentPart

  lines.forEach(line => {
    if (line.startsWith(separator)) {
      if (currentPart) {
        parts.push(currentPart)
      }

      currentPart = [line]
    }
    else if (currentPart) {
      currentPart.push(line)
    }
  })

  if (currentPart) {
    parts.push(currentPart)
  }

  return parts
}
