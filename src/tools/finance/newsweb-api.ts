/**
 * Client for the Oslo Børs Newsweb API (api3.oslo.oslobors.no).
 * Provides access to regulatory announcements for XOSL-listed companies.
 *
 * Base URL discovered from the Newsweb SPA bundle at newsweb.oslobors.no.
 * All list endpoints use POST with query parameters; message detail uses GET.
 */

const BASE_URL = 'https://api3.oslo.oslobors.no';

const HEADERS: Record<string, string> = {
  'User-Agent': 'Mozilla/5.0',
  'Accept': '*/*',
  'Origin': 'https://newsweb.oslobors.no',
  'Referer': 'https://newsweb.oslobors.no/',
  'content-type': 'application/json',
};

/** Category IDs used by Newsweb to classify announcements. */
export const NEWSWEB_CATEGORY = {
  /** Annual reports and audit reports */
  ANNUAL_REPORTS: 1001,
  /** Half-yearly and quarterly reports / limited reviews */
  HALF_YEARLY_REPORTS: 1002,
  /** Capital increases */
  CAPITAL_INCREASES: 1004,
  /** Major shareholding notifications (flagging) */
  SHAREHOLDING_NOTIFICATIONS: 1006,
  /** Additional regulated information (AGM, financial calendar, etc.) */
  ADDITIONAL_REGULATED: 1010,
  /** Ex-date announcements */
  EX_DATE: 1101,
  /** Mandatory insider trade notifications */
  INSIDER_TRADES: 1102,
  /** Non-regulatory press releases */
  PRESS_RELEASES: 1104,
} as const;

export type NewswobCategoryId = (typeof NEWSWEB_CATEGORY)[keyof typeof NEWSWEB_CATEGORY];

export interface NewswobCategory {
  id: number;
  category_no: string;
  category_en: string;
}

export interface NewswobAttachmentRef {
  id: number;
  name: string;
}

/** Summary record as returned by the list endpoint. */
export interface NewswobMessage {
  id: number;
  messageId: number;
  newsId: number;
  title: string;
  category: NewswobCategory[];
  markets: string[];
  issuerId: number;
  issuerSign: string;
  issuerName: string;
  publishedTime: string;
  numbAttachments: number;
  clientAnnouncementId: string;
}

/** Full message record including body text and attachment metadata. */
export interface NewswobMessageDetail extends NewswobMessage {
  body: string;
  attachments: NewswobAttachmentRef[];
}

export interface NewswobIssuer {
  issuerId: number;
  id?: string;
  symbol?: string;
  issuerSign?: string;
  name?: string;
  isActive?: number;
}

// --- Caches ---

let issuerCache: Map<string, NewswobIssuer> | null = null;

/**
 * Fetches and caches the full issuer list from Newsweb.
 * Keyed by issuerSign (ticker without exchange suffix), case-insensitive.
 */
async function getIssuerMap(): Promise<Map<string, NewswobIssuer>> {
  if (issuerCache) return issuerCache;

  const res = await fetch(`${BASE_URL}/v1/newsreader/issuers`, {
    method: 'POST',
    headers: HEADERS,
    body: '',
  });

  if (!res.ok) {
    throw new Error(`[Newsweb] Failed to fetch issuers: ${res.status}`);
  }

  const json = (await res.json()) as { data?: { issuers?: NewswobIssuer[] } };
  const issuers: NewswobIssuer[] = json?.data?.issuers ?? [];

  const map = new Map<string, NewswobIssuer>();
  for (const issuer of issuers) {
    const sign = issuer.issuerSign ?? issuer.symbol ?? issuer.id;
    if (sign) {
      map.set(sign.toUpperCase(), issuer);
    }
  }

  issuerCache = map;
  return map;
}

/**
 * Resolves an Oslo Børs ticker (e.g. "VEI.OL" or "VEI") to its numeric issuerId.
 * Returns null when not found.
 */
export async function resolveOsloIssuerId(ticker: string): Promise<number | null> {
  // Strip exchange suffix (.OL, .OSL etc.)
  const sign = ticker.replace(/\.[A-Z]+$/i, '').toUpperCase();
  const map = await getIssuerMap();
  return map.get(sign)?.issuerId ?? null;
}

/**
 * Returns the issuer record for a given ticker, or null if not found.
 */
export async function resolveOsloIssuer(ticker: string): Promise<NewswobIssuer | null> {
  const sign = ticker.replace(/\.[A-Z]+$/i, '').toUpperCase();
  const map = await getIssuerMap();
  return map.get(sign) ?? null;
}

export interface ListFilingsOptions {
  /** Newsweb category ID to filter by. Omit for all categories. */
  category?: number;
  /** ISO date string, e.g. "2024-01-01" */
  fromDate?: string;
  /** ISO date string, e.g. "2025-01-01" */
  toDate?: string;
  /** Free-text filter on message title. */
  messageTitle?: string;
}

/**
 * Lists announcements for a given issuerId, optionally filtered by category.
 * Returns the raw array of message summaries from the API.
 */
export async function listNewswobFilings(
  issuerId: number,
  options: ListFilingsOptions = {}
): Promise<NewswobMessage[]> {
  const params = new URLSearchParams({
    issuer: String(issuerId),
    category: options.category != null ? String(options.category) : '',
    fromDate: options.fromDate ?? '',
    toDate: options.toDate ?? '',
    market: '',
    messageTitle: options.messageTitle ?? '',
  });

  const res = await fetch(`${BASE_URL}/v1/newsreader/list?${params.toString()}`, {
    method: 'POST',
    headers: HEADERS,
    body: '',
  });

  if (!res.ok) {
    throw new Error(`[Newsweb] Failed to list filings for issuerId=${issuerId}: ${res.status}`);
  }

  const json = (await res.json()) as { data?: { messages?: NewswobMessage[]; overflow?: boolean } };
  return json?.data?.messages ?? [];
}

/**
 * Fetches the full message detail (body text + attachments) for a given messageId.
 */
export async function getNewswobMessage(messageId: number): Promise<NewswobMessageDetail> {
  const res = await fetch(`${BASE_URL}/v1/newsreader/message?messageId=${messageId}`, {
    method: 'GET',
    headers: HEADERS,
  });

  if (!res.ok) {
    throw new Error(`[Newsweb] Failed to fetch message ${messageId}: ${res.status}`);
  }

  const json = (await res.json()) as { data?: { message?: NewswobMessageDetail } };
  const message = json?.data?.message;
  if (!message) {
    throw new Error(`[Newsweb] Message ${messageId} not found in response`);
  }
  return message;
}

/**
 * Returns the direct URL for downloading an attachment (PDF or ZIP).
 * The URL requires the same CORS headers when fetched server-side.
 */
export function newswobAttachmentUrl(messageId: number, attachmentId: number): string {
  return `${BASE_URL}/v1/newsreader/attachment?messageId=${messageId}&attachmentId=${attachmentId}`;
}

/**
 * Returns the public Newsweb URL for a given message (link to the web UI).
 */
export function newswobMessageUrl(messageId: number): string {
  return `https://newsweb.oslobors.no/message/${messageId}`;
}
