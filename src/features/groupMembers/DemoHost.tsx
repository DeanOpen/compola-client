// Mock-only demo of the members section (`?mock=1&open=g-team&demo=members`): the section in a right-hand panel, the way
// the info panel will hold it, so it can be reviewed before the inspector wires it in. Renders nothing otherwise.

import { usesMock } from '../../engine/backend';
import { useEngine } from '../../engine/store';
import { GroupMembersSection } from './GroupMembersSection';

const demo = usesMock && typeof location !== 'undefined' && new URLSearchParams(location.search).get('demo') === 'members';

export function GroupMembersDemoHost() {
  const id = useEngine((s) => s.openConversationId);
  if (!demo || !id?.startsWith('g')) return null;
  return (
    <aside className="gm-demo-panel" aria-label="Thành viên nhóm (demo)">
      <div className="gm-demo-header">Thông tin nhóm</div>
      <div className="gm-demo-body">
        <GroupMembersSection conversationId={id} showTitle />
      </div>
    </aside>
  );
}
