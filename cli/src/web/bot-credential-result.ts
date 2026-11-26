import type { BotCredentialUse, BotCredentialUseFailure, BotCredentialUseResult } from 'steamharness';
import { credentialUseSupported, parseBotCredentialUse, parseBotCredentialUseResult } from './bot-credential-host';
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

const failureMessages: Record<NonNullable<BotCredentialUseFailure['reason']>, string> = {
  'blocked-policy': 'The current permission policy does not allow this credential operation.',
  'storage-unavailable': 'Studio could not access the protected credential store.',
  'invalid-operation': 'The credential operation or its arguments are invalid.',
  'invalid-credential': 'The saved value is not valid for this authentication method.',
  'target-blocked': 'The target is not allowed for credential requests.',
  network: 'Studio could not connect to the target.',
  tls: 'Studio could not verify the HTTPS connection.',
  timeout: 'The credential operation timed out.',
  redirect: 'The target redirected the request. Studio did not forward the credential.',
  'http-error': 'The target returned an unsuccessful HTTP status.',
  'invalid-response': 'The target did not return a supported JSON response.',
  'response-too-large': 'The result is too large. Request a smaller result.',
  'unsafe-response': 'Studio withheld a result that contained credential material.',
  'command-error': 'Studio could not run the approved credential command.',
};

/** The native host receipt has already been validated. Project only the fields intended for display. */
export function credentialResultCard(use: BotCredentialUse, status: unknown, receipt?: BotCredentialUseResult): ResultCard {
  const state: ResultCard['status'] = status === 'ok' ? { label: 'Completed', tone: 'success' }
    : status === 'declined' ? { label: 'Declined', tone: 'warning' } : { label: 'Failed', tone: 'danger' };
  if (use.connector === 'host') {
    const data = receipt?.status === 'ok' && 'data' in receipt ? JSON.stringify(receipt.data) : undefined;
    const failure = receipt && receipt.status !== 'ok' ? receipt : undefined;
    return { title: 'Credential operation result', status: state,
      fields: [...(use.name ? [{ label: 'Credential alias', value: use.name }] : []), { label: 'Operation', value: use.operation },
        ...(failure?.httpStatus === undefined ? [] : [{ label: 'HTTP status', value: failure.httpStatus }])],
      message: data === undefined ? status === 'ok' ? 'No result details in this receipt.' : failure?.reason ? failureMessages[failure.reason] : statusMessage(status)
        : data.length > 1200 ? `${data.slice(0, 1200)}…` : data };
  }
  const fields: NonNullable<ResultCard['fields']> = [
    { label: 'Credential alias', value: use.name },
    ...(use.operation === 'list-records' ? [{ label: 'Domain', value: use.domain }] : []),
    { label: 'Page', value: use.page },
  ];
  const card: ResultCard = {
    title: use.operation === 'list-domains' ? 'Alibaba Cloud DNS domains' : 'Alibaba Cloud DNS records',
    status: state,
    fields,
  };
  if (receipt?.status === 'ok' && 'rows' in receipt) {
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
  try {
    const use = parseBotCredentialUse(input.request.credentialUse);
    return { ...input, resultCard: credentialResultCard(use, input.values.status, parseBotCredentialUseResult(input.values, use)) };
  }
  catch { return input; }
}
