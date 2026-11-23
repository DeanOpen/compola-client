// Mock media states for the chat thread: a 3-photo album (one send → mosaic) and a photo / GIF / video whose CDN link is
// dead and that the official loader reports as expired (`resolveMedia` → {state:'unavailable', reason:'gone'}).
import { message } from '../mockData';
import { mockContext, onMockBoot, registerMockAdapter } from '../registry';

const dead = new Set<string>();

registerMockAdapter('__zaloChat', {
  resolveMedia: (_conv: string, msgId: string) => (dead.has(msgId) ? { state: 'unavailable', reason: 'gone' } : { state: 'unavailable' }),
});

onMockBoot(() =>
  setTimeout(() => {
    const convId = 'u-huy';
    const from = { from: convId, name: 'Lê Quang Huy' };
    const deadUrl = 'https://compola.invalid/expired.jpg';
    const photos = [10, 20, 30].map((id, i) =>
      message(convId, { ...from, kind: { type: 'photo', url: `https://picsum.photos/id/${id}/900/600`, width: 900, height: 600 }, text: '[Hình ảnh]', ago: 180_000 - i * 1000 }),
    );
    const gone = [
      message(convId, { ...from, kind: { type: 'photo', url: deadUrl, width: 800, height: 600 }, text: '[Hình ảnh]', ago: 30_000 }),
      message(convId, { ...from, kind: { type: 'gif', url: 'https://compola.invalid/expired.gif' }, text: '[GIF]', ago: 20_000 }),
      message(convId, { ...from, kind: { type: 'video', thumbnail: deadUrl, duration: 42, url: '' }, text: '[Video]', ago: 10_000 }),
    ];
    for (const m of gone) dead.add(String(m.id));
    mockContext().post({ chat: { convId, messages: [...photos, ...gone], removed: [], hasMore: true, reset: false } });
  }, 1500),
);
