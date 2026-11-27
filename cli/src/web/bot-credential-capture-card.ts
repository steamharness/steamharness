import type { BotCredentialCaptureReceipt, BotCredentialSlot } from 'steamharness';
import type { ResultCard } from './workflow-types';

export function credentialCaptureCard(slot: BotCredentialSlot, receipt: BotCredentialCaptureReceipt): ResultCard | undefined {
  const structure = receipt.structure;
  if (!structure || receipt.status === 'declined') return;
  return {
    title: 'Credential saved securely',
    status: { label: receipt.status === 'existing' ? 'Already saved' : 'Saved', tone: 'success' },
    fields: [{ label: 'Credential alias', value: slot.name }],
    message: structure.format === 'object' ? structure.partial ? 'Values and some field names are hidden.' : 'Values are hidden.' : 'Credential content is hidden. No fields to display.',
    ...(structure.format === 'object' && structure.fields.length && { table: {
      columns: ['Field', 'Value type'], rows: structure.fields.map(field => [field.name, field.type]),
    } }),
  };
}
