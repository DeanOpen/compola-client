// Member avatars for the Zalo-style group mosaic (a group without its own photo shows up to four members). The list
// snapshot carries only the group's own avatar, so members are read lazily from the official suggestion engine
// (`__zaloChat.mentionCandidates`, the same source as the inspector's member list): cached per group, two at a time,
// newest request first, and only for rows that are actually rendered.

import { useEffect, useState } from 'react';
import { mentionCandidates } from './chat';

export interface MosaicMember {
  name: string;
  avatar: string | null;
}

const cache = new Map<string, MosaicMember[]>();
const listeners = new Map<string, Set<() => void>>();
const queue: string[] = [];
const queued = new Set<string>();
let running = 0;
const maxConcurrent = 2;

const pump = () => {
  while (running < maxConcurrent && queue.length) {
    const id = queue.pop()!;
    queued.delete(id);
    if (cache.has(id)) continue;
    running += 1;
    void mentionCandidates(id, '', [])
      .then((found) => found.filter((m) => !m.isAll).slice(0, 4).map((m) => ({ name: m.name, avatar: m.avatar })))
      .catch(() => [] as MosaicMember[])
      .then((members) => {
        cache.set(id, members);
        listeners.get(id)?.forEach((l) => l());
      })
      .finally(() => {
        running -= 1;
        pump();
      });
  }
};

/** Up to four members of a group (empty while unknown or when the official client has none). */
export const useGroupMosaic = (groupId: string, enabled: boolean): MosaicMember[] => {
  const [members, setMembers] = useState<MosaicMember[]>(() => cache.get(groupId) ?? []);
  useEffect(() => {
    if (!enabled) return;
    const update = () => setMembers(cache.get(groupId) ?? []);
    if (!listeners.has(groupId)) listeners.set(groupId, new Set());
    listeners.get(groupId)!.add(update);
    if (cache.has(groupId)) update();
    else if (!queued.has(groupId)) {
      queued.add(groupId);
      queue.push(groupId);
      pump();
    }
    return () => {
      listeners.get(groupId)?.delete(update);
    };
  }, [groupId, enabled]);
  return members;
};

/** Logout: the next account's groups are other groups. */
export const resetGroupMosaics = () => {
  cache.clear();
  queue.length = 0;
  queued.clear();
};
