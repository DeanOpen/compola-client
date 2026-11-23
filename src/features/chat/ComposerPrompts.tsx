// What composer actions may still ask after their chat is left (Swift `ComposerPrompts`): the official confirm asked
// during a send, the screenshot "Chia sẻ" picker and the screen-recording permission notice.

import { ImageIcon } from 'lucide-react';
import { answerComposerConfirm, reportComposer, shareScreenshot } from '../../engine/composer';
import { setEngine, useEngine } from '../../engine/store';
import { showToast } from '../../engine/toast';
import { Alert } from '../../ui/Overlays';
import { ConversationPickerSheet } from './ConversationPickerSheet';

const maxShareTargets = 100;

export function ComposerPrompts() {
  const confirm = useEngine((s) => s.composerConfirm);
  const share = useEngine((s) => s.screenshotShare);
  const needsPermission = useEngine((s) => s.screenCaptureNeedsPermission);
  return (
    <>
      {confirm && (
        <Alert
          title={confirm.title}
          message={confirm.message}
          buttons={[
            { label: confirm.ok, onClick: () => answerComposerConfirm(confirm, true) },
            { label: confirm.cancel, role: 'cancel', onClick: () => answerComposerConfirm(confirm, false) },
          ]}
        />
      )}
      {share && (
        <ConversationPickerSheet
          title={share.text === null ? 'Chia sẻ ảnh chụp màn hình' : 'Chia sẻ văn bản'}
          maxTargets={maxShareTargets}
          hint={(n) => `Đã chọn ${n}/${maxShareTargets}`}
          onClose={() => setEngine({ screenshotShare: null })}
          preview={
            <>
              <ImageIcon size={18} className="tint" style={{ flex: 'none' }} />
              <div className="clamp-3" style={{ fontSize: 12.5 }}>
                {share.text ?? 'Ảnh chụp màn hình'}
              </div>
            </>
          }
          onSubmit={async (ids) => {
            const outcome = await shareScreenshot(share, ids);
            if (outcome.kind === 'failed') return outcome.text;
            setEngine({ screenshotShare: null });
            if (outcome.kind === 'done') showToast('Đã chia sẻ', share.conversationId);
            else reportComposer(outcome, share.conversationId);
            return null;
          }}
        />
      )}
      {needsPermission && (
        <Alert
          title="Cho phép ghi màn hình"
          message="Để sử dụng tính năng chụp màn hình, cần được kích hoạt trong cài đặt của hệ điều hành. Hãy bật Compola trong Quyền riêng tư & Bảo mật ▸ Ghi màn hình, rồi thử lại."
          buttons={[
            {
              label: 'Mở Cài đặt',
              onClick: () => {
                setEngine({ screenCaptureNeedsPermission: false });
                void import('@tauri-apps/plugin-opener')
                  .then(({ openUrl }) => openUrl('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture'))
                  .catch(() => {});
              },
            },
            { label: 'Để sau', role: 'cancel', onClick: () => setEngine({ screenCaptureNeedsPermission: false }) },
          ]}
        />
      )}
    </>
  );
}
