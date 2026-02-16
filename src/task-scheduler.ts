import { CronExpressionParser } from 'cron-parser';

import {
  SCHEDULER_POLL_INTERVAL,
  TIMEZONE,
} from './config.js';
import {
  getDueTasks,
  getTaskById,
  logTaskRun,
  storeMessage,
  updateTaskAfterRun,
} from './db.js';
import { GroupQueue } from './group-queue.js';
import { logger } from './logger.js';
import { ScheduledTask } from './types.js';

export interface SchedulerDependencies {
  queue: GroupQueue;
}

/**
 * Run a scheduled task by injecting it as a message into the group's container.
 * If a container is already running, the prompt is piped via IPC.
 * If not, a new container is started via the normal message queue.
 */
function runTask(task: ScheduledTask, deps: SchedulerDependencies): void {
  const startTime = Date.now();

  logger.info(
    { taskId: task.id, chatJid: task.chat_jid },
    'Running scheduled task',
  );

  const taskPrompt = `[SCHEDULED TASK - id: ${task.id}]\n\n${task.prompt}`;

  // Try to pipe into running container, otherwise store as message and start one
  if (!deps.queue.sendMessage(task.chat_jid, taskPrompt)) {
    storeMessage({
      id: `task-${task.id}-${Date.now()}`,
      chat_jid: task.chat_jid,
      sender: 'scheduler',
      sender_name: 'Scheduler',
      content: taskPrompt,
      timestamp: new Date().toISOString(),
      is_from_me: false,
    });
    deps.queue.enqueueMessageCheck(task.chat_jid);
  }

  logTaskRun({
    task_id: task.id,
    run_at: new Date().toISOString(),
    duration_ms: Date.now() - startTime,
    status: 'success',
    result: 'injected',
    error: null,
  });

  // Advance next_run
  let nextRun: string | null = null;
  if (task.schedule_type === 'cron') {
    const interval = CronExpressionParser.parse(task.schedule_value, {
      tz: TIMEZONE,
    });
    nextRun = interval.next().toISOString();
  } else if (task.schedule_type === 'interval') {
    const ms = parseInt(task.schedule_value, 10);
    nextRun = new Date(Date.now() + ms).toISOString();
  }

  updateTaskAfterRun(task.id, nextRun, 'injected');
}

let schedulerRunning = false;

export function startSchedulerLoop(deps: SchedulerDependencies): void {
  if (schedulerRunning) {
    logger.debug('Scheduler loop already running, skipping duplicate start');
    return;
  }
  schedulerRunning = true;
  logger.info('Scheduler loop started');

  const loop = async () => {
    try {
      const dueTasks = getDueTasks();
      if (dueTasks.length > 0) {
        logger.info({ count: dueTasks.length }, 'Found due tasks');
      }

      for (const task of dueTasks) {
        const currentTask = getTaskById(task.id);
        if (!currentTask || currentTask.status !== 'active') {
          continue;
        }
        runTask(currentTask, deps);
      }
    } catch (err) {
      logger.error({ err }, 'Error in scheduler loop');
    }

    setTimeout(loop, SCHEDULER_POLL_INTERVAL);
  };

  loop();
}
