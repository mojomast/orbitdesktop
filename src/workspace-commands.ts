/** Trusted shell commands. Availability is evaluated again at execution time. */
export interface WorkspaceCommand {
  id: string;
  title: string;
  detail: string;
  group: string;
  keywords?: readonly string[];
  hidden?: boolean;
  disabledReason?: string;
  run: () => void | Promise<void>;
}

export function createWorkspaceCommands(source: () => readonly WorkspaceCommand[], report: (message: string) => void) {
  const list = (query = '') => {
    const normalized = query.toLocaleLowerCase().trim().replace(/\s+/g, ' ');
    const words = normalized.split(' ').filter(Boolean);
    const matches = source().filter(command => !command.hidden && words.every(word =>
      `${command.title} ${command.detail} ${command.group} ${command.keywords?.join(' ') ?? ''}`.toLocaleLowerCase().includes(word)));
    if (!normalized) return matches;
    const rank = (command: WorkspaceCommand) => {
      const title = command.title.toLocaleLowerCase().trim().replace(/\s+/g, ' ');
      return title === normalized ? 0 : title.startsWith(normalized) ? 1 : title.includes(normalized) ? 2 : words.every(word => title.includes(word)) ? 3 : 4;
    };
    // Stable ties retain the shell's grouping order; exact names always outrank
    // incidental description matches as the command catalog grows.
    return matches.sort((left, right) => rank(left) - rank(right));
  };
  const execute = async (id: string) => {
    const command = list().find(item => item.id === id);
    if (!command) return;
    if (command.disabledReason) { report(command.disabledReason); return; }
    try { await command.run(); }
    catch (error) { report(`${command.title} could not open: ${String(error)}`); }
  };
  return { list, execute };
}
export type WorkspaceCommands = ReturnType<typeof createWorkspaceCommands>;
