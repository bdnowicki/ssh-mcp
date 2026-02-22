import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import type { SSHManager } from './ssh-manager.js';

export function registerTools(
  server: Server,
  sshManager: SSHManager,
  getBaseUrl: () => string
): void {
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'ssh_connect',
        description: 'Connect to an SSH host and establish a named session',
        inputSchema: {
          type: 'object' as const,
          properties: {
            name: { type: 'string', description: 'Unique session name' },
            host: { type: 'string', description: 'SSH host address' },
            port: { type: 'number', description: 'SSH port (default 22)' },
            username: { type: 'string', description: 'SSH username' },
            password: { type: 'string', description: 'Password authentication' },
            privateKey: { type: 'string', description: 'Raw private key string' },
            keyFilePath: { type: 'string', description: 'Path to private key file (supports ~ expansion)' },
            passphrase: { type: 'string', description: 'Passphrase for encrypted key' },
          },
          required: ['name', 'host', 'username'],
        },
      },
      {
        name: 'ssh_exec',
        description: 'Execute a command on an SSH session. If timeout is specified and exceeded, the command transitions to a background task.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            sessionName: { type: 'string', description: 'Name of the SSH session' },
            command: { type: 'string', description: 'Command to execute' },
            timeout: { type: 'number', description: 'Timeout in milliseconds. If exceeded, command becomes a background task.' },
          },
          required: ['sessionName', 'command'],
        },
      },
      {
        name: 'ssh_disconnect',
        description: 'Disconnect an SSH session',
        inputSchema: {
          type: 'object' as const,
          properties: {
            sessionName: { type: 'string', description: 'Name of the SSH session to disconnect' },
          },
          required: ['sessionName'],
        },
      },
      {
        name: 'ssh_list_sessions',
        description: 'List all active SSH sessions',
        inputSchema: {
          type: 'object' as const,
          properties: {},
        },
      },
      {
        name: 'ssh_get_monitoring_url',
        description: 'Get the browser terminal monitoring URL for an SSH session',
        inputSchema: {
          type: 'object' as const,
          properties: {
            sessionName: { type: 'string', description: 'Name of the SSH session' },
          },
          required: ['sessionName'],
        },
      },
      {
        name: 'ssh_cancel_command',
        description: 'Cancel the currently running command or a background task on an SSH session',
        inputSchema: {
          type: 'object' as const,
          properties: {
            sessionName: { type: 'string', description: 'Name of the SSH session' },
            taskId: { type: 'string', description: 'Optional background task ID to cancel' },
          },
          required: ['sessionName'],
        },
      },
      {
        name: 'ssh_poll_task',
        description: 'Poll the status of a background task',
        inputSchema: {
          type: 'object' as const,
          properties: {
            sessionName: { type: 'string', description: 'Name of the SSH session' },
            taskId: { type: 'string', description: 'Background task ID to poll' },
          },
          required: ['sessionName', 'taskId'],
        },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
      switch (name) {
        case 'ssh_connect': {
          const params = args as {
            name: string;
            host: string;
            port?: number;
            username: string;
            password?: string;
            privateKey?: string;
            keyFilePath?: string;
            passphrase?: string;
          };
          const info = await sshManager.connect({
            name: params.name,
            host: params.host,
            port: params.port,
            username: params.username,
            password: params.password,
            privateKey: params.privateKey,
            keyFilePath: params.keyFilePath,
            passphrase: params.passphrase,
          });
          const monitoringUrl = `${getBaseUrl()}/session/${params.name}`;
          return {
            content: [{
              type: 'text',
              text: JSON.stringify({ ...info, monitoringUrl }, null, 2),
            }],
          };
        }

        case 'ssh_exec': {
          const params = args as {
            sessionName: string;
            command: string;
            timeout?: number;
          };
          try {
            const result = await sshManager.exec(params.sessionName, params.command, {
              timeout: params.timeout,
              source: 'mcp',
            });
            return {
              content: [{
                type: 'text',
                text: JSON.stringify(result, null, 2),
              }],
            };
          } catch (execErr) {
            const msg = execErr instanceof Error ? execErr.message : String(execErr);
            if (msg.startsWith('ASYNC_TIMEOUT:')) {
              const taskId = msg.slice('ASYNC_TIMEOUT:'.length);
              return {
                content: [{
                  type: 'text',
                  text: JSON.stringify({
                    status: 'background_task',
                    taskId,
                    message: `Command exceeded timeout and is now running as background task ${taskId}. Use ssh_poll_task to check status.`,
                  }, null, 2),
                }],
              };
            }
            throw execErr;
          }
        }

        case 'ssh_disconnect': {
          const params = args as { sessionName: string };
          sshManager.disconnect(params.sessionName);
          return {
            content: [{
              type: 'text',
              text: JSON.stringify({ status: 'disconnected', sessionName: params.sessionName }, null, 2),
            }],
          };
        }

        case 'ssh_list_sessions': {
          const sessions = sshManager.listSessions();
          return {
            content: [{
              type: 'text',
              text: JSON.stringify(sessions, null, 2),
            }],
          };
        }

        case 'ssh_get_monitoring_url': {
          const params = args as { sessionName: string };
          if (!sshManager.hasSession(params.sessionName)) {
            return {
              content: [{
                type: 'text',
                text: `Session "${params.sessionName}" not found`,
              }],
              isError: true,
            };
          }
          const url = `${getBaseUrl()}/session/${params.sessionName}`;
          const dashboardUrl = `${getBaseUrl()}/`;
          return {
            content: [{
              type: 'text',
              text: JSON.stringify({ sessionName: params.sessionName, url, dashboardUrl }, null, 2),
            }],
          };
        }

        case 'ssh_cancel_command': {
          const params = args as { sessionName: string; taskId?: string };
          const cancelled = sshManager.cancelCommand(params.sessionName, params.taskId);
          return {
            content: [{
              type: 'text',
              text: JSON.stringify({ cancelled, sessionName: params.sessionName, taskId: params.taskId }, null, 2),
            }],
          };
        }

        case 'ssh_poll_task': {
          const params = args as { sessionName: string; taskId: string };
          const task = sshManager.getTask(params.sessionName, params.taskId);
          if (!task) {
            return {
              content: [{
                type: 'text',
                text: `Task "${params.taskId}" not found in session "${params.sessionName}"`,
              }],
              isError: true,
            };
          }
          return {
            content: [{
              type: 'text',
              text: JSON.stringify(task, null, 2),
            }],
          };
        }

        default:
          return {
            content: [{
              type: 'text',
              text: `Unknown tool: ${name}`,
            }],
            isError: true,
          };
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [{
          type: 'text',
          text: message,
        }],
        isError: true,
      };
    }
  });
}
