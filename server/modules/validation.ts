import { z } from 'zod';

const tmuxName = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-zA-Z0-9_-]+$/, 'Invalid session name');

const authMsg = z.object({ type: z.literal('auth'), token: z.string() });
const inputMsg = z.object({ type: z.literal('input'), data: z.string().max(65536) });
const resizeMsg = z.object({
  type: z.literal('resize'),
  cols: z.number().int().positive().max(500),
  rows: z.number().int().positive().max(500),
});
const tmuxListMsg = z.object({ type: z.literal('tmuxList') });
const tmuxNewMsg = z.object({ type: z.literal('tmuxNew'), name: tmuxName });
const tmuxKillMsg = z.object({ type: z.literal('tmuxKill'), name: tmuxName });
const tmuxAttachMsg = z.object({
  type: z.literal('tmuxAttach'),
  name: tmuxName,
  cols: z.number().int().positive().max(500).optional(),
  rows: z.number().int().positive().max(500).optional(),
});
const tmuxDetachMsg = z.object({ type: z.literal('tmuxDetach') });
const tmuxRenameMsg = z.object({ type: z.literal('tmuxRename'), from: tmuxName, to: tmuxName });
const tmuxScrollMsg = z.object({
  type: z.literal('tmuxScroll'),
  name: tmuxName,
  direction: z.enum(['up', 'down']),
});
const tmuxCommandMsg = z.object({
  type: z.literal('tmuxCommand'),
  name: tmuxName,
  command: z.enum([
    'splitH',
    'splitV',
    'newWindow',
    'nextWindow',
    'prevWindow',
    'nextPane',
    'zoomPane',
    'killPane',
  ]),
});
const tmuxCaptureMsg = z.object({ type: z.literal('tmuxCapture'), name: tmuxName });
const tmuxListWindowsMsg = z.object({ type: z.literal('tmuxListWindows'), name: tmuxName });
const tmuxSelectWindowMsg = z.object({
  type: z.literal('tmuxSelectWindow'),
  name: tmuxName,
  index: z.number().int().min(0),
});
const getUsageMsg = z.object({ type: z.literal('getUsage'), provider: z.enum(['claude']) });

const supervisorStartMsg = z.object({
  type: z.literal('supervisorStart'),
  sessionName: tmuxName,
  goal: z.string().min(1).max(2000),
  mode: z.enum(['auto', 'confirm', 'watch']),
});
const supervisorStopMsg = z.object({
  type: z.literal('supervisorStop'),
  sessionName: tmuxName,
});
const supervisorConfirmMsg = z.object({
  type: z.literal('supervisorConfirm'),
  sessionName: tmuxName,
  actionId: z.string().min(1).max(64),
  approved: z.boolean(),
});

export const clientMessageSchema = z.discriminatedUnion('type', [
  authMsg,
  inputMsg,
  resizeMsg,
  tmuxListMsg,
  tmuxNewMsg,
  tmuxKillMsg,
  tmuxAttachMsg,
  tmuxDetachMsg,
  tmuxRenameMsg,
  tmuxScrollMsg,
  tmuxCommandMsg,
  tmuxCaptureMsg,
  tmuxListWindowsMsg,
  tmuxSelectWindowMsg,
  getUsageMsg,
  supervisorStartMsg,
  supervisorStopMsg,
  supervisorConfirmMsg,
]);

export type ValidatedClientMessage = z.infer<typeof clientMessageSchema>;
