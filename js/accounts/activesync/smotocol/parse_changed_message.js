import { Tags as em } from 'activesync/codepages/Email';

/**
 * Parse the given WBXML server representation of a changed message into a
 * flag changes representation.
 *
 * @param {WBXML.Element} node
 */
export default function parseChangedMessage(node) {
  let flagChanges = {
    add: null,
    remove: null
  };

  function setFlagState(flag, beSet) {
    if (beSet) {
      if (!flagChanges.add) {
        flagChanges.add = [];
      }
      flagChanges.add.push(flag);
    } else {
      if (!flagChanges.remove) {
        flagChanges.remove = [];
      }
      flagChanges.remove.push(flag);
    }
  }

  for (let child of node.children) {
    let childText = child.children.length ? child.children[0].textContent :
                                            null;

    switch (child.tag) {
      case em.Read:
        setFlagState('\\Seen', childText === '1');
        break;
      case em.Flag:
        for (let grandchild of child.children) {
          if (grandchild.tag === em.Status) {
            setFlagState('\\Flagged',
                         grandchild.children[0].textContent !== '0');
          }
        }
        break;
      default:
        break;
    }
  }

  return { flagChanges };
}
