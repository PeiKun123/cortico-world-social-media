export const RESOURCE_DEFAULTS = {
  textFirst: true,
  maxDailyVisualCalls: 20,
  maxImageKB: 512,
  maxPublishedMediaMB: 512,
  cacheDays: 7,
  maxCacheMB: 200,
  browserCacheMB: 128,
  historyDays: 90,
  maxRecentSends: 2000,
  maxArchiveMB: 512,
};
export type ResourceConfig = typeof RESOURCE_DEFAULTS;
