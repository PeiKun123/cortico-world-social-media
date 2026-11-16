export const MAX_VIDEO_FRAMES = 12;
export const MAX_GALLERY_IMAGES = 6;
export const MAX_STORYBOARD_CELLS = 9;
export const RESOURCE_DEFAULTS = {
  maxVideoFrames: 9,
  textFirst: true,
  maxDailyVisualCalls: 20,
  unlimitedDailyVisualCalls: false,
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
