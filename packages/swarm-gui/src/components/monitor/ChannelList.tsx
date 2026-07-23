import { Hash, Lock, Bot, Megaphone, Swords, ShieldCheck, FileText, Search, ChevronDown } from "lucide-react";
import { useMemo, useState } from "react";
import { useSwarmStore } from "../../stores/swarm-store";
import type { ChatChannel } from "../../lib/types";
import { Button } from "../ui/button";
import { Input } from "../ui/input";

const CHANNEL_TYPE_META: Record<string, { icon: React.ReactNode; color: string; group: string }> = {
  roundtable: { icon: <Hash size={14} className="text-primary" />, color: "text-primary", group: "Active" },
  subgroup: { icon: <Hash size={14} className="text-status-info" />, color: "text-status-info", group: "Active" },
  private: { icon: <Lock size={14} className="text-muted-foreground" />, color: "text-muted-foreground", group: "Active" },
  steering: { icon: <Bot size={14} className="text-status-accent" />, color: "text-status-accent", group: "Review" },
  deliberation: { icon: <Swords size={14} className="text-amber-400" />, color: "text-amber-400", group: "Review" },
  reviewer: { icon: <ShieldCheck size={14} className="text-violet-400" />, color: "text-violet-400", group: "Review" },
  file: { icon: <FileText size={14} className="text-emerald-400" />, color: "text-emerald-400", group: "Coordination" },
};

const GROUP_ORDER = ["Active", "Coordination", "Review"];

function ChannelIcon({ type }: { type: ChatChannel["type"] }) {
  const meta = CHANNEL_TYPE_META[type];
  if (meta) return meta.icon;
  return <Hash size={14} />;
}

export default function ChannelList() {
  const channels = useSwarmStore((s) => s.channels);
  const activeId = useSwarmStore((s) => s.activeChannelId);
  const setActive = useSwarmStore((s) => s.setActiveChannel);
  const [search, setSearch] = useState("");
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());

  const channelList = useMemo(() => {
    const list = Array.from(channels.values());
    if (!search.trim()) return list;
    const q = search.toLowerCase();
    return list.filter((ch) => ch.name.toLowerCase().includes(q) || ch.type.toLowerCase().includes(q));
  }, [channels, search]);

  // Group channels by type category
  const grouped = useMemo(() => {
    const groups = new Map<string, ChatChannel[]>();
    for (const ch of channelList) {
      const group = CHANNEL_TYPE_META[ch.type]?.group ?? "Active";
      if (!groups.has(group)) groups.set(group, []);
      groups.get(group)!.push(ch);
    }
    // Sort channels within each group
    for (const [, chs] of groups) {
      chs.sort((a, b) => {
        const order: Record<string, number> = { roundtable: 0, subgroup: 1, private: 2, steering: 3, deliberation: 4, cloner: 5, file: 6 };
        return (order[a.type] ?? 99) - (order[b.type] ?? 99);
      });
    }
    return groups;
  }, [channelList]);

  const toggleGroup = (group: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(group)) next.delete(group);
      else next.add(group);
      return next;
    });
  };

  const showSearch = channels.size > 8;

  return (
    <div className="w-56 flex flex-col border-r border-border bg-background-card">
      <div className="px-3 py-2 border-b border-border flex items-center justify-between">
        <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Channels</span>
        <span className="text-[10px] text-muted-foreground/60 tabular-nums">{channelList.length}</span>
      </div>

      {/* Search (shown when channels > 8) */}
      {showSearch && (
        <div className="px-2 py-1.5 border-b border-border/50">
          <div className="relative">
            <Search size={12} className="absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground/50" />
            <Input
              type="text"
              placeholder="Filter..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="h-7 pl-7 text-xs"
            />
          </div>
        </div>
      )}

      <div className="flex-1 overflow-y-auto py-1">
        {channelList.length === 0 && (
          <div className="px-3 py-4 text-xs text-muted-foreground/60">
            {search ? "No matching channels." : "No channels yet. Swarm activity will appear here."}
          </div>
        )}

        {/* Grouped channel list */}
        {GROUP_ORDER.map((group) => {
          const chs = grouped.get(group);
          if (!chs || chs.length === 0) return null;
          const collapsed = collapsedGroups.has(group);

          return (
            <div key={group}>
              {/* Group header (only when multiple groups exist) */}
              {grouped.size > 1 && (
                <Button
                  variant="ghost"
                  size="xs"
                  onClick={() => toggleGroup(group)}
                  className="w-full px-3 py-1 flex items-center gap-1 text-[10px] uppercase tracking-wider text-muted-foreground/50 hover:text-muted-foreground"
                >
                  <ChevronDown
                    size={10}
                    className={`transition-transform duration-150 ${collapsed ? "-rotate-90" : ""}`}
                  />
                  {group}
                  <span className="ml-auto">{chs.length}</span>
                </Button>
              )}

              {!collapsed &&
                chs.map((ch) => {
                  const meta = CHANNEL_TYPE_META[ch.type];
                  return (
                    <Button
                      variant="ghost"
                      key={ch.id}
                      onClick={() => setActive(ch.id)}
                      className={`w-full px-3 py-2 flex items-center gap-2 text-left ${
                        activeId === ch.id
                          ? "bg-primary/10 text-foreground/90"
                          : "text-muted-foreground hover:bg-background-elevated"
                      }`}
                    >
                      <ChannelIcon type={ch.type} />
                      <span className="text-sm flex-1 truncate">{ch.name}</span>
                      {ch.unreadCount > 0 && (
                        <span className={`text-xs px-1.5 rounded-full min-w-[18px] text-center ${
                          activeId === ch.id
                            ? "bg-background text-muted-foreground"
                            : "bg-primary text-background"
                        }`}>
                          {ch.unreadCount}
                        </span>
                      )}
                    </Button>
                  );
                })}
            </div>
          );
        })}
      </div>
    </div>
  );
}
