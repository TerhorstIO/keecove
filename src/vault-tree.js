import { activeGroups } from './kdbx.js';
import { icon } from './icons.js';

const treeState = new WeakMap();
const chevron = '<svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 6 6 6-6 6"/></svg>';

function groupName(group) {
  return group.name || 'Ohne Namen';
}

export function renderVaultTree(container, db, selectedId, session) {
  let state = treeState.get(session);
  if (!state) {
    state = { selectedId: null, expanded: new Map() };
    treeState.set(session, state);
  }

  const groups = new Map(Array.from(activeGroups(db), (group) => [group.uuid.id, group]));
  const selectedGroup = groups.get(selectedId);
  const path = [];
  for (let group = selectedGroup; group; group = group.parentGroup) path.push(group);
  path.reverse();
  if (state.selectedId !== selectedId) {
    for (const ancestor of path.slice(0, -1)) state.expanded.set(ancestor.uuid.id, true);
    state.selectedId = selectedId;
  }
  for (const id of state.expanded.keys()) {
    if (!groups.has(id)) state.expanded.delete(id);
  }

  function branch(children, depth) {
    const list = document.createElement('ul');
    list.className = 'group-branch';
    list.setAttribute('role', 'list');
    for (const group of children) {
      const id = group.uuid.id;
      if (!groups.has(id)) continue;

      const item = document.createElement('li');
      const row = document.createElement('div');
      row.className = 'group-row';
      const label = document.createElement('span');
      label.textContent = groupName(group);
      const select = document.createElement('button');
      select.type = 'button';
      select.className = 'group-select';
      select.dataset.action = 'filter';
      select.dataset.id = id;
      select.setAttribute('aria-pressed', String(id === selectedId));
      select.title = label.textContent;
      select.innerHTML = icon('folder', 17);
      select.append(label);
      const visibleChildren = group.groups.filter((child) => groups.has(child.uuid.id));
      if (visibleChildren.length) {
        const subtree = branch(visibleChildren, depth + 1);
        subtree.id = `group-children-${id}`;
        const toggle = document.createElement('button');
        toggle.type = 'button';
        toggle.className = 'group-toggle';
        toggle.innerHTML = chevron;
        toggle.setAttribute('aria-label', `Untergruppen von ${label.textContent}`);
        toggle.setAttribute('aria-controls', subtree.id);
        const setExpanded = (expanded) => {
          toggle.setAttribute('aria-expanded', String(expanded));
          subtree.hidden = !expanded;
        };
        setExpanded(state.expanded.get(id) ?? depth === 0);
        toggle.addEventListener('click', () => {
          state.expanded.set(id, subtree.hidden);
          setExpanded(subtree.hidden);
        });
        row.append(toggle, select);
        item.append(row, subtree);
      } else {
        const spacer = document.createElement('span');
        spacer.className = 'group-toggle-spacer';
        spacer.setAttribute('aria-hidden', 'true');
        row.append(spacer, select);
        item.append(row);
      }
      list.append(item);
    }
    return list;
  }

  container.replaceChildren(branch(db.groups, 0));
  return path.map(groupName);
}
