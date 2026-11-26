import type { BotCredentialUse, BotCredentialUseResult } from 'steamharness';
import { credentialUseSupported, parseBotCredentialUse } from './bot-credential-host';
import type { ResolvedInput, ResultCard } from './workflow-types';

function statusMessage(status: unknown): string {
  switch (status) {
    case 'declined': return 'Credential use declined';
    case 'missing': return 'Saved credential not found in this Bot';
    case 'missing-fields': return 'Saved credential does not have the requested fields';
    case 'denied': return 'Credential query denied by provider';
    default: return 'Credential query failed';
  }
}

/** The native host receipt has already been validated. Project only the fields intended for display. */
export function credentialResultCard(use: BotCredentialUse, status: unknown, receipt?: BotCredentialUseResult): ResultCard {
  const fields: NonNullable<ResultCard['fields']> = [
    { label: 'Credential alias', value: use.name },
    ...(use.operation === 'list-records' ? [{ label: 'Domain', value: use.domain }] : []),
    { label: 'Page', value: use.page },
  ];
  const card: ResultCard = {
    title: use.operation === 'list-domains' ? 'Alibaba Cloud DNS domains' : 'Alibaba Cloud DNS records',
    status: status === 'ok' ? { label: 'Completed', tone: 'success' }
      : status === 'declined' ? { label: 'Declined', tone: 'warning' }
      : { label: 'Failed', tone: 'danger' },
    fields,
  };
  if (receipt?.status === 'ok') {
    fields.push({ label: 'Rows on this page', value: receipt.rows.length }, { label: 'Total rows', value: receipt.total });
    card.table = use.operation === 'list-domains'
      ? { columns: ['Domain'], rows: receipt.rows.flatMap(row => 'domain' in row ? [[row.domain]] : []) }
      : { columns: ['Record name', 'Type', 'Record value', 'TTL (seconds)'], rows: receipt.rows.flatMap(row => 'ttl' in row ? [[row.name, row.type, row.value, row.ttl]] : []) };
  } else card.message = status === 'ok' ? 'No result details in this receipt.' : statusMessage(status);
  return card;
}

/** Older history has a status and request but no display receipt. Do not infer rows from model text. */
export function withCredentialResultSummary(input: ResolvedInput): ResolvedInput {
  if (input.resultCard || !input.request?.credentialUse || !credentialUseSupported) return input;
  try { return { ...input, resultCard: credentialResultCard(parseBotCredentialUse(input.request.credentialUse), input.values.status) }; }
  catch { return input; }
}
