Much of our testing is accomplished using xpcshell.

Why not b2g?  We want to avoid background processes going on in the background
that we have no idea about affecting our timing or results.  In short, there's
a lot that we don't need to happen that could easily happen if we're not super
careful.

Why not node?  We want the realism of gecko's network stack and IndexedDB
implementation.  In fact, there aren't any IndexedDB implementations for node
right now, but they would also probably be nothing like ours.
