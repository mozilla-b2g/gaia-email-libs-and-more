import WindowedListView from './windowed_list_view';
import RawItem from './raw_item';

/**
 * Windowed list view that contains `RawItem` instances that expose their wire
 * rep verbatim as their `data` field.  Used in cases where we don't (yet) need
 * helper APIs, abstraction firewalls, or any of that stuff.  Great for first
 * steps, experimental hacks, and the like.
 *
 * This is based on a WindowedListView and has no EntireListView variant right
 * now (although we could) because the EntireListView use-cases are well defined
 * and allow us to make desirable simplifying assumptions.  By definition we
 * have no idea about what goes in here.  In most cases, if you want an
 * EntireListView experience, the caller can just issue a very wide seek window.
 */
export default function RawListView(api, handle) {
  WindowedListView.call(this, api, RawItem, handle);
}
RawListView.prototype = Object.create(WindowedListView.prototype);
