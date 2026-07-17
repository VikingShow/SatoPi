import { Hash, Lock, Bot, Megaphone } from "lucide-react";
import { useSwarmStore } from "../../stores/swarm-store";
import type { ChatChannel } from "../../lib/types";

function ChannelIcon({ type }: { type: ChatChannel["type"] }) {
  switch (type) {
    case "roundtable": return <Hash size={14} className="text-primary" />;
    case "subgroup": return <Hash size={14} className="text-status-info" />;
    case "private": return <Lock size={14} className="text-neutral-500" />;
    case "steering": return <Bot size={14} className="text-status-accent" />;
    default: return <Hash size={14} />;
  }
}

export default function ChannelList() {
  const channels = useSwarmStore((s) => s.channels);
  const activeId = useSwarmStore((s) => s.activeChannelId);
  const setActive = useSwarmStore((s) => s.setActiveChannel);

  const channelList = Array.from(channels.values()).sort((a, b) => {
    const order = { roundtable: 0, subgroup: 1, private: 2, steering: 3 };
    return order[a.type] - order[b.type];
  });

  return (
    <div className="w-56 flex flex-col border-r border-background-border bg-background-card">
      <div className="px-3 py-2 border-b border-background-border">
        <span className="text-xs font-medium text-neutral-400 uppercase tracking-wider">Channels</span>
      </div>
      <div className="flex-1 overflow-y-auto py-1">
        {channelList.length === 0 && (
          <div className="px-3 py-4 text-xs text-neutral-600">No channels yet. Swarm activity will appear here.</div>
        )}
        {channelList.map((ch) => (
          <button
            key={ch.id}
            onClick={() => setActive(ch.id)}
            className={`w-full px-3 py-2 flex items-center gap-2 text-left transition-colors cursor-pointer ${
              activeId === ch.id
                ? "bg-primary/10 text-neutral-100"
                : "text-neutral-400 hover:bg-background-elevated"
            }`}
          >
            <ChannelIcon type={ch.type} />
            <span className="text-sm flex-1 truncate">{ch.name}</span>
            {ch.unreadCount > 0 && (
              <span className="text-xs bg-primary text-background px-1.5 rounded-full min-w-[18px] text-center">
                {ch.unreadCount}
              </span>
            )}
          </button>
        ))}
      </div>
    </div>
  );
}
