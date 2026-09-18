declare const DEV_VERSION: string | undefined;

export const VERSION = typeof DEV_VERSION === "string" ? DEV_VERSION : "0.0.0-development";
