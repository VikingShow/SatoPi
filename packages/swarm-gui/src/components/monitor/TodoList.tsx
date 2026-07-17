import { useState } from "react";
import { Circle, Clock, CheckCircle2, ChevronDown, ChevronRight, ListTodo } from "lucide-react";
import { useSwarmStore } from "../../stores/swarm-store";
import type { TodoItem } from "../../lib/types";

function TodoRow({ todo }: { todo: TodoItem }) {
  const icon = (() => {
    switch (todo.status) {
      case "completed":
        return <CheckCircle2 size={14} className="text-status-success flex-shrink-0" />;
      case "in_progress":
        return <Clock size={14} className="text-status-warning flex-shrink-0 animate-pulse" />;
      default:
        return <Circle size={14} className="text-neutral-600 flex-shrink-0" />;
    }
  })();

  const titleColor = todo.status === "completed"
    ? "text-neutral-500 line-through"
    : todo.status === "in_progress"
      ? "text-amber-400"
      : "text-neutral-400";

  return (
    <div className="flex items-start gap-1.5 px-3 py-1.5">
      <div className="mt-0.5">{icon}</div>
      <div className="min-w-0 flex-1">
        <div className={`text-xs ${titleColor} break-words`}>{todo.title}</div>
        {todo.files && todo.files.length > 0 && (
          <div className="mt-0.5 flex flex-wrap gap-1">
            {todo.files.map((f, i) => (
              <span key={i} className="text-[10px] text-neutral-600 bg-background-elevated px-1 py-0.5 rounded truncate max-w-[120px]">
                {f}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export default function TodoList() {
  const todos = useSwarmStore((s) => s.todos);
  const [collapsed, setCollapsed] = useState(false);

  if (todos.length === 0) return null;

  const completed = todos.filter((t) => t.status === "completed").length;
  const inProgress = todos.filter((t) => t.status === "in_progress").length;
  const total = todos.length;
  const progressPct = total > 0 ? Math.round((completed / total) * 100) : 0;

  return (
    <div className="border-b border-background-border">
      <button
        onClick={() => setCollapsed(!collapsed)}
        className="w-full flex items-center justify-between px-3 py-2 hover:bg-background-elevated/50 transition-colors"
      >
        <div className="flex items-center gap-1.5">
          {collapsed
            ? <ChevronRight size={14} className="text-neutral-500" />
            : <ChevronDown size={14} className="text-neutral-500" />}
          <ListTodo size={14} className="text-primary" />
          <span className="text-xs font-medium text-neutral-400 uppercase tracking-wider">Tasks</span>
          <span className="text-xs text-neutral-600">
            {completed}/{total}
          </span>
          {inProgress > 0 && (
            <span className="text-xs text-amber-500">{inProgress} active</span>
          )}
        </div>
        {!collapsed && (
          <div className="flex items-center gap-1.5">
            <div className="w-16 h-1 bg-background-elevated rounded-full overflow-hidden">
              <div
                className="h-full bg-status-success transition-all duration-300"
                style={{ width: `${progressPct}%` }}
              />
            </div>
            <span className="text-[10px] text-neutral-600 font-mono">{progressPct}%</span>
          </div>
        )}
      </button>

      {!collapsed && (
        <div className="max-h-64 overflow-y-auto pb-1">
          {todos.map((todo) => (
            <TodoRow key={todo.id} todo={todo} />
          ))}
        </div>
      )}
    </div>
  );
}
