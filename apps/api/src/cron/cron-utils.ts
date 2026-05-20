import { CronExpressionParser } from "cron-parser";

export function computeNextCronTick(
  cronSchedule: string,
  timezone: string | null | undefined,
  now: Date,
): Date {
  const interval = CronExpressionParser.parse(cronSchedule, {
    currentDate: now,
    tz: timezone || undefined,
  });

  return interval.next().toDate();
}
