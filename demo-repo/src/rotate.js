export function detectTabletMode(attached) {
  // Tablet mode is active when the keyboard is detached.
  // An unspecified/undefined attachment state is treated as detached.
  return attached === undefined || attached === false;
}
