// A poll event in the chat (Swift `PollMessageView`): the info line ("Lan đã bình chọn"), and under the newest event of a
// poll its live card (the official list shows the card only on the last message of each poll).

import { BarChart3, ChevronRight, Pin } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { ChatMessage, PollInfo } from '../../engine/models/chat';
import { defaultPollConfig, optionWeight, votersVisible, type PollConfig, type PollDetail } from '../../engine/models/poll';
import { pollCapabilities, refreshPollPin, retryPoll, usePolls, watchPoll } from '../../engine/poll';
import { useEngine } from '../../engine/store';
import { Spinner } from '../../ui/Spinner';
import { PollOptionRow, PollSettingsLine } from './PollParts';
import { openPollSheet } from './pollSheets';
import './dialog.css';
import './poll.css';

export function LivePollCard({ poll, message }: { poll: PollInfo; message: ChatMessage }) {
  const conversationId = poll.conversationId || message.conversationId;
  /** This message is the newest poll event of its poll in the loaded list. */
  const isNewest = useEngine((s) => {
    if (!poll.pollId) return true;
    const list = s.messages[message.conversationId] ?? [];
    for (let i = list.length - 1; i >= 0; i -= 1) {
      const k = list[i].kind;
      if (k.type === 'poll' && k.poll.pollId === poll.pollId) return list[i].id === message.id;
    }
    return true;
  });
  const open = (voters: boolean) => openPollSheet(poll.pollId, conversationId, poll.question, voters);

  return (
    <div className="poll-message">
      {poll.header && (
        <div className="poll-event">
          <BarChart3 size={12} className="tint" style={{ flex: 'none' }} />
          <span className="clamp-2">{poll.header}</span>
          {poll.pollId && (
            <button className="zp-btn-link poll-event-link" onClick={() => open(false)}>
              Xem
            </button>
          )}
        </div>
      )}
      {!poll.pollId ? <PollFallbackCard question={poll.question} /> : isNewest ? <PollDetailCard poll={poll} conversationId={conversationId} open={open} /> : null}
    </div>
  );
}

/** Used when the message carries no poll id (nothing to read): just the question. */
function PollFallbackCard({ question, busy = false }: { question: string; busy?: boolean }) {
  return (
    <div className="poll-live-card card-chrome">
      <div className="poll-fallback">
        <BarChart3 size={16} className="tint" style={{ flex: 'none' }} />
        <span className="poll-title">{question || 'Bình chọn'}</span>
        {busy && <Spinner size={12} className="poll-fallback-spinner" />}
      </div>
    </div>
  );
}

/** The poll card: question, settings, voter count, the first options with bars, and the vote button. */
function PollDetailCard({ poll, conversationId, open }: { poll: PollInfo; conversationId: string; open: (voters: boolean) => void }) {
  const detail = usePolls((s) => s.details[poll.pollId]);
  const failed = usePolls((s) => s.failed.has(poll.pollId));
  const pinned = usePolls((s) => s.pins[poll.pollId]?.pinned === true);
  const [config, setConfig] = useState<PollConfig>(defaultPollConfig);

  useEffect(() => {
    let live = true;
    watchPoll(poll.pollId, conversationId);
    void (async () => {
      const caps = await pollCapabilities(conversationId);
      if (live) setConfig(caps.config);
      if (live) await refreshPollPin(poll.pollId, conversationId);
    })();
    return () => {
      live = false;
    };
  }, [poll.pollId, conversationId]);

  if (!detail) {
    if (failed) {
      return (
        <div className="poll-failed">
          <PollFallbackCard question={poll.question} />
          <button className="zp-btn zp-btn-secondary zp-btn-small" onClick={() => retryPoll(poll.pollId, conversationId)}>
            Thử lại
          </button>
        </div>
      );
    }
    return <PollFallbackCard question={poll.question} busy />;
  }
  return <PollCardContent detail={detail} question={poll.question} pinned={pinned} config={config} open={open} />;
}

const buttonTitle = (d: PollDetail) => {
  if (d.closed || (d.joined && d.hidePreview)) return 'Xem lựa chọn';
  return d.joined ? 'Đổi lựa chọn' : 'Bình chọn';
};

function PollCardContent({
  detail,
  question,
  pinned,
  config,
  open,
}: {
  detail: PollDetail;
  question: string;
  pinned: boolean;
  config: PollConfig;
  open: (voters: boolean) => void;
}) {
  const shown = detail.options.slice(0, config.displayOptions);
  const rest = detail.options.length - shown.length;
  const canSeeVoters = votersVisible(detail);
  return (
    <div className="poll-live-card card-chrome">
      {pinned && (
        <div className="poll-pinned">
          <Pin size={11} /> Đã ghim
        </div>
      )}
      <div className="poll-title clamp-4">{detail.question || question}</div>
      <PollSettingsLine poll={detail} />
      {detail.voterCount > 0 && (
        <button className="poll-voters-link" onClick={() => open(canSeeVoters)}>
          {detail.voterCount} người bình chọn
          {canSeeVoters && <ChevronRight size={11} strokeWidth={2.5} />}
        </button>
      )}
      <div className="poll-options">
        {shown.map((o) => (
          <PollOptionRow key={o.id} option={o} weight={optionWeight(detail, o)} />
        ))}
      </div>
      {rest > 0 && <div className="poll-more">* Còn {rest} lựa chọn khác</div>}
      <button className="zp-btn zp-btn-tonal poll-vote-button" onClick={() => open(false)}>
        {buttonTitle(detail)}
      </button>
    </div>
  );
}
