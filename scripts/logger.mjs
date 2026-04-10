export function ts() {
  return new Date().toISOString();
}

export function info(...args) {
  console.info('[info]', ts(), ...args);
}

export function warn(...args) {
  console.warn('[warn]', ts(), ...args);
}

export function error(...args) {
  console.error('[error]', ts(), ...args);
}
