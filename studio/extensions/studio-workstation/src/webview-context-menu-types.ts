export const webviewMenuActions = [
  'open', 'edit', 'delete', 'newKey', 'newDocument', 'refresh', 'copy', 'copyKey', 'copyId',
  'copyContent', 'copyRecord', 'copyVersion', 'copyHash', 'copyReleaseNotes', 'download',
  'openSource', 'expand', 'collapse', 'signIn', 'signOut', 'editProfile', 'manageSessions', 'retry',
] as const;

export type WebviewMenuAction = typeof webviewMenuActions[number];
