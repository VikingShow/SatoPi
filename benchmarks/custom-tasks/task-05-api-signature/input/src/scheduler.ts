// Task scheduler — missing priority support

export interface TaskOptions {
  name: string;
  action(): Promise<void>;
  delay?: number;
}

export interface ScheduledTask {
  id: string;
  name: string;
  status: "pending" | "running" | "completed" | "failed";
  scheduledAt: number;
}

let taskCounter = 0;

export function scheduleTask(options: TaskOptions): ScheduledTask {
  const id = `task-${++taskCounter}`;
  const task: ScheduledTask = {
    id,
    name: options.name,
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
