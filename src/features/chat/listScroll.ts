// Whether the message list is being scrolled right now (MessageList sets it, MessageRow reads it): rows passing under a
// still pointer while the list moves do not mount their hover bar.

export const listScroll = { active: false };
