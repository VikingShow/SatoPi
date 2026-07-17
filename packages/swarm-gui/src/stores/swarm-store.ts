/**
 * Swarm store — real-time swarm state + SSE event buffer.
 *
 * Maintains the current SwarmState (polled via REST) and a ring buffer
 * of recent ActivityEntry events (pushed via SSE). Also manages the
 * chat channel list derived from activity events.
 */

import { create } from "zustand";
import type { SwarmState, ActivityEntry, ChatChannel, ChatMessage } from "../lib/types";
import { api } from "../lib/api-client";
import { sseClient } from "../lib/sse-client";

const MAX_ACTIVITIES = 500;

interface SwarmStore {
  swarmState: SwarmState | null;
  activities: ActivityEntry[];
  channels: Map<string, ChatChannel>;
  messages: Map<string, ChatMessage[]>;
  activeChannelId: string | null;
  isConnected: boolean;
  error: string | null;

  init: () => Promise<void>;
  setActiveChannel: (id: string) => void;
  addActivity: (entry: ActivityEntry) => void;
  refreshState: () => Promise<void>;
}

function deriveChannel(entry: ActivityEntry): { id: string; channel: ChatChannel; message: ChatMessage } | null {
  const ts = entry.ts;
  switch (entry.type) {
    case "broadcast": {
      const id = "roundtable";
      return {
        id,
        channel: { id, type: "roundtable", name: "Roundtable", participants: [], unreadCount: 0, lastMessage: entry.body, lastMessageTime: ts },
        message: { id: `${ts}-${entry.from}`, channelId: id, from: entry.from ?? "", to: "all", body: entry.body ?? "", timestamp: ts },
      };
    }
    case "subgroup": {
      const id = `subgroup-${entry.to}`;
      return {
        id,
        channel: { id, type: "subgroup", name: `#${entry.to}`, participants: [], unreadCount: 0, lastMessage: entry.body, lastMessageTime: ts },
        message: { id: `${ts}-${entry.from}`, channelId: id, from: entry.from ?? "", to: entry.to ?? "", body: entry.body ?? "", timestamp: ts },
      };
    }
    case "steering": {
      const id = `steering-${entry.from}-${entry.to}`;
      return {
        id,
        channel: { id, type: "steering", name: `${entry.from} -> ${entry.to}`, participants: [entry.from ?? "", entry.to ?? ""], unreadCount: 0, lastMessage: entry.body, lastMessageTime: ts },
        message: { id: `${ts}-${entry.from}`, channelId: id, from: entry.from ?? "", to: entry.to ?? "", body: entry.body ?? "", timestamp: ts },
      };
    }
    default:
      return null;
  }
}

export const useSwarmStore = create<SwarmStore>((set, get) => ({
  swarmState: null,
  activities: [],
  channels: new Map(),
  messages: new Map(),
  activeChannelId: "roundtable",
  isConnected: false,
  error: null,

  init: async () => {
    try {
      const state = await api.getState();
      set({ swarmState: state, error: null });

      sseClient.connect();
      sseClient.on((entry) => {
        get().addActivity(entry);
        set({ isConnected: sseClient.isConnected });
      });
    } catch (err) {
      set({ error: String(err) });
    }
  },

  setActiveChannel: (id) => set({ activeChannelId: id }),

  addActivity: (entry) => {
    set((state) => {
      const activities = [...state.activities, entry].slice(-MAX_ACTIVITIES);
      const channels = new Map(state.channels);
      const messages = new Map(state.messages);

      const derived = deriveChannel(entry);
      if (derived) {
        const existing = channels.get(derived.id);
        if (!existing) {
          channels.set(derived.id, derived.channel);
        } else {
          existing.lastMessage = derived.channel.lastMessage;
          existing.lastMessageTime = derived.channel.lastMessageTime;
          if (state.activeChannelId !== derived.id) existing.unreadCount++;
        }
        const msgList = messages.get(derived.id) ?? [];
        msgList.push(derived.message);
        messages.set(derived.id, msgList);
      }

      return { activities, channels, messages };
    });
  },

  refreshState: async () => {
    try {
      const state = await api.getState();
      set({ swarmState: state, error: null });
    } catch (err) {
      set({ error: String(err) });
    }
  },
}));
