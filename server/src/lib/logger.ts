export function ts(): string {
  return new Date().toISOString();
}

export function info(...args: unknown[]) {
  console.info('[info]', ts(), ...args);
}

export function warn(...args: unknown[]) {
  console.warn('[warn]', ts(), ...args);
}

export function error(...args: unknown[]) {
  console.error('[error]', ts(), ...args);
}

export function debug(...args: unknown[]) {
  if (process.env.DEBUG) console.debug('[debug]', ts(), ...args);
}
