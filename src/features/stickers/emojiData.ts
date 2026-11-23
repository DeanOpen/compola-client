// A compact emoji set for the composer's emoji picker: categories in the usual order, each emoji with search words
// (Vietnamese and English). Unicode emoji only; recent picks are kept per device (localStorage, best effort).

export interface EmojiCategory {
  id: string;
  title: string;
  icon: string;
  items: [emoji: string, words: string][];
}

export const emojiCategories: EmojiCategory[] = [
  {
    id: 'smileys',
    title: 'Mặt cười',
    icon: '😀',
    items: [
      ['😀', 'cười vui smile grin'], ['😃', 'cười vui happy'], ['😄', 'cười vui happy'], ['😁', 'cười nhe răng grin'],
      ['😆', 'cười haha laugh'], ['😅', 'cười toát mồ hôi sweat'], ['🤣', 'cười lăn rofl'], ['😂', 'cười ra nước mắt haha joy'],
      ['🙂', 'mỉm cười slight smile'], ['🙃', 'lộn ngược upside'], ['😉', 'nháy mắt wink'], ['😊', 'ngượng blush'],
      ['😇', 'thiên thần angel'], ['🥰', 'yêu thương love'], ['😍', 'mắt tim yêu love heart eyes'], ['🤩', 'ngưỡng mộ star'],
      ['😘', 'hôn kiss'], ['😗', 'hôn kiss'], ['😚', 'hôn kiss'], ['😋', 'ngon yum'], ['😛', 'lè lưỡi tongue'],
      ['😜', 'lè lưỡi nháy mắt crazy'], ['🤪', 'điên zany'], ['😝', 'lè lưỡi squint'], ['🤑', 'tiền money'],
      ['🤗', 'ôm hug'], ['🤭', 'che miệng giggle'], ['🤫', 'suỵt shh'], ['🤔', 'suy nghĩ think'], ['🤐', 'im lặng zip'],
      ['🤨', 'nghi ngờ raised'], ['😐', 'bình thường neutral'], ['😑', 'vô cảm expressionless'], ['😶', 'không nói no mouth'],
      ['😏', 'nhếch mép smirk'], ['😒', 'chán unamused'], ['🙄', 'đảo mắt eye roll'], ['😬', 'nhăn grimace'],
      ['😌', 'nhẹ nhõm relieved'], ['😔', 'buồn pensive'], ['😪', 'buồn ngủ sleepy'], ['🤤', 'chảy nước miếng drool'],
      ['😴', 'ngủ sleep zzz'], ['😷', 'khẩu trang mask'], ['🤒', 'ốm sick'], ['🤕', 'đau hurt'], ['🤢', 'buồn nôn nauseated'],
      ['🤮', 'nôn vomit'], ['🥵', 'nóng hot'], ['🥶', 'lạnh cold'], ['🥴', 'say woozy'], ['😵', 'chóng mặt dizzy'],
      ['🤯', 'nổ não mind blown'], ['🤠', 'cao bồi cowboy'], ['🥳', 'tiệc party'], ['😎', 'ngầu cool sunglasses'],
      ['🤓', 'mọt sách nerd'], ['🧐', 'soi monocle'], ['😕', 'bối rối confused'], ['😟', 'lo lắng worried'],
      ['🙁', 'buồn frown'], ['😮', 'ngạc nhiên wow surprised'], ['😯', 'ngạc nhiên hushed'], ['😲', 'sửng sốt astonished'],
      ['😳', 'đỏ mặt flushed'], ['🥺', 'năn nỉ pleading'], ['😦', 'hoảng frowning'], ['😧', 'đau khổ anguished'],
      ['😨', 'sợ fearful'], ['😰', 'lo âu anxious'], ['😥', 'thất vọng sad relieved'], ['😢', 'khóc buồn cry'],
      ['😭', 'khóc to sob'], ['😱', 'hét scream'], ['😖', 'rối confounded'], ['😣', 'cố gắng persevere'],
      ['😞', 'thất vọng disappointed'], ['😓', 'mồ hôi downcast'], ['😩', 'mệt weary'], ['😫', 'mệt mỏi tired'],
      ['🥱', 'ngáp yawn'], ['😤', 'tức triumph'], ['😡', 'giận angry'], ['😠', 'giận angry'], ['🤬', 'chửi cursing'],
      ['😈', 'quỷ devil'], ['💀', 'đầu lâu skull'], ['💩', 'poop'], ['🤡', 'hề clown'], ['👻', 'ma ghost'], ['👽', 'người ngoài hành tinh alien'],
      ['🤖', 'robot'], ['😺', 'mèo cười cat'], ['😹', 'mèo cười ra nước mắt cat joy'], ['😻', 'mèo yêu cat love'],
    ],
  },
  {
    id: 'gestures',
    title: 'Cử chỉ',
    icon: '👍',
    items: [
      ['👍', 'like thích ok tốt thumbs up'], ['👎', 'không thích dislike thumbs down'], ['👌', 'ok'], ['✌️', 'chiến thắng victory peace'],
      ['🤞', 'may mắn crossed fingers'], ['🤟', 'yêu love you'], ['🤘', 'rock'], ['🤙', 'gọi call me'], ['👈', 'trái left'],
      ['👉', 'phải right'], ['👆', 'lên up'], ['👇', 'xuống down'], ['☝️', 'một one'], ['✋', 'dừng stop hand'],
      ['🤚', 'tay hand'], ['🖐️', 'tay hand'], ['🖖', 'vulcan'], ['👋', 'chào vẫy tay hello wave'], ['🤝', 'bắt tay handshake deal'],
      ['🙏', 'cảm ơn cầu nguyện thanks pray please'], ['👏', 'vỗ tay clap'], ['🙌', 'giơ tay hooray'], ['👐', 'mở tay open hands'],
      ['🤲', 'chắp tay palms'], ['💪', 'mạnh mẽ cơ bắp strong'], ['✍️', 'viết write'], ['💅', 'sơn móng nail'], ['🤳', 'selfie'],
      ['👀', 'nhìn eyes look'], ['🧠', 'não brain'], ['👶', 'em bé baby'], ['🧒', 'trẻ em child'], ['👦', 'cậu bé boy'],
      ['👧', 'cô bé girl'], ['🧑', 'người person'], ['👨', 'đàn ông man'], ['👩', 'phụ nữ woman'], ['🧓', 'người già older'],
      ['🙋', 'giơ tay raise hand'], ['🙆', 'ok'], ['🙅', 'không no'], ['🤷', 'không biết shrug'], ['🤦', 'facepalm'],
      ['💁', 'thông tin info'], ['🙇', 'cúi chào bow'], ['🏃', 'chạy run'], ['💃', 'nhảy dance'], ['🕺', 'nhảy dance'],
    ],
  },
  {
    id: 'hearts',
    title: 'Trái tim',
    icon: '❤️',
    items: [
      ['❤️', 'tim yêu red heart love'], ['🧡', 'tim cam orange heart'], ['💛', 'tim vàng yellow heart'], ['💚', 'tim xanh lá green heart'],
      ['💙', 'tim xanh dương blue heart'], ['💜', 'tim tím purple heart'], ['🖤', 'tim đen black heart'], ['🤍', 'tim trắng white heart'],
      ['🤎', 'tim nâu brown heart'], ['💔', 'tim vỡ broken heart'], ['❣️', 'tim heart'], ['💕', 'hai tim two hearts'],
      ['💞', 'tim xoay revolving hearts'], ['💓', 'tim đập beating heart'], ['💗', 'tim lớn growing heart'], ['💖', 'tim lấp lánh sparkling heart'],
      ['💘', 'tim mũi tên cupid'], ['💝', 'tim quà gift heart'], ['💟', 'tim heart'], ['💋', 'môi hôn kiss'], ['💌', 'thư tình love letter'],
      ['😻', 'mèo yêu'], ['🫶', 'tay tim heart hands'], ['🌹', 'hoa hồng rose'], ['💐', 'bó hoa bouquet'],
    ],
  },
  {
    id: 'animals',
    title: 'Động vật & thiên nhiên',
    icon: '🐶',
    items: [
      ['🐶', 'chó dog'], ['🐱', 'mèo cat'], ['🐭', 'chuột mouse'], ['🐹', 'hamster'], ['🐰', 'thỏ rabbit'], ['🦊', 'cáo fox'],
      ['🐻', 'gấu bear'], ['🐼', 'gấu trúc panda'], ['🐨', 'koala'], ['🐯', 'hổ tiger'], ['🦁', 'sư tử lion'], ['🐮', 'bò cow'],
      ['🐷', 'heo lợn pig'], ['🐸', 'ếch frog'], ['🐵', 'khỉ monkey'], ['🙈', 'khỉ che mắt see no evil'], ['🙉', 'khỉ'], ['🙊', 'khỉ'],
      ['🐔', 'gà chicken'], ['🐧', 'chim cánh cụt penguin'], ['🐦', 'chim bird'], ['🦆', 'vịt duck'], ['🦉', 'cú owl'], ['🐝', 'ong bee'],
      ['🦋', 'bướm butterfly'], ['🐢', 'rùa turtle'], ['🐍', 'rắn snake'], ['🐙', 'bạch tuộc octopus'], ['🐟', 'cá fish'],
      ['🐬', 'cá heo dolphin'], ['🐳', 'cá voi whale'], ['🌸', 'hoa anh đào blossom'], ['🌻', 'hướng dương sunflower'], ['🌷', 'tulip'],
      ['🌳', 'cây tree'], ['🌴', 'cọ palm'], ['🍀', 'cỏ bốn lá clover lucky'], ['🍁', 'lá phong maple'], ['🌙', 'trăng moon'],
      ['⭐', 'sao star'], ['🌟', 'sao sáng star'], ['☀️', 'mặt trời sun'], ['🌈', 'cầu vồng rainbow'], ['☁️', 'mây cloud'],
      ['🌧️', 'mưa rain'], ['⛈️', 'bão storm'], ['❄️', 'tuyết snow'], ['🔥', 'lửa cháy fire hot'], ['💧', 'giọt nước water'], ['🌊', 'sóng wave'],
    ],
  },
  {
    id: 'food',
    title: 'Đồ ăn & thức uống',
    icon: '🍜',
    items: [
      ['🍏', 'táo xanh apple'], ['🍎', 'táo apple'], ['🍊', 'cam orange'], ['🍋', 'chanh lemon'], ['🍌', 'chuối banana'],
      ['🍉', 'dưa hấu watermelon'], ['🍇', 'nho grape'], ['🍓', 'dâu strawberry'], ['🥭', 'xoài mango'], ['🍍', 'dứa pineapple'],
      ['🥥', 'dừa coconut'], ['🥑', 'bơ avocado'], ['🌶️', 'ớt chili'], ['🌽', 'ngô corn'], ['🍞', 'bánh mì bread'], ['🥖', 'bánh mì baguette'],
      ['🧀', 'phô mai cheese'], ['🍳', 'trứng egg'], ['🍔', 'hamburger'], ['🍟', 'khoai tây chiên fries'], ['🍕', 'pizza'],
      ['🌭', 'xúc xích hot dog'], ['🥪', 'sandwich'], ['🌮', 'taco'], ['🍜', 'phở bún mì noodle'], ['🍲', 'lẩu hot pot'],
      ['🍛', 'cơm cà ri curry'], ['🍣', 'sushi'], ['🍱', 'cơm hộp bento'], ['🥟', 'há cảo dumpling'], ['🍚', 'cơm rice'],
      ['🍤', 'tôm shrimp'], ['🍦', 'kem ice cream'], ['🍰', 'bánh ngọt cake'], ['🎂', 'bánh sinh nhật birthday cake'],
      ['🍫', 'sô cô la chocolate'], ['🍬', 'kẹo candy'], ['🍩', 'donut'], ['🍪', 'bánh quy cookie'], ['☕', 'cà phê coffee'],
      ['🍵', 'trà tea'], ['🧋', 'trà sữa bubble tea'], ['🥤', 'nước ngọt soda'], ['🍺', 'bia beer'], ['🍻', 'cụng ly cheers beers'],
      ['🍷', 'rượu vang wine'], ['🥂', 'chúc mừng cheers'],
    ],
  },
  {
    id: 'activities',
    title: 'Hoạt động',
    icon: '⚽',
    items: [
      ['⚽', 'bóng đá football soccer'], ['🏀', 'bóng rổ basketball'], ['🏈', 'bóng bầu dục'], ['⚾', 'bóng chày baseball'],
      ['🎾', 'tennis'], ['🏐', 'bóng chuyền volleyball'], ['🏸', 'cầu lông badminton'], ['🏓', 'bóng bàn ping pong'],
      ['⛳', 'golf'], ['🏊', 'bơi swim'], ['🚴', 'đạp xe bike'], ['🏆', 'cúp trophy'], ['🥇', 'huy chương vàng gold medal'],
      ['🎉', 'chúc mừng tiệc party tada'], ['🎊', 'confetti'], ['🎈', 'bóng bay balloon'], ['🎁', 'quà gift'], ['🎄', 'giáng sinh christmas'],
      ['🧧', 'lì xì tết red envelope'], ['🎆', 'pháo hoa fireworks'], ['🎮', 'game'], ['🎲', 'xúc xắc dice'], ['🎯', 'mục tiêu target'],
      ['🎤', 'hát karaoke mic'], ['🎧', 'nghe nhạc headphones'], ['🎵', 'nhạc music'], ['🎸', 'guitar'], ['🎬', 'phim movie'],
      ['📸', 'chụp ảnh camera'], ['✈️', 'máy bay du lịch plane travel'], ['🚗', 'ô tô car'], ['🛵', 'xe máy scooter'], ['🏖️', 'biển beach'],
    ],
  },
  {
    id: 'objects',
    title: 'Đồ vật & biểu tượng',
    icon: '💡',
    items: [
      ['💡', 'ý tưởng idea'], ['📱', 'điện thoại phone'], ['💻', 'máy tính laptop'], ['⌨️', 'bàn phím keyboard'], ['🖥️', 'máy tính desktop'],
      ['📷', 'máy ảnh camera'], ['⏰', 'báo thức alarm'], ['⌛', 'đồng hồ cát hourglass'], ['📅', 'lịch calendar'], ['📌', 'ghim pin'],
      ['📎', 'kẹp giấy clip'], ['✏️', 'bút chì pencil'], ['📝', 'ghi chú memo'], ['📚', 'sách books'], ['💼', 'cặp công việc briefcase work'],
      ['💰', 'tiền money bag'], ['💵', 'tiền dollar'], ['💳', 'thẻ card'], ['🔑', 'chìa khóa key'], ['🔒', 'khóa lock'],
      ['🔔', 'chuông bell'], ['📣', 'loa megaphone'], ['📦', 'hộp package'], ['🛒', 'giỏ hàng cart'], ['🏠', 'nhà home'],
      ['🏢', 'văn phòng office'], ['✅', 'xong đúng check done'], ['❌', 'sai sai cross no'], ['⚠️', 'cảnh báo warning'], ['❓', 'hỏi question'],
      ['❗', 'chú ý exclamation'], ['💯', 'trăm điểm hundred'], ['🆗', 'ok'], ['🆕', 'mới new'], ['🔝', 'top'], ['➡️', 'phải arrow'],
      ['⬅️', 'trái arrow'], ['⬆️', 'lên arrow'], ['⬇️', 'xuống arrow'], ['🔴', 'đỏ red'], ['🟢', 'xanh green'], ['🔵', 'xanh blue'],
      ['✨', 'lấp lánh sparkles'], ['💤', 'ngủ zzz'], ['💬', 'tin nhắn chat'], ['🇻🇳', 'việt nam vietnam flag'],
    ],
  },
];

const recentKey = 'compola.emoji.recent';
const recentLimit = 24;

export const recentEmojis = (): string[] => {
  try {
    const v = JSON.parse(localStorage.getItem(recentKey) ?? '[]');
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(0, recentLimit) : [];
  } catch {
    return [];
  }
};

export const rememberEmoji = (emoji: string) => {
  try {
    const next = [emoji, ...recentEmojis().filter((e) => e !== emoji)].slice(0, recentLimit);
    localStorage.setItem(recentKey, JSON.stringify(next));
  } catch {
    /* storage unavailable: recent stays empty */
  }
};

const fold = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').toLowerCase();

/** Emoji matching every typed word as a word prefix (accent-insensitive). */
export const searchEmojis = (query: string): string[] => {
  const words = fold(query).split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const out: string[] = [];
  for (const c of emojiCategories)
    for (const [emoji, w] of c.items) {
      const hay = fold(w).split(/\s+/);
      // Every typed word starts one of the emoji's words ("cam on" → cảm ơn, not vô cảm + expressionless).
      if (words.every((x) => hay.some((h) => h.startsWith(x))) && !out.includes(emoji)) out.push(emoji);
    }
  return out;
};
