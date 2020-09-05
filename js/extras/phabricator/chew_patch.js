
/**
 * Helper class that consumes a diff/patch to provide summary information
 * about the patch.
 *
 * ## Phases
 * ### Phase 1: Basic summary
 *
 * - Provide per-directory and per-file delta summaries so the user can
 *   distinguish between:
 *   - Lightly touched directories.
 *   - Modifications that are minimal and mechanical versus changes that are
 *     deep and extensive.
 * - Provide a list of meaningfully impacted directories for folder/label
 *   purposes.
 *
 * ### Phase 2: Basic searchfox meta
 *
 * - Use searchfox's raw analysis exposure to figure out what symbols are
 *   impacted in files.  For example, the nesting mechanism should allow
 *   derivation of the classes/methods being modified in simple cases.
 *
 * ### Phase 3: Basic searchfox-informed interdiff
 *
 * - Be able to express the broad changes between 2 versions of a patch by
 *   diffing the searchfox semantic mapped data and the order of magnitude of
 *   changes.
 *
 * ### Phase 4: Stack awareness
 *
 * - Be able to reference the other revisions in a stack that touch parts of
 *   code.  That is, if reviewing a specific hunk and wondering which previous
 *   revision in the stack introduced the change, be able to know that.
 *   Likewise, be able to know which subsequent revisions impact that.
 *   - The specific use-case here would be for the webext to be able to
 *     provide additional context about the specific hunk being looked at in
 *     the user's active window in a secondary window.  And perhaps to provide
 *     navigation support.
 *
 * ### Phase 5: Searchfox delta computation
 *
 * - Trigger/consume searchfox delta indexing runs that can allow computing a
 *   semantic delta before and after the patch.
 */
export class PatchChewer {

}