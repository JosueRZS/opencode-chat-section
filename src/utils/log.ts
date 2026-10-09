/** Prefijo de hora para los logs del canal "OpenCode Chat" (HH:MM:SS, 24h). */
export function stamp(): string {
  return new Date().toISOString().slice(11, 19);
}
