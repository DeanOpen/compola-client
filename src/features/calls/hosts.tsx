// Window-level call overlays (Swift `.callOverlay()`): the incoming-call banner, the group call participant picker and
// the notice alert for calls that could not start / helper popups.

import { useCalls } from '../../engine/calls';
import { CallNoticeAlert, IncomingCallBanner } from './CallViews';
import { GroupCallPickerSheet } from './GroupCallPickerSheet';

export function CallHosts() {
  const incoming = useCalls((s) => s.incoming);
  const picker = useCalls((s) => s.picker);
  return (
    <>
      {incoming && (
        <div className="incoming-call-layer">
          <IncomingCallBanner key={incoming.id} incoming={incoming} />
        </div>
      )}
      {picker && <GroupCallPickerSheet key={picker.id} picker={picker} />}
      <CallNoticeAlert />
    </>
  );
}
