// Task scheduler — with priority support

export enum TaskPriority {
  LOW = "low",
  MEDIUM = "medium",
  HIGH = "high",
  CRITICAL = "critical",
}

export interface TaskOptions {
  name: string;
  action(): Promise<void>;
  delay?: number;
  priority?: TaskPriority;
}

export interface ScheduledTask {
  id: string;
  name: string;
  priority: TaskPriority;
  status: "pending" | "running" | "completed" | "failed";
  scheduledAt: number;
}

let taskCounter = 0;

export function scheduleTask(options: TaskOptions): ScheduledTask {
  const id = `task-${++taskCounter}`;
  const priority = options.priority ?? TaskPriority.MEDIUM;
  const task: ScheduledTask = {
    id,
    name: options.name,
    priority,
    status: "pending",
    scheduledAt: Date.now() + (options.delay ?? 0),
  };

  setTimeout(() => {
    task.status = "running";
    options.action().then(
      () => {
        task.status = "completed";
      },
      () => {
        task.status = "failed";
      },
    );
  }, options.delay ?? 0);

  return task;
}

export function submitBatchTasks(tasks: TaskOptions[]): ScheduledTask[] {
  return tasks.map((t) => scheduleTask(t));
}
