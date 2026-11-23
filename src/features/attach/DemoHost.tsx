// Mock-only showcase of the wave-3 attachment parts (`?mock=1&demo=wave3-attach`, `&sheet=0` hides the send preview):
// realistic chat content for screenshots and for the ui teammate to compare against while wiring them into the chat.

import { useState } from 'react';
import { usesMock } from '../../engine/backend';
import { showToast } from '../../engine/toast';
import { FileChip, PhotoMosaic, VoiceBubble, type MosaicPhoto } from '../chat-parts';
import { SendPreviewSheet } from './SendPreviewSheet';
import './attach.css';

const demoRequested = usesMock && new URLSearchParams(location.search).get('demo') === 'wave3-attach';

const pic = (id: number, w: number, h: number): MosaicPhoto => ({ url: `https://picsum.photos/id/${id}/${w}/${h}`, width: w, height: h });

const mosaics: { label: string; photos: MosaicPhoto[] }[] = [
  { label: '2 ảnh', photos: [pic(64, 600, 800), pic(65, 600, 800)] },
  { label: '3 ảnh (ngang trước)', photos: [pic(10, 1200, 700), pic(11, 600, 600), pic(12, 600, 600)] },
  { label: '3 ảnh (dọc trước)', photos: [pic(20, 600, 900), pic(21, 600, 600), pic(22, 600, 600)] },
  { label: '7 ảnh', photos: [pic(28, 600, 600), pic(29, 600, 600), pic(30, 600, 600), pic(31, 600, 600), pic(32, 600, 600), pic(33, 600, 600), pic(34, 600, 600)] },
];

const files = [
  { name: 'Hop-dong-thue-van-phong-2026-ban-chinh-thuc.pdf', size: 2_458_112 },
  { name: 'Ke-hoach-ra-mat-Compola.docx', size: 184_320 },
  { name: 'Bao-cao-doanh-thu-Q3.xlsx', size: 96_870 },
  { name: 'Slide-gioi-thieu-san-pham.pptx', size: 6_712_000 },
  { name: 'Anh-cuoi-nam-team.zip', size: 214_958_080 },
  { name: 'ghi-chu.txt', size: 1_204 },
  { name: 'du-lieu-khach-hang', size: 48_211 },
];

const sendPaths = [
  'https://picsum.photos/id/1015/1200/800',
  'https://picsum.photos/id/1016/800/800',
  'https://picsum.photos/id/1018/800/800',
  'https://picsum.photos/id/1019/800/800',
  'https://picsum.photos/id/1020/800/800',
  '/Users/minhanh/Movies/Quay-man-hinh.mov',
  '/Users/minhanh/Downloads/Hop-dong-thue-van-phong-2026-ban-chinh-thuc.pdf',
  '/Users/minhanh/Desktop/Bao-cao-doanh-thu-Q3.xlsx',
];

export function AttachDemoHost() {
  const [sheet, setSheet] = useState(() => new URLSearchParams(location.search).get('sheet') !== '0');
  if (!demoRequested) return null;
  return (
    <div className="attach-demo">
      <div className="attach-demo-col">
        <div className="attach-demo-label">Tin nhắn thoại</div>
        <VoiceBubble url="https://example.com/voice-lan-1.m4a" duration={8} isMine={false} />
        <div className="attach-demo-mine">
          <VoiceBubble url="https://example.com/voice-me-2.m4a" duration={42} isMine />
        </div>
        <div className="attach-demo-label">Tệp</div>
        {files.map((f) => (
          <FileChip key={f.name} name={f.name} size={f.size} url={`https://example.com/${f.name}`} onShare={() => showToast('Chia sẻ')} onReveal={() => {}} />
        ))}
        <div className="attach-demo-mine">
          <FileChip name="Bien-ban-hop-23-11.pdf" size={312_000} url="https://example.com/b.pdf" isMine />
        </div>
      </div>
      <div className="attach-demo-col is-wide">
        {mosaics.map((m) => (
          <div key={m.label}>
            <div className="attach-demo-label">{m.label}</div>
            <PhotoMosaic photos={m.photos} width={300} onOpen={(i) => showToast(`Mở ảnh ${i + 1}`)} />
          </div>
        ))}
        <button className="send-preview-btn is-primary" onClick={() => setSheet(true)}>
          Mở “Gửi ảnh”
        </button>
      </div>
      {sheet && (
        <SendPreviewSheet
          conversationName="Team Sản phẩm Compola"
          paths={sendPaths}
          onCancel={() => setSheet(false)}
          onSend={(paths, caption) => {
            setSheet(false);
            showToast(`Gửi ${paths.length} mục${caption ? ` + “${caption}”` : ''}`);
          }}
        />
      )}
    </div>
  );
}
